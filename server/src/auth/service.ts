import bcrypt from 'bcryptjs';
import type { Connection, Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { passwordProblems, type AuthUser, type UserRole } from '@judging/shared';
import { writeAudit } from '../audit.js';
import { BCRYPT_COST, generateTemporaryPassword } from '../db/seed.js';

/**
 * A bcrypt hash of a random value. Unknown e-mails are checked against it so a
 * failed sign-in takes the same time whether or not the account exists.
 */
const DUMMY_HASH = bcrypt.hashSync(generateTemporaryPassword(32), BCRYPT_COST);

interface UserRow extends RowDataPacket {
  id: number;
  email: string;
  full_name: string;
  password_hash: string;
  role: UserRole;
  status: 'active' | 'disabled';
  must_change_password: number;
  session_epoch: number;
  failed_login_count: number;
  is_locked: number;
  lock_seconds_left: number | null;
}

const USER_COLUMNS = `id, email, full_name, password_hash, role, status, must_change_password, session_epoch,
  failed_login_count,
  (locked_until IS NOT NULL AND locked_until > NOW()) AS is_locked,
  GREATEST(TIMESTAMPDIFF(SECOND, NOW(), locked_until), 0) AS lock_seconds_left`;

export function toAuthUser(
  row: Pick<UserRow, 'id' | 'email' | 'full_name' | 'role' | 'must_change_password'>,
): AuthUser {
  return {
    id: Number(row.id),
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    mustChangePassword: Boolean(row.must_change_password),
  };
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface LoginPolicy {
  lockoutThreshold: number;
  lockoutMinutes: number;
}

export type LoginResult =
  | { ok: true; user: AuthUser; epoch: number }
  | { ok: false; reason: 'invalid' }
  | { ok: false; reason: 'locked'; retryAfterSeconds: number }
  | { ok: false; reason: 'disabled' };

async function inTransaction<T>(
  pool: Pool,
  work: (conn: PoolConnection) => Promise<T>,
): Promise<T> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await work(conn);
    await conn.commit();
    return result;
  } catch (error) {
    await conn.rollback().catch(() => {});
    throw error;
  } finally {
    conn.release();
  }
}

/**
 * Checks e-mail and password. Consecutive failures lock the account for a
 * while; a disabled account is only reported after a correct password, so the
 * response never reveals whether an e-mail is registered.
 */
export function attemptLogin(
  pool: Pool,
  { email, password, ip }: { email: string; password: string; ip?: string },
  policy: LoginPolicy,
): Promise<LoginResult> {
  const address = normaliseEmail(email);
  return inTransaction(pool, async (conn) => {
    const [rows] = await conn.query<UserRow[]>(
      `SELECT ${USER_COLUMNS} FROM users WHERE email = ? FOR UPDATE`,
      [address],
    );
    const user = rows[0];

    if (!user) {
      await bcrypt.compare(password, DUMMY_HASH);
      await writeAudit(conn, {
        actorEmail: address,
        action: 'auth.login_failed',
        entityType: 'user',
        ipAddress: ip,
        details: { reason: 'unknown_email' },
      });
      return { ok: false, reason: 'invalid' };
    }

    if (user.is_locked) {
      await bcrypt.compare(password, DUMMY_HASH);
      await writeAudit(conn, {
        actorId: user.id,
        actorEmail: user.email,
        action: 'auth.login_failed',
        entityType: 'user',
        entityId: user.id,
        ipAddress: ip,
        details: { reason: 'locked' },
      });
      return {
        ok: false,
        reason: 'locked',
        retryAfterSeconds: Number(user.lock_seconds_left ?? 60),
      };
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      const failures = Number(user.failed_login_count) + 1;
      const lockNow = failures >= policy.lockoutThreshold;
      if (lockNow) {
        await conn.query(
          'UPDATE users SET failed_login_count = 0, locked_until = NOW() + INTERVAL ? MINUTE WHERE id = ?',
          [policy.lockoutMinutes, user.id],
        );
      } else {
        await conn.query('UPDATE users SET failed_login_count = ? WHERE id = ?', [
          failures,
          user.id,
        ]);
      }
      await writeAudit(conn, {
        actorId: user.id,
        actorEmail: user.email,
        action: lockNow ? 'auth.account_locked' : 'auth.login_failed',
        entityType: 'user',
        entityId: user.id,
        ipAddress: ip,
        details: lockNow
          ? { reason: 'too_many_failures', minutes: policy.lockoutMinutes }
          : { reason: 'wrong_password', consecutive_failures: failures },
      });
      return lockNow
        ? { ok: false, reason: 'locked', retryAfterSeconds: policy.lockoutMinutes * 60 }
        : { ok: false, reason: 'invalid' };
    }

    if (user.status !== 'active') {
      await writeAudit(conn, {
        actorId: user.id,
        actorEmail: user.email,
        action: 'auth.login_failed',
        entityType: 'user',
        entityId: user.id,
        ipAddress: ip,
        details: { reason: 'disabled' },
      });
      return { ok: false, reason: 'disabled' };
    }

    await conn.query(
      'UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = NOW() WHERE id = ?',
      [user.id],
    );
    await writeAudit(conn, {
      actorId: user.id,
      actorEmail: user.email,
      action: 'auth.login_succeeded',
      entityType: 'user',
      entityId: user.id,
      ipAddress: ip,
      details: { must_change_password: Boolean(user.must_change_password) },
    });
    return { ok: true, user: toAuthUser(user), epoch: Number(user.session_epoch) };
  });
}

/** Loads the user behind a session. Returns null if the session must end. */
export async function loadSessionUser(
  pool: Pool,
  userId: number,
  epoch: number,
): Promise<AuthUser | null> {
  const [rows] = await pool.query<UserRow[]>(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, [
    userId,
  ]);
  const user = rows[0];
  if (!user || user.status !== 'active' || Number(user.session_epoch) !== epoch) return null;
  return toAuthUser(user);
}

export type ChangePasswordResult =
  | { ok: true; epoch: number }
  | { ok: false; reason: 'current_incorrect' }
  | { ok: false; reason: 'weak'; problems: string[] };

/**
 * Changes the signed-in user's password. Clears the "must change" flag and
 * bumps session_epoch, which ends every other session of this user.
 */
export function changePassword(
  pool: Pool,
  {
    userId,
    currentPassword,
    newPassword,
    ip,
  }: { userId: number; currentPassword: string; newPassword: string; ip?: string },
): Promise<ChangePasswordResult> {
  return inTransaction(pool, async (conn) => {
    const [rows] = await conn.query<UserRow[]>(
      `SELECT ${USER_COLUMNS} FROM users WHERE id = ? FOR UPDATE`,
      [userId],
    );
    const user = rows[0];
    if (!user) return { ok: false, reason: 'current_incorrect' };

    if (!(await bcrypt.compare(currentPassword, user.password_hash))) {
      await writeAudit(conn, {
        actorId: user.id,
        actorEmail: user.email,
        action: 'auth.password_change_failed',
        entityType: 'user',
        entityId: user.id,
        ipAddress: ip,
        details: { reason: 'current_incorrect' },
      });
      return { ok: false, reason: 'current_incorrect' };
    }

    const problems = passwordProblems(newPassword, { email: user.email });
    if (
      newPassword === currentPassword ||
      (await bcrypt.compare(newPassword, user.password_hash))
    ) {
      problems.push('must be different from your current password');
    }
    if (problems.length > 0) return { ok: false, reason: 'weak', problems };

    const hash = await bcrypt.hash(newPassword, BCRYPT_COST);
    await conn.query(
      `UPDATE users SET password_hash = ?, must_change_password = FALSE, password_changed_at = NOW(),
         session_epoch = session_epoch + 1, failed_login_count = 0, locked_until = NULL WHERE id = ?`,
      [hash, user.id],
    );
    await writeAudit(conn, {
      actorId: user.id,
      actorEmail: user.email,
      action: 'auth.password_changed',
      entityType: 'user',
      entityId: user.id,
      ipAddress: ip,
      details: { was_temporary: Boolean(user.must_change_password) },
    });
    return { ok: true, epoch: Number(user.session_epoch) + 1 };
  });
}

/**
 * Recovery: replaces an account's password with a new temporary one that must
 * be changed at next sign-in, ends all its sessions and clears any lockout.
 * Used by `npm run auth:reset-password` on the server computer (and by the
 * admin user-management screen in Phase 3).
 */
export async function resetPasswordToTemporary(
  db: Connection | PoolConnection,
  {
    email,
    actor,
    enable = false,
  }: { email: string; actor: { id: number | null; email: string }; enable?: boolean },
): Promise<{ userId: number; temporaryPassword: string; wasDisabled: boolean; role: UserRole }> {
  const address = normaliseEmail(email);
  await db.beginTransaction();
  try {
    const [rows] = await db.query<UserRow[]>(
      `SELECT ${USER_COLUMNS} FROM users WHERE email = ? FOR UPDATE`,
      [address],
    );
    const user = rows[0];
    if (!user) throw new Error(`No account exists for ${address}`);

    const temporaryPassword = generateTemporaryPassword();
    const hash = await bcrypt.hash(temporaryPassword, BCRYPT_COST);
    const wasDisabled = user.status !== 'active';
    await db.query(
      `UPDATE users SET password_hash = ?, must_change_password = TRUE, password_changed_at = NOW(),
         session_epoch = session_epoch + 1, failed_login_count = 0, locked_until = NULL
         ${enable ? ", status = 'active'" : ''}
       WHERE id = ?`,
      [hash, user.id],
    );
    await writeAudit(db, {
      actorId: actor.id,
      actorEmail: actor.email,
      action: 'auth.password_reset',
      entityType: 'user',
      entityId: user.id,
      details: {
        email: user.email,
        method: actor.id ? 'admin' : 'server_cli',
        re_enabled: enable && wasDisabled,
      },
    });
    await db.commit();
    return {
      userId: Number(user.id),
      temporaryPassword,
      wasDisabled: wasDisabled && !enable,
      role: user.role,
    };
  } catch (error) {
    await db.rollback().catch(() => {});
    throw error;
  }
}
