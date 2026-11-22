import bcrypt from 'bcryptjs';
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import {
  USER_ERRORS,
  type AccountStatus,
  type AuthUser,
  type CreateUserRequest,
  type ManagedUser,
  type UpdateUserRequest,
  type UserRole,
} from '@judging/shared';
import { writeAudit } from '../audit.js';
import { RuleError } from '../errors.js';
import { resetPasswordToTemporary } from '../auth/service.js';
import { BCRYPT_COST, generateTemporaryPassword } from '../db/seed.js';

/** A rule violation the API turns into a clear 4xx response. */
export class UserError extends RuleError {}

interface UserRow extends RowDataPacket {
  id: number;
  email: string;
  full_name: string;
  role: UserRole;
  status: AccountStatus;
  must_change_password: number;
  is_locked: number;
  last_login_at: Date | null;
  created_at: Date;
  assigned_teams: number;
}

const COLUMNS = `id, email, full_name, role, status, must_change_password, last_login_at, created_at,
  (locked_until IS NOT NULL AND locked_until > NOW()) AS is_locked,
  (SELECT COUNT(*) FROM team_judges tj JOIN teams t ON t.id = tj.team_id AND t.status = 'active'
    WHERE tj.judge_id = users.id) AS assigned_teams`;

function toManaged(row: UserRow): ManagedUser {
  return {
    id: Number(row.id),
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    status: row.status,
    mustChangePassword: Boolean(row.must_change_password),
    isLocked: Boolean(row.is_locked),
    lastLoginAt: row.last_login_at ? new Date(row.last_login_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    assignedTeams: Number(row.assigned_teams ?? 0),
  };
}

export type Actor = Pick<AuthUser, 'id' | 'email'> & { ip?: string };

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

function isDuplicate(error: unknown) {
  return (error as { code?: string })?.code === 'ER_DUP_ENTRY';
}

function isLastAdminTrigger(error: unknown) {
  return /last active administrator/i.test(String((error as { message?: string })?.message ?? ''));
}

const emailTaken = () =>
  new UserError(
    409,
    USER_ERRORS.EMAIL_TAKEN,
    'An account with this e-mail address already exists.',
  );
const lastAdmin = () =>
  new UserError(
    409,
    USER_ERRORS.LAST_ADMIN,
    'This is the last active administrator. Make another account an administrator first.',
  );

async function getUser(
  db: Pool | PoolConnection,
  id: number,
  lock = false,
): Promise<UserRow | undefined> {
  const [rows] = await db.query<UserRow[]>(
    `SELECT ${COLUMNS} FROM users WHERE id = ?${lock ? ' FOR UPDATE' : ''}`,
    [id],
  );
  return rows[0];
}

export interface ListUsersQuery {
  search?: string;
  role?: UserRole;
  status?: AccountStatus;
  page: number;
  pageSize: number;
}

export async function listUsers(pool: Pool, query: ListUsersQuery) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (query.search) {
    const like = `%${query.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push('(full_name LIKE ? OR email LIKE ?)');
    params.push(like, like);
  }
  if (query.role) {
    where.push('role = ?');
    params.push(query.role);
  }
  if (query.status) {
    where.push('status = ?');
    params.push(query.status);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [[count]] = (await pool.query(
    `SELECT COUNT(*) AS n FROM users ${clause}`,
    params,
  )) as unknown as [{ n: number }[]];
  const [rows] = await pool.query<UserRow[]>(
    `SELECT ${COLUMNS} FROM users ${clause}
     ORDER BY status = 'active' DESC, full_name ASC, id ASC
     LIMIT ? OFFSET ?`,
    [...params, query.pageSize, (query.page - 1) * query.pageSize],
  );
  const [[admins]] = (await pool.query(
    "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'",
  )) as unknown as [{ n: number }[]];
  return {
    users: rows.map(toManaged),
    total: Number(count?.n ?? 0),
    page: query.page,
    pageSize: query.pageSize,
    activeAdmins: Number(admins?.n ?? 0),
  };
}

/** Creates an account with a strong temporary password, returned once. */
export function createUser(pool: Pool, actor: Actor, input: CreateUserRequest) {
  return inTransaction(pool, async (conn) => {
    const [existing] = await conn.query<RowDataPacket[]>(
      'SELECT id FROM users WHERE email = ? FOR UPDATE',
      [input.email],
    );
    if (existing.length) throw emailTaken();

    const temporaryPassword = generateTemporaryPassword();
    const hash = await bcrypt.hash(temporaryPassword, BCRYPT_COST);
    let insert: ResultSetHeader;
    try {
      [insert] = await conn.query<ResultSetHeader>(
        `INSERT INTO users (email, full_name, password_hash, role, status, must_change_password, created_by)
         VALUES (?, ?, ?, ?, 'active', TRUE, ?)`,
        [input.email, input.fullName, hash, input.role, actor.id],
      );
    } catch (error) {
      if (isDuplicate(error)) throw emailTaken();
      throw error;
    }
    await writeAudit(conn, {
      actorId: actor.id,
      actorEmail: actor.email,
      action: 'user.created',
      entityType: 'user',
      entityId: insert.insertId,
      ipAddress: actor.ip,
      details: {
        email: input.email,
        full_name: input.fullName,
        role: input.role,
        temporary_password_issued: true,
      },
    });
    const row = await getUser(conn, insert.insertId);
    return { user: toManaged(row as UserRow), temporaryPassword };
  });
}

/**
 * Edits an account. Rules, all checked inside one locked transaction:
 * - e-mail addresses stay unique;
 * - you cannot disable your own account;
 * - the last active administrator cannot be disabled or demoted;
 * - disabling ends the account's sessions immediately.
 */
export async function updateUser(
  pool: Pool,
  actor: Actor,
  id: number,
  input: UpdateUserRequest,
): Promise<ManagedUser> {
  try {
    return await inTransaction(pool, async (conn) => {
      const target = await getUser(conn, id, true);
      if (!target)
        throw new UserError(404, USER_ERRORS.USER_NOT_FOUND, 'This account no longer exists.');

      const next = {
        fullName: input.fullName ?? target.full_name,
        email: input.email ?? target.email,
        role: input.role ?? target.role,
        status: input.status ?? target.status,
      };
      const changed = {
        fullName: next.fullName !== target.full_name,
        email: next.email !== target.email,
        role: next.role !== target.role,
        status: next.status !== target.status,
      };
      if (!Object.values(changed).some(Boolean)) return toManaged(target);

      if (changed.status && next.status === 'disabled' && target.id === actor.id) {
        throw new UserError(
          409,
          USER_ERRORS.CANNOT_DISABLE_SELF,
          'You cannot disable your own account.',
        );
      }

      const wasActiveAdmin = target.role === 'admin' && target.status === 'active';
      const staysActiveAdmin = next.role === 'admin' && next.status === 'active';
      if (wasActiveAdmin && !staysActiveAdmin) {
        // Lock every active admin row so two admins can't remove each other at once.
        const [admins] = await conn.query<RowDataPacket[]>(
          "SELECT id FROM users WHERE role = 'admin' AND status = 'active' FOR UPDATE",
        );
        if (!admins.some((a) => Number(a.id) !== target.id)) throw lastAdmin();
      }

      if (changed.email) {
        const [dupes] = await conn.query<RowDataPacket[]>(
          'SELECT id FROM users WHERE email = ? AND id <> ? FOR UPDATE',
          [next.email, target.id],
        );
        if (dupes.length) throw emailTaken();
      }

      const disabling = changed.status && next.status === 'disabled';
      const reactivating = changed.status && next.status === 'active';
      await conn.query(
        `UPDATE users SET full_name = ?, email = ?, role = ?, status = ?
           ${disabling ? ', session_epoch = session_epoch + 1' : ''}
           ${reactivating ? ', failed_login_count = 0, locked_until = NULL' : ''}
         WHERE id = ?`,
        [next.fullName, next.email, next.role, next.status, target.id],
      );

      const base = {
        actorId: actor.id,
        actorEmail: actor.email,
        entityType: 'user',
        entityId: target.id,
        ipAddress: actor.ip,
      };
      if (changed.fullName || changed.email) {
        const changes: Record<string, { from: string; to: string }> = {};
        if (changed.fullName) changes.full_name = { from: target.full_name, to: next.fullName };
        if (changed.email) changes.email = { from: target.email, to: next.email };
        await writeAudit(conn, { ...base, action: 'user.updated', details: { changes } });
      }
      if (changed.role) {
        await writeAudit(conn, {
          ...base,
          action: 'user.role_changed',
          details: { email: next.email, from: target.role, to: next.role },
        });
      }
      if (changed.status) {
        await writeAudit(conn, {
          ...base,
          action: disabling ? 'user.disabled' : 'user.reactivated',
          details: { email: next.email, sessions_ended: disabling },
        });
      }
      return toManaged((await getUser(conn, target.id)) as UserRow);
    });
  } catch (error) {
    if (
      ['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(
        String((error as { code?: string })?.code),
      )
    ) {
      throw new UserError(
        409,
        USER_ERRORS.USER_CONFLICT,
        'Another administrator changed these accounts. Refresh and try again.',
      );
    }
    if (isDuplicate(error)) throw emailTaken();
    if (isLastAdminTrigger(error)) throw lastAdmin();
    throw error;
  }
}

/** Admin password reset: new temporary password (returned once), sessions ended, change forced. */
export async function resetUserPassword(pool: Pool, actor: Actor, id: number) {
  if (id === actor.id) {
    throw new UserError(
      400,
      USER_ERRORS.USE_CHANGE_PASSWORD,
      'To change your own password, use Change password instead.',
    );
  }
  const target = await getUser(pool, id);
  if (!target)
    throw new UserError(404, USER_ERRORS.USER_NOT_FOUND, 'This account no longer exists.');
  const conn = await pool.getConnection();
  try {
    const { temporaryPassword } = await resetPasswordToTemporary(conn, {
      email: target.email,
      actor: { id: actor.id, email: actor.email },
    });
    const user = toManaged((await getUser(conn, id)) as UserRow);
    return { user, temporaryPassword };
  } finally {
    conn.release();
  }
}
