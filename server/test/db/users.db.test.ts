/**
 * Phase 3 — user management against a real (scratch) MySQL database.
 */
import bcrypt from 'bcryptjs';
import mysql, { type Pool } from 'mysql2/promise';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { passwordProblems } from '@judging/shared';
import {
  connectTest,
  dropDatabase,
  expectRefused,
  freshTestDatabase,
  scalar,
  TEST_DB,
  testTarget,
} from './helpers.js';
import { makeTestApp, signIn } from './appHelpers.js';

const ADMIN = { email: 'youmna54@gmail.com', password: 'Admin-Password-2026!' };
const JUDGE = { email: 'judge@example.com', password: 'Judge-Password-2026!' };

let pool: Pool;
let app: ReturnType<typeof makeTestApp>;
let adminId: number;
let judgeId: number;

async function insertUser(
  email: string,
  fullName: string,
  role: 'admin' | 'judge',
  password: string,
) {
  const [r] = await pool.query(
    'INSERT INTO users (email, full_name, password_hash, role, must_change_password) VALUES (?, ?, ?, ?, FALSE)',
    [email, fullName, bcrypt.hashSync(password, 4), role],
  );
  return (r as { insertId: number }).insertId;
}

beforeAll(async () => {
  await freshTestDatabase();
  pool = mysql.createPool({ ...testTarget, connectionLimit: 8 });
  app = makeTestApp(pool);
});

beforeEach(async () => {
  // TRUNCATE resets the tables without firing the delete triggers that protect
  // real data (last administrator, append-only audit log). Test cleanup only.
  await pool.query('SET FOREIGN_KEY_CHECKS = 0');
  await pool.query('TRUNCATE TABLE sessions');
  await pool.query('TRUNCATE TABLE users');
  await pool.query('TRUNCATE TABLE audit_log');
  await pool.query('SET FOREIGN_KEY_CHECKS = 1');
  adminId = await insertUser(ADMIN.email, 'Youmna Admin', 'admin', ADMIN.password);
  judgeId = await insertUser(JUDGE.email, 'Judge One', 'judge', JUDGE.password);
});

afterAll(async () => {
  await pool.end();
  await dropDatabase(TEST_DB);
});

describe('access to user management', () => {
  it('requires a session', async () => {
    for (const [method, path] of [
      ['get', '/api/admin/users'],
      ['post', '/api/admin/users'],
      ['patch', `/api/admin/users/1`],
      ['post', `/api/admin/users/1/reset-password`],
    ] as const) {
      const res = await request(app)[method](path).send({});
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it('is refused to judges on every endpoint', async () => {
    const judge = await signIn(app, JUDGE.email, JUDGE.password);
    expect((await judge.get('/api/admin/users')).status).toBe(403);
    expect(
      (await judge.post('/api/admin/users').send({ fullName: 'X Y', email: 'x@example.com' }))
        .status,
    ).toBe(403);
    expect((await judge.patch(`/api/admin/users/${judgeId}`).send({ role: 'admin' })).status).toBe(
      403,
    );
    expect((await judge.post(`/api/admin/users/${adminId}/reset-password`)).status).toBe(403);
    // Nothing changed.
    expect(await scalar(pool, 'SELECT role FROM users WHERE id = ?', [judgeId])).toBe('judge');
  });

  it('is refused to an admin who has not yet replaced a temporary password', async () => {
    await pool.query('UPDATE users SET must_change_password = TRUE WHERE id = ?', [adminId]);
    const admin = await signIn(app, ADMIN.email, ADMIN.password);
    expect((await admin.get('/api/admin/users')).body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
  });
});

describe('listing users', () => {
  beforeEach(async () => {
    await insertUser('mona.hassan@example.com', 'Mona Hassan', 'judge', JUDGE.password);
    const disabled = await insertUser(
      'old.judge@example.com',
      'Old Judge',
      'judge',
      JUDGE.password,
    );
    await pool.query("UPDATE users SET status = 'disabled' WHERE id = ?", [disabled]);
    await pool.query('UPDATE users SET last_login_at = NOW() WHERE id = ?', [judgeId]);
  });

  it('shows every account with name, e-mail, role, status and last sign-in, and never password data', async () => {
    const admin = await signIn(app, ADMIN.email, ADMIN.password);
    const res = await admin.get('/api/admin/users');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(4);
    expect(res.body.activeAdmins).toBe(1);
    const judge = res.body.users.find((u: { email: string }) => u.email === JUDGE.email);
    expect(judge).toEqual({
      id: judgeId,
      email: JUDGE.email,
      fullName: 'Judge One',
      role: 'judge',
      status: 'active',
      mustChangePassword: false,
      isLocked: false,
      lastLoginAt: expect.any(String),
      createdAt: expect.any(String),
      assignedTeams: 0,
    });
    expect(JSON.stringify(res.body)).not.toMatch(/password_hash|\$2[aby]\$/);
    // Disabled accounts are listed after active ones.
    expect(res.body.users.at(-1).status).toBe('disabled');
  });

  it('searches by name or e-mail and filters by role and status', async () => {
    const admin = await signIn(app, ADMIN.email, ADMIN.password);
    const emails = async (q: string) =>
      (await admin.get(`/api/admin/users?${q}`)).body.users
        .map((u: { email: string }) => u.email)
        .sort();
    expect(await emails('search=mona')).toEqual(['mona.hassan@example.com']);
    expect(await emails('search=EXAMPLE.COM')).toHaveLength(3);
    expect(await emails('role=admin')).toEqual([ADMIN.email]);
    expect(await emails('status=disabled')).toEqual(['old.judge@example.com']);
    expect(await emails('role=judge&status=active')).toEqual([
      JUDGE.email,
      'mona.hassan@example.com',
    ]);
    expect(await emails('search=%25')).toEqual([]); // "%" is matched literally, not as a wildcard
  });

  it('pages through results', async () => {
    const admin = await signIn(app, ADMIN.email, ADMIN.password);
    const first = await admin.get('/api/admin/users?pageSize=2&page=1');
    const second = await admin.get('/api/admin/users?pageSize=2&page=2');
    expect(first.body.users).toHaveLength(2);
    expect(second.body.users).toHaveLength(2);
    expect(first.body.total).toBe(4);
  });

  it('rejects invalid filters', async () => {
    const admin = await signIn(app, ADMIN.email, ADMIN.password);
    expect((await admin.get('/api/admin/users?role=superuser')).status).toBe(400);
    expect((await admin.get('/api/admin/users?pageSize=1000')).status).toBe(400);
    expect((await admin.get('/api/admin/users?sort=password_hash')).status).toBe(400);
  });
});

describe('creating accounts', () => {
  it('creates a judge with a strong temporary password shown once', async () => {
    const admin = await signIn(app, ADMIN.email, ADMIN.password);
    const res = await admin
      .post('/api/admin/users')
      .send({ fullName: '  Mona Hassan ', email: ' Mona.Hassan@Example.com ' });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({
      fullName: 'Mona Hassan',
      email: 'mona.hassan@example.com',
      role: 'judge',
      status: 'active',
      mustChangePassword: true,
    });
    const temp = res.body.temporaryPassword as string;
    expect(passwordProblems(temp)).toEqual([]);

    // Stored only as a bcrypt hash; never returned again.
    const hash = await scalar<string>(pool, 'SELECT password_hash FROM users WHERE email = ?', [
      'mona.hassan@example.com',
    ]);
    expect(hash).not.toContain(temp);
    expect(await bcrypt.compare(temp, hash)).toBe(true);
    const list = await admin.get('/api/admin/users?search=mona');
    expect(JSON.stringify(list.body)).not.toContain(temp);

    // The judge can sign in with it and must change it first.
    const judge = request.agent(app);
    const login = await judge
      .post('/api/auth/login')
      .send({ email: 'mona.hassan@example.com', password: temp });
    expect(login.body.user.mustChangePassword).toBe(true);
    expect((await judge.get('/api/judge/assignments')).body.error.code).toBe(
      'PASSWORD_CHANGE_REQUIRED',
    );
  });

  it('can create an administrator', async () => {
    const admin = await signIn(app, ADMIN.email, ADMIN.password);
    const res = await admin
      .post('/api/admin/users')
      .send({ fullName: 'Second Admin', email: 'admin2@example.com', role: 'admin' });
    expect(res.body.user.role).toBe('admin');
  });

  it('refuses duplicate e-mails in any letter case', async () => {
    const admin = await signIn(app, ADMIN.email, ADMIN.password);
    const res = await admin
      .post('/api/admin/users')
      .send({ fullName: 'Copy', email: 'JUDGE@example.com' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
    expect(await scalar<number>(pool, 'SELECT COUNT(*) FROM users')).toBe(2);
  });

  it('validates every field on the server', async () => {
    const admin = await signIn(app, ADMIN.email, ADMIN.password);
    const bad = [
      { fullName: '', email: 'a@example.com' },
      { fullName: 'A', email: 'a@example.com' },
      { fullName: 'Valid Name', email: 'not-an-email' },
      { fullName: 'Valid Name', email: 'a@example.com', role: 'owner' },
      { fullName: '<script>x</script>', email: 'a@example.com' },
      { fullName: 'x'.repeat(201), email: 'a@example.com' },
      { fullName: 'Valid Name', email: 'a@example.com', password: 'chosen-by-admin' },
      { fullName: 'Valid Name', email: 'a@example.com', status: 'disabled' },
    ];
    for (const body of bad) {
      const res = await admin.post('/api/admin/users').send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect(await scalar<number>(pool, 'SELECT COUNT(*) FROM users')).toBe(2);
  });

  it('records the creation in the audit log without the password', async () => {
    const admin = await signIn(app, ADMIN.email, ADMIN.password);
    const res = await admin
      .post('/api/admin/users')
      .send({ fullName: 'Audit Me', email: 'audit@example.com' });
    const [rows] = await pool.query(
      "SELECT actor_id, details FROM audit_log WHERE action = 'user.created'",
    );
    const row = (rows as { actor_id: number; details: string }[])[0];
    expect(row?.actor_id).toBe(adminId);
    expect(JSON.parse(String(row?.details))).toMatchObject({
      email: 'audit@example.com',
      role: 'judge',
    });
    expect(String(row?.details)).not.toContain(res.body.temporaryPassword);
  });
});

describe('editing accounts', () => {
  it('changes name and e-mail and records old and new values', async () => {
    const admin = await signIn(app, ADMIN.email, ADMIN.password);
    const res = await admin
      .patch(`/api/admin/users/${judgeId}`)
      .send({ fullName: 'Judge Renamed', email: 'renamed@example.com' });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({
      fullName: 'Judge Renamed',
      email: 'renamed@example.com',
    });
    const details = JSON.parse(
      await scalar<string>(pool, "SELECT details FROM audit_log WHERE action = 'user.updated'"),
    );
    expect(details.changes.email).toEqual({ from: JUDGE.email, to: 'renamed@example.com' });
    // The judge signs in with the new e-mail.
    expect(
      (
        await request(app)
          .post('/api/auth/login')
          .send({ email: 'renamed@example.com', password: JUDGE.password })
      ).status,
    ).toBe(200);
  });

  it('refuses an e-mail that belongs to another account', async () => {
    const admin = await signIn(app, ADMIN.email, ADMIN.password);
    const res = await admin
      .patch(`/api/admin/users/${judgeId}`)
      .send({ email: ADMIN.email.toUpperCase() });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('answers 404 for unknown accounts and 400 for bad ids or empty changes', async () => {
    const admin = await signIn(app, ADMIN.email, ADMIN.password);
    expect(
      (await admin.patch('/api/admin/users/999999').send({ fullName: 'Nobody Here' })).status,
    ).toBe(404);
    expect(
      (await admin.patch('/api/admin/users/abc').send({ fullName: 'Nobody Here' })).status,
    ).toBe(400);
    expect((await admin.patch(`/api/admin/users/${judgeId}`).send({})).status).toBe(400);
    expect(
      (await admin.patch(`/api/admin/users/${judgeId}`).send({ password_hash: 'x' })).status,
    ).toBe(400);
  });
});

describe('disabling and reactivating', () => {
  it('disables an account, signs it out at once and blocks sign-in', async () => {
    const admin = await signIn(app, ADMIN.email, ADMIN.password);
    const judge = await signIn(app, JUDGE.email, JUDGE.password);
    expect((await judge.get('/api/judge/assignments')).status).toBe(200);

    const res = await admin.patch(`/api/admin/users/${judgeId}`).send({ status: 'disabled' });
    expect(res.body.user.status).toBe('disabled');
    expect((await judge.get('/api/judge/assignments')).status).toBe(401);
    const login = await request(app).post('/api/auth/login').send(JUDGE);
    expect(login.body.error.code).toBe('ACCOUNT_DISABLED');
    expect(
      await scalar<number>(pool, "SELECT COUNT(*) FROM audit_log WHERE action = 'user.disabled'"),
    ).toBe(1);
  });

  it('reactivates an account so it can sign in again', async () => {
    const admin = await signIn(app, ADMIN.email, ADMIN.password);
    await admin.patch(`/api/admin/users/${judgeId}`).send({ status: 'disabled' });
    const res = await admin.patch(`/api/admin/users/${judgeId}`).send({ status: 'active' });
    expect(res.body.user.status).toBe('active');
    expect((await request(app).post('/api/auth/login').send(JUDGE)).status).toBe(200);
    expect(
      await scalar<number>(
        pool,
        "SELECT COUNT(*) FROM audit_log WHERE action = 'user.reactivated'",
      ),
    ).toBe(1);
  });

  it('does not let an administrator disable their own account', async () => {
    await insertUser('admin2@example.com', 'Admin Two', 'admin', ADMIN.password);
    const admin = await signIn(app, ADMIN.email, ADMIN.password);
    const res = await admin.patch(`/api/admin/users/${adminId}`).send({ status: 'disabled' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CANNOT_DISABLE_SELF');
  });
});

describe('role changes', () => {
  it('promotes a judge, who gets admin access on the very next request', async () => {
    const admin = await signIn(app, ADMIN.email, ADMIN.password);
    const judge = await signIn(app, JUDGE.email, JUDGE.password);
    expect((await judge.get('/api/admin/users')).status).toBe(403);
    await admin.patch(`/api/admin/users/${judgeId}`).send({ role: 'admin' });
    expect((await judge.get('/api/admin/users')).status).toBe(200);
    const details = JSON.parse(
      await scalar<string>(
        pool,
        "SELECT details FROM audit_log WHERE action = 'user.role_changed'",
      ),
    );
    expect(details).toMatchObject({ from: 'judge', to: 'admin' });
  });

  it('demotes an administrator, who loses admin access immediately', async () => {
    const second = await insertUser('admin2@example.com', 'Admin Two', 'admin', ADMIN.password);
    const admin = await signIn(app, ADMIN.email, ADMIN.password);
    const other = await signIn(app, 'admin2@example.com', ADMIN.password);
    await admin.patch(`/api/admin/users/${second}`).send({ role: 'judge' });
    expect((await other.get('/api/admin/users')).status).toBe(403);
  });

  it('lets an administrator step down only while another active administrator exists', async () => {
    await insertUser('admin2@example.com', 'Admin Two', 'admin', ADMIN.password);
    const admin = await signIn(app, ADMIN.email, ADMIN.password);
    const res = await admin.patch(`/api/admin/users/${adminId}`).send({ role: 'judge' });
    expect(res.status).toBe(200);
    expect((await admin.get('/api/admin/users')).status).toBe(403);
  });
});

describe('last active administrator', () => {
  it('cannot be demoted', async () => {
    const admin = await signIn(app, ADMIN.email, ADMIN.password);
    const res = await admin.patch(`/api/admin/users/${adminId}`).send({ role: 'judge' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('LAST_ADMIN');
    expect(await scalar(pool, 'SELECT role FROM users WHERE id = ?', [adminId])).toBe('admin');
  });

  it('cannot be disabled, even when other (disabled) administrators exist', async () => {
    const other = await insertUser('admin2@example.com', 'Admin Two', 'admin', ADMIN.password);
    const admin = await signIn(app, ADMIN.email, ADMIN.password);
    await admin.patch(`/api/admin/users/${other}`).send({ status: 'disabled' });
    const promoted = await signIn(app, JUDGE.email, JUDGE.password);
    // Make the judge an admin, then have them try to disable Youmna and demote themselves.
    await admin.patch(`/api/admin/users/${judgeId}`).send({ role: 'admin' });
    expect(
      (await promoted.patch(`/api/admin/users/${adminId}`).send({ status: 'disabled' })).status,
    ).toBe(200);
    const last = await promoted.patch(`/api/admin/users/${judgeId}`).send({ role: 'judge' });
    expect(last.body.error.code).toBe('LAST_ADMIN');
  });

  it('is protected when two administrators try to remove each other at the same moment', async () => {
    const second = await insertUser('admin2@example.com', 'Admin Two', 'admin', ADMIN.password);
    const a = await signIn(app, ADMIN.email, ADMIN.password);
    const b = await signIn(app, 'admin2@example.com', ADMIN.password);
    const [ra, rb] = await Promise.all([
      a.patch(`/api/admin/users/${second}`).send({ status: 'disabled' }),
      b.patch(`/api/admin/users/${adminId}`).send({ status: 'disabled' }),
    ]);
    expect([ra.status, rb.status].sort()).toEqual([200, 409]);
    expect(
      await scalar<number>(
        pool,
        "SELECT COUNT(*) FROM users WHERE role = 'admin' AND status = 'active'",
      ),
    ).toBe(1);
  });

  it('is also enforced by the database itself (trigger), for any client', async () => {
    const conn = await connectTest();
    try {
      await expectRefused(
        conn.query("UPDATE users SET role = 'judge' WHERE id = ?", [adminId]),
        /last active administrator/,
      );
      await expectRefused(
        conn.query("UPDATE users SET status = 'disabled' WHERE id = ?", [adminId]),
        /last active administrator/,
      );
      await expectRefused(
        conn.query('DELETE FROM users WHERE id = ?', [adminId]),
        /last active administrator/,
      );
    } finally {
      await conn.end();
    }
  });
});

describe('password reset by an administrator', () => {
  it('issues a new temporary password once, ends sessions and forces a change', async () => {
    const admin = await signIn(app, ADMIN.email, ADMIN.password);
    const judge = await signIn(app, JUDGE.email, JUDGE.password);
    await pool.query('UPDATE users SET locked_until = NOW() + INTERVAL 1 HOUR WHERE id = ?', [
      judgeId,
    ]);

    const res = await admin.post(`/api/admin/users/${judgeId}/reset-password`);
    expect(res.status).toBe(200);
    const temp = res.body.temporaryPassword as string;
    expect(passwordProblems(temp)).toEqual([]);
    expect(res.body.user).toMatchObject({ mustChangePassword: true, isLocked: false });

    expect((await judge.get('/api/auth/me')).status).toBe(401); // signed out everywhere
    expect((await request(app).post('/api/auth/login').send(JUDGE)).status).toBe(401); // old password dead
    const fresh = await request(app)
      .post('/api/auth/login')
      .send({ email: JUDGE.email, password: temp });
    expect(fresh.body.user.mustChangePassword).toBe(true);

    const [rows] = await pool.query(
      "SELECT actor_id, details FROM audit_log WHERE action = 'auth.password_reset'",
    );
    const row = (rows as { actor_id: number; details: string }[])[0];
    expect(row?.actor_id).toBe(adminId);
    expect(String(row?.details)).not.toContain(temp);
  });

  it('is not used for your own account (use Change password)', async () => {
    const admin = await signIn(app, ADMIN.email, ADMIN.password);
    const res = await admin.post(`/api/admin/users/${adminId}/reset-password`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('USE_CHANGE_PASSWORD');
  });

  it('answers 404 for unknown accounts', async () => {
    const admin = await signIn(app, ADMIN.email, ADMIN.password);
    expect((await admin.post('/api/admin/users/999999/reset-password')).status).toBe(404);
  });
});
