import bcrypt from 'bcryptjs';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { passwordProblems } from '@judging/shared';
import { BCRYPT_COST, generateTemporaryPassword, seedInitialAdmin } from '../../src/db/seed.js';
import { connectTest, dropDatabase, freshTestDatabase, scalar, TEST_DB } from './helpers.js';

let conn: Connection;
const ADMIN = { email: 'youmna54@gmail.com', fullName: 'Administrator' };

beforeAll(async () => {
  await freshTestDatabase();
  conn = await connectTest();
});

beforeEach(async () => {
  await conn.end();
  await freshTestDatabase();
  conn = await connectTest();
});

afterAll(async () => {
  await conn.end();
  await dropDatabase(TEST_DB);
});

async function adminRow() {
  const [rows] = await conn.query<RowDataPacket[]>('SELECT * FROM users WHERE email = ?', [
    ADMIN.email,
  ]);
  return rows[0];
}

describe('initial administrator', () => {
  it('creates youmna54@gmail.com as an active admin who must change the password', async () => {
    const result = await seedInitialAdmin(conn, ADMIN);
    expect(result.created).toBe(true);
    const row = await adminRow();
    expect(row).toMatchObject({
      email: 'youmna54@gmail.com',
      role: 'admin',
      status: 'active',
      must_change_password: 1,
    });
  });

  it('stores only a bcrypt hash of a strong generated password', async () => {
    const result = await seedInitialAdmin(conn, ADMIN);
    if (!result.created || !result.generatedPassword)
      throw new Error('expected a generated password');
    const password = result.generatedPassword;
    expect(passwordProblems(password)).toEqual([]);
    const row = await adminRow();
    expect(row?.password_hash).toMatch(new RegExp(`^\\$2[aby]\\$${BCRYPT_COST}\\$`));
    expect(row?.password_hash).not.toContain(password);
    expect(await bcrypt.compare(password, String(row?.password_hash))).toBe(true);
  });

  it('writes an audit entry without the password', async () => {
    const result = await seedInitialAdmin(conn, ADMIN);
    const [rows] = await conn.query<RowDataPacket[]>(
      "SELECT * FROM audit_log WHERE action = 'user.seeded'",
    );
    expect(rows).toHaveLength(1);
    const details = String(rows[0]?.details);
    expect(JSON.parse(details)).toMatchObject({
      email: ADMIN.email,
      role: 'admin',
      password_source: 'generated',
    });
    if (result.created && result.generatedPassword)
      expect(details).not.toContain(result.generatedPassword);
  });

  it('is safe to run again: the existing account and password are left unchanged', async () => {
    await seedInitialAdmin(conn, ADMIN);
    const before = await adminRow();
    const again = await seedInitialAdmin(conn, { ...ADMIN, email: 'YOUMNA54@Gmail.com' });
    expect(again.created).toBe(false);
    expect((await adminRow())?.password_hash).toBe(before?.password_hash);
    expect(await scalar<number>(conn, 'SELECT COUNT(*) FROM users')).toBe(1);
  });

  it('uses ADMIN_INITIAL_PASSWORD when it is strong enough', async () => {
    const result = await seedInitialAdmin(conn, {
      ...ADMIN,
      initialPassword: 'Ahly-iSchool-2026!',
    });
    expect(result).toMatchObject({ created: true });
    expect('generatedPassword' in result && result.generatedPassword).toBeFalsy();
    expect(
      await bcrypt.compare('Ahly-iSchool-2026!', String((await adminRow())?.password_hash)),
    ).toBe(true);
  });

  it('rejects a weak ADMIN_INITIAL_PASSWORD and creates nothing', async () => {
    await expect(seedInitialAdmin(conn, { ...ADMIN, initialPassword: 'password' })).rejects.toThrow(
      /too weak/,
    );
    expect(await scalar<number>(conn, 'SELECT COUNT(*) FROM users')).toBe(0);
  });
});

describe('generateTemporaryPassword', () => {
  it('always satisfies the password policy and never repeats', () => {
    const samples = Array.from({ length: 300 }, () => generateTemporaryPassword());
    for (const p of samples) expect(passwordProblems(p), p).toEqual([]);
    expect(new Set(samples).size).toBe(samples.length);
  });
});
