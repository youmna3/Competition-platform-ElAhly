import { randomInt } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { Connection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { passwordProblems } from '@judging/shared';

export const BCRYPT_COST = 12;

// No look-alike characters (0/O, 1/l/I) so the password is easy to type from a printout.
const LOWER = 'abcdefghijkmnpqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '23456789';
const SYMBOLS = '!@#$%^&*-_=+?';
const ALL = LOWER + UPPER + DIGITS + SYMBOLS;

const pick = (chars: string) => chars.charAt(randomInt(chars.length));

/** A random 20-character password that always satisfies the password policy. */
export function generateTemporaryPassword(length = 20): string {
  const chars = [pick(LOWER), pick(UPPER), pick(DIGITS), pick(SYMBOLS)];
  while (chars.length < length) chars.push(pick(ALL));
  // Fisher–Yates shuffle with a cryptographic RNG.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j] as string, chars[i] as string];
  }
  return chars.join('');
}

export interface SeedAdminInput {
  email: string;
  fullName: string;
  /** From ADMIN_INITIAL_PASSWORD. When missing, a strong one is generated. */
  initialPassword?: string;
}

export type SeedAdminResult =
  | { created: false; userId: number }
  | { created: true; userId: number; generatedPassword?: string };

/**
 * Creates the first administrator if that e-mail doesn't exist yet. Safe to run
 * again: an existing account is never changed (its password stays as it is).
 * The account must change its password at first sign-in.
 */
export async function seedInitialAdmin(
  conn: Connection,
  input: SeedAdminInput,
): Promise<SeedAdminResult> {
  const email = input.email.trim().toLowerCase();
  if (input.initialPassword !== undefined) {
    const problems = passwordProblems(input.initialPassword);
    if (problems.length > 0) {
      throw new Error(`ADMIN_INITIAL_PASSWORD is too weak: it ${problems.join(', ')}.`);
    }
  }

  await conn.beginTransaction();
  try {
    const [existing] = await conn.query<RowDataPacket[]>(
      'SELECT id FROM users WHERE email = ? FOR UPDATE',
      [email],
    );
    if (existing[0]) {
      await conn.commit();
      return { created: false, userId: Number(existing[0].id) };
    }

    const generated = input.initialPassword === undefined ? generateTemporaryPassword() : undefined;
    const password = input.initialPassword ?? (generated as string);
    const hash = await bcrypt.hash(password, BCRYPT_COST);

    const [insert] = await conn.query<ResultSetHeader>(
      `INSERT INTO users (email, full_name, password_hash, role, status, must_change_password)
       VALUES (?, ?, ?, 'admin', 'active', TRUE)`,
      [email, input.fullName.trim(), hash],
    );
    await conn.query(
      `INSERT INTO audit_log (actor_id, actor_email, action, entity_type, entity_id, details)
       VALUES (NULL, 'system', 'user.seeded', 'user', ?, ?)`,
      [
        String(insert.insertId),
        JSON.stringify({
          email,
          role: 'admin',
          password_source: generated ? 'generated' : 'ADMIN_INITIAL_PASSWORD',
          must_change_password: true,
        }),
      ],
    );
    await conn.commit();
    return generated
      ? { created: true, userId: insert.insertId, generatedPassword: generated }
      : { created: true, userId: insert.insertId };
  } catch (error) {
    await conn.rollback();
    throw error;
  }
}
