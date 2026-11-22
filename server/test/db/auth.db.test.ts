import { testMysql as mysql } from './helpers.js';
/**
 * Authentication and authorization against a real (scratch) MySQL database:
 * login, invalid credentials, lockout, rate limiting, forced password change,
 * session expiry, logout, disabled accounts, role checks, CSRF and recovery.
 */
import { type Pool } from 'mysql2/promise';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { resetPasswordToTemporary } from '../../src/auth/service.js';
import { MySqlSessionStore } from '../../src/auth/sessionStore.js';
import type { AuthConfig } from '../../src/config.js';
import { seedInitialAdmin } from '../../src/db/seed.js';
import {
  connectTest,
  createUser,
  dropDatabase,
  freshTestDatabase,
  scalar,
  TEST_DB,
  testTarget,
} from './helpers.js';

const ADMIN_EMAIL = 'youmna54@gmail.com';
const ADMIN_TEMP = 'Temp-Admin-Pass-2026!';
const JUDGE_EMAIL = 'judge@example.com';
const JUDGE_PASS = 'Fixture-Password-1!'; // matches the fixture hash in helpers.ts
const NEW_PASS = 'Brand-New-Secret-77#';

let pool: Pool;

const baseAuth: AuthConfig = {
  sessionSecret: 'test-session-secret-0123456789abcdef0123456789abcdef',
  idleTimeoutMs: 60_000,
  maxSessionMs: 3_600_000,
  cookieSecure: false,
  loginRateLimit: 100,
  lockoutThreshold: 5,
  lockoutMinutes: 15,
};

function makeApp(overrides: Partial<AuthConfig> = {}) {
  const config = { ...baseAuth, ...overrides };
  return createApp({
    checkDatabase: async () => ({
      status: 'ok',
      serverVersion: 'test',
      database: TEST_DB,
      latencyMs: 0,
    }),
    environment: 'test',
    version: 'test',
    auth: { pool, config, store: new MySqlSessionStore(pool, config.maxSessionMs) },
  });
}

async function login(agent: request.Agent, email: string, password: string) {
  return agent.post('/api/auth/login').send({ email, password });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  await freshTestDatabase();
  pool = mysql.createPool({ ...testTarget, connectionLimit: 5 });
});

beforeEach(async () => {
  // Fresh accounts for every test.
  // TRUNCATE resets the tables without firing the delete triggers that protect
  // real data (last administrator, append-only audit log). Test cleanup only.
  await pool.query('SET FOREIGN_KEY_CHECKS = 0');
  await pool.query('TRUNCATE TABLE sessions');
  await pool.query('TRUNCATE TABLE users');
  await pool.query('SET FOREIGN_KEY_CHECKS = 1');
  const conn = await connectTest();
  try {
    await seedInitialAdmin(conn, {
      email: ADMIN_EMAIL,
      fullName: 'Administrator',
      initialPassword: ADMIN_TEMP,
    });
    await createUser(conn, { email: JUDGE_EMAIL, role: 'judge' });
    await conn.query('UPDATE users SET must_change_password = FALSE WHERE email = ?', [
      JUDGE_EMAIL,
    ]);
  } finally {
    await conn.end();
  }
});

afterEach(() => {});

afterAll(async () => {
  await pool.end();
  await dropDatabase(TEST_DB);
});

describe('sign in', () => {
  it('signs in the initial administrator with a secure session cookie', async () => {
    const agent = request.agent(makeApp());
    const res = await login(agent, ADMIN_EMAIL, ADMIN_TEMP);
    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({
      id: expect.any(Number),
      email: ADMIN_EMAIL,
      fullName: 'Administrator',
      role: 'admin',
      mustChangePassword: true,
    });
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/^jp\.sid=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(res.headers['cache-control']).toBe('no-store');
    // The session lives on the server; the cookie only carries an id.
    expect(await scalar<number>(pool, 'SELECT COUNT(*) FROM sessions')).toBe(1);
    expect(cookie).not.toContain(ADMIN_EMAIL);
  });

  it('accepts the e-mail in any letter case and with spaces around it', async () => {
    const res = await login(request.agent(makeApp()), '  YOUMNA54@Gmail.COM ', ADMIN_TEMP);
    expect(res.status).toBe(200);
  });

  it('gives the same answer for a wrong password and an unknown e-mail', async () => {
    const app = makeApp();
    const wrong = await login(request.agent(app), ADMIN_EMAIL, 'Not-The-Password-1!');
    const unknown = await login(request.agent(app), 'nobody@example.com', 'Not-The-Password-1!');
    for (const res of [wrong, unknown]) {
      expect(res.status).toBe(401);
      expect(res.body.error).toEqual({
        code: 'INVALID_CREDENTIALS',
        message: 'Incorrect e-mail or password.',
      });
      expect(res.headers['set-cookie']).toBeUndefined();
    }
  });

  it('rejects malformed requests and unexpected fields', async () => {
    const app = makeApp();
    expect((await request(app).post('/api/auth/login').send({ email: ADMIN_EMAIL })).status).toBe(
      400,
    );
    expect(
      (
        await request(app)
          .post('/api/auth/login')
          .send({ email: ADMIN_EMAIL, password: 'x', role: 'admin' })
      ).status,
    ).toBe(400);
  });

  it('issues a new session id at sign-in (no session fixation)', async () => {
    const agent = request.agent(makeApp());
    const forged = 'jp.sid=s%3Aattacker-chosen-id.invalidsignature';
    const res = await agent
      .post('/api/auth/login')
      .set('Cookie', forged)
      .send({ email: JUDGE_EMAIL, password: JUDGE_PASS });
    expect(res.status).toBe(200);
    expect(String(res.headers['set-cookie'])).not.toContain('attacker-chosen-id');
  });

  it('records successful and failed sign-ins in the audit log without passwords', async () => {
    const app = makeApp();
    await login(request.agent(app), ADMIN_EMAIL, 'Wrong-Password-99!');
    await login(request.agent(app), ADMIN_EMAIL, ADMIN_TEMP);
    const [rows] = await pool.query(
      "SELECT action, details FROM audit_log WHERE action LIKE 'auth.%' ORDER BY id",
    );
    const actions = (rows as { action: string }[]).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['auth.login_failed', 'auth.login_succeeded']));
    expect(JSON.stringify(rows)).not.toContain('Wrong-Password-99!');
    expect(JSON.stringify(rows)).not.toContain(ADMIN_TEMP);
  });
});

describe('forced password change', () => {
  it('blocks everything except the password change until it is done', async () => {
    const agent = request.agent(makeApp());
    await login(agent, ADMIN_EMAIL, ADMIN_TEMP);
    const blocked = await agent.get('/api/admin/overview');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await agent.get('/api/judge/assignments')).status).toBe(403);
    expect((await agent.get('/api/auth/me')).status).toBe(200);
  });

  it('rejects a wrong current password and weak or reused new passwords', async () => {
    const agent = request.agent(makeApp());
    await login(agent, ADMIN_EMAIL, ADMIN_TEMP);
    const wrong = await agent
      .post('/api/auth/change-password')
      .send({ currentPassword: 'nope', newPassword: NEW_PASS });
    expect(wrong.body.error.code).toBe('CURRENT_PASSWORD_INCORRECT');
    const weak = await agent
      .post('/api/auth/change-password')
      .send({ currentPassword: ADMIN_TEMP, newPassword: 'short' });
    expect(weak.status).toBe(400);
    expect(weak.body.error.code).toBe('WEAK_PASSWORD');
    const same = await agent
      .post('/api/auth/change-password')
      .send({ currentPassword: ADMIN_TEMP, newPassword: ADMIN_TEMP });
    expect(same.body.problems).toContain('must be different from your current password');
    const withEmail = await agent
      .post('/api/auth/change-password')
      .send({ currentPassword: ADMIN_TEMP, newPassword: 'Youmna54-Strong-Pass!' });
    expect(withEmail.body.problems).toContain('must not contain your e-mail name');
  });

  it('changes the password, unlocks the app, and keeps this browser signed in', async () => {
    const agent = request.agent(makeApp());
    await login(agent, ADMIN_EMAIL, ADMIN_TEMP);
    const res = await agent
      .post('/api/auth/change-password')
      .send({ currentPassword: ADMIN_TEMP, newPassword: NEW_PASS });
    expect(res.status).toBe(200);
    expect(res.body.user.mustChangePassword).toBe(false);
    expect((await agent.get('/api/admin/overview')).status).toBe(200);
    expect(
      await scalar(pool, 'SELECT must_change_password FROM users WHERE email = ?', [ADMIN_EMAIL]),
    ).toBe(0);
  });

  it('makes the old password stop working and signs out other sessions', async () => {
    const app = makeApp();
    const laptop = request.agent(app);
    const phone = request.agent(app);
    await login(laptop, ADMIN_EMAIL, ADMIN_TEMP);
    await login(phone, ADMIN_EMAIL, ADMIN_TEMP);
    await laptop
      .post('/api/auth/change-password')
      .send({ currentPassword: ADMIN_TEMP, newPassword: NEW_PASS });

    const other = await phone.get('/api/auth/me');
    expect(other.status).toBe(401);
    expect(other.body.error.code).toBe('SESSION_EXPIRED');
    expect((await login(request.agent(app), ADMIN_EMAIL, ADMIN_TEMP)).status).toBe(401);
    expect((await login(request.agent(app), ADMIN_EMAIL, NEW_PASS)).status).toBe(200);
  });
});

describe('lockout and rate limiting', () => {
  it('locks the account after 5 wrong passwords, even for the right password', async () => {
    const app = makeApp();
    for (let i = 0; i < 4; i++) {
      expect((await login(request.agent(app), JUDGE_EMAIL, `Wrong-${i}-Password!`)).status).toBe(
        401,
      );
    }
    const fifth = await login(request.agent(app), JUDGE_EMAIL, 'Wrong-5-Password!');
    expect(fifth.status).toBe(423);
    expect(fifth.body.error.code).toBe('ACCOUNT_LOCKED');
    const right = await login(request.agent(app), JUDGE_EMAIL, JUDGE_PASS);
    expect(right.status).toBe(423);
    expect(Number(right.headers['retry-after'])).toBeGreaterThan(0);
    expect(
      await scalar<number>(
        pool,
        "SELECT COUNT(*) FROM audit_log WHERE action = 'auth.account_locked'",
      ),
    ).toBe(1);
  });

  it('unlocks automatically when the lock time has passed', async () => {
    const app = makeApp();
    for (let i = 0; i < 5; i++)
      await login(request.agent(app), JUDGE_EMAIL, `Wrong-${i}-Password!`);
    await pool.query('UPDATE users SET locked_until = NOW() - INTERVAL 1 SECOND WHERE email = ?', [
      JUDGE_EMAIL,
    ]);
    expect((await login(request.agent(app), JUDGE_EMAIL, JUDGE_PASS)).status).toBe(200);
    expect(
      await scalar(pool, 'SELECT failed_login_count FROM users WHERE email = ?', [JUDGE_EMAIL]),
    ).toBe(0);
  });

  it('resets the failure counter after a successful sign-in', async () => {
    const app = makeApp();
    for (let i = 0; i < 4; i++)
      await login(request.agent(app), JUDGE_EMAIL, `Wrong-${i}-Password!`);
    await login(request.agent(app), JUDGE_EMAIL, JUDGE_PASS);
    for (let i = 0; i < 4; i++)
      await login(request.agent(app), JUDGE_EMAIL, `Wrong-${i}-Password!`);
    expect((await login(request.agent(app), JUDGE_EMAIL, JUDGE_PASS)).status).toBe(200);
  });

  it('limits failed sign-in attempts per device across different e-mails', async () => {
    const app = makeApp({ loginRateLimit: 3 });
    for (let i = 0; i < 3; i++) {
      expect(
        (await login(request.agent(app), `user${i}@example.com`, 'Whatever-123!')).status,
      ).toBe(401);
    }
    const limited = await login(request.agent(app), ADMIN_EMAIL, ADMIN_TEMP);
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('TOO_MANY_ATTEMPTS');
  });
});

describe('sessions', () => {
  it('ends after the idle timeout', async () => {
    const agent = request.agent(makeApp({ idleTimeoutMs: 1_000 }));
    await login(agent, JUDGE_EMAIL, JUDGE_PASS);
    expect((await agent.get('/api/auth/me')).status).toBe(200);
    await sleep(1_600);
    const expired = await agent.get('/api/auth/me');
    expect(expired.status).toBe(401);
    expect(expired.body.error.code).toBe('SESSION_EXPIRED');
  });

  it('stays alive while in use (each request extends the idle timeout)', async () => {
    const agent = request.agent(makeApp({ idleTimeoutMs: 1_500 }));
    await login(agent, JUDGE_EMAIL, JUDGE_PASS);
    for (let i = 0; i < 3; i++) {
      await sleep(700);
      expect((await agent.get('/api/auth/me')).status).toBe(200);
    }
  });

  it('ends after the absolute maximum even while in use', async () => {
    const agent = request.agent(makeApp({ maxSessionMs: 1_000 }));
    await login(agent, JUDGE_EMAIL, JUDGE_PASS);
    await sleep(1_200);
    expect((await agent.get('/api/auth/me')).body.error.code).toBe('SESSION_EXPIRED');
  });

  it('ignores a cookie with a tampered signature', async () => {
    const agent = request.agent(makeApp());
    const res = await login(agent, JUDGE_EMAIL, JUDGE_PASS);
    const cookie = String(res.headers['set-cookie']).split(';')[0] as string;
    const tampered = cookie.slice(0, -3) + 'abc';
    expect((await request(makeApp()).get('/api/auth/me').set('Cookie', tampered)).status).toBe(401);
  });

  it('signs out: the session is deleted on the server and the cookie cleared', async () => {
    const agent = request.agent(makeApp());
    const res = await login(agent, JUDGE_EMAIL, JUDGE_PASS);
    const cookie = String(res.headers['set-cookie']).split(';')[0] as string;
    const out = await agent.post('/api/auth/logout');
    expect(out.status).toBe(204);
    expect(String(out.headers['set-cookie'])).toMatch(/jp\.sid=;/);
    expect(await scalar<number>(pool, 'SELECT COUNT(*) FROM sessions WHERE data IS NOT NULL')).toBe(
      0,
    );
    // Re-using the old cookie does not work.
    expect((await request(makeApp()).get('/api/auth/me').set('Cookie', cookie)).status).toBe(401);
  });
});

describe('sign-out race', () => {
  it('a request still running during sign-out cannot bring the session back', async () => {
    const store = new MySqlSessionStore(pool, 60_000);
    const sid = 'race-test-session';
    const sess = {
      cookie: { originalMaxAge: 60_000, expires: new Date(Date.now() + 60_000) },
      userId: 1,
      epoch: 0,
      createdAt: Date.now(),
      lastSeen: Date.now(),
    };
    const call = (fn: (cb: (err?: unknown) => void) => void) =>
      new Promise<void>((ok, fail) => fn((err) => (err ? fail(err) : ok())));
    const get = () =>
      new Promise((ok, fail) => store.get(sid, (err, value) => (err ? fail(err) : ok(value))));

    await call((cb) => store.set(sid, sess as never, cb));
    expect(await get()).not.toBeNull();
    await call((cb) => store.destroy(sid, cb)); // sign-out
    await call((cb) => store.set(sid, { ...sess, lastSeen: Date.now() } as never, cb)); // late save
    await call((cb) => store.touch(sid, sess as never, cb)); // late touch
    expect(await get()).toBeNull();
    expect(await store.clearExpired()).toBeGreaterThanOrEqual(1); // tombstone cleaned up
  });
});

describe('disabled accounts', () => {
  it('cannot sign in, and are told so only after a correct password', async () => {
    await pool.query("UPDATE users SET status = 'disabled' WHERE email = ?", [JUDGE_EMAIL]);
    const app = makeApp();
    expect(
      (await login(request.agent(app), JUDGE_EMAIL, 'Wrong-Password-1!')).body.error.code,
    ).toBe('INVALID_CREDENTIALS');
    const res = await login(request.agent(app), JUDGE_EMAIL, JUDGE_PASS);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_DISABLED');
  });

  it('are signed out immediately when disabled during a session', async () => {
    const agent = request.agent(makeApp());
    await login(agent, JUDGE_EMAIL, JUDGE_PASS);
    expect((await agent.get('/api/judge/assignments')).status).toBe(200);
    await pool.query("UPDATE users SET status = 'disabled' WHERE email = ?", [JUDGE_EMAIL]);
    const res = await agent.get('/api/judge/assignments');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('SESSION_EXPIRED');
  });
});

describe('authorization', () => {
  it('refuses every protected API without a session', async () => {
    const app = makeApp();
    for (const path of [
      '/api/auth/me',
      '/api/admin/overview',
      '/api/judge/assignments',
      '/api/admin/anything',
    ]) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(401);
      expect(res.body.error.code, path).toBe('NOT_AUTHENTICATED');
    }
    expect(
      (
        await request(app)
          .post('/api/auth/change-password')
          .send({ currentPassword: 'a', newPassword: 'b' })
      ).status,
    ).toBe(401);
  });

  it('refuses admin APIs to judges', async () => {
    const agent = request.agent(makeApp());
    await login(agent, JUDGE_EMAIL, JUDGE_PASS);
    const res = await agent.get('/api/admin/overview');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect((await agent.get('/api/judge/assignments')).status).toBe(200);
  });

  it('lets a judge see only their own assigned, active teams', async () => {
    const judgeId = await scalar<number>(pool, 'SELECT id FROM users WHERE email = ?', [
      JUDGE_EMAIL,
    ]);
    const otherJudge = await createUser(pool as unknown as import('mysql2/promise').Connection, {
      email: 'other@example.com',
    });
    await pool.query(
      "INSERT INTO teams (team_code, name, project_name) VALUES ('T1','Mine','P1'), ('T2','Not mine','P2'), ('T3','Archived','P3')",
    );
    await pool.query(
      `INSERT INTO team_judges (team_id, judge_id) SELECT id, ? FROM teams WHERE team_code IN ('T1','T3')
       UNION ALL SELECT id, ? FROM teams WHERE team_code = 'T2'`,
      [judgeId, otherJudge],
    );
    // Archive after assigning: new assignments to archived teams are refused.
    await pool.query(
      "UPDATE teams SET status = 'archived', archived_at = NOW() WHERE team_code = 'T3'",
    );
    const agent = request.agent(makeApp());
    await login(agent, JUDGE_EMAIL, JUDGE_PASS);
    const res = await agent.get('/api/judge/assignments');
    expect(res.body.assignments.map((a: { teamCode: string }) => a.teamCode)).toEqual(['T1']);
    // Teams can never be deleted (trigger); TRUNCATE is test cleanup only.
    await pool.query('SET FOREIGN_KEY_CHECKS = 0');
    await pool.query('TRUNCATE TABLE team_judges');
    await pool.query('TRUNCATE TABLE teams');
    await pool.query('SET FOREIGN_KEY_CHECKS = 1');
  });

  it('refuses state-changing requests from another origin (CSRF)', async () => {
    const agent = request.agent(makeApp());
    const evil = await agent
      .post('/api/auth/login')
      .set('Origin', 'http://evil.example')
      .send({ email: JUDGE_EMAIL, password: JUDGE_PASS });
    expect(evil.status).toBe(403);
    expect(evil.body.error.code).toBe('ORIGIN_MISMATCH');
    const crossSite = await agent
      .post('/api/auth/login')
      .set('Sec-Fetch-Site', 'cross-site')
      .send({ email: JUDGE_EMAIL, password: JUDGE_PASS });
    expect(crossSite.status).toBe(403);
    const same = await agent
      .post('/api/auth/login')
      .set('Origin', 'http://127.0.0.1')
      .set('Host', '127.0.0.1')
      .send({ email: JUDGE_EMAIL, password: JUDGE_PASS });
    expect(same.status).toBe(200);
  });
});

describe('administrator password recovery', () => {
  it('replaces the password, forces a change, ends sessions and clears a lockout', async () => {
    const app = makeApp();
    const agent = request.agent(app);
    await login(agent, ADMIN_EMAIL, ADMIN_TEMP);
    await pool.query('UPDATE users SET locked_until = NOW() + INTERVAL 1 HOUR WHERE email = ?', [
      ADMIN_EMAIL,
    ]);

    const conn = await connectTest();
    let temporary: string;
    try {
      const result = await resetPasswordToTemporary(conn, {
        email: ADMIN_EMAIL,
        actor: { id: null, email: 'server-cli' },
      });
      temporary = result.temporaryPassword;
    } finally {
      await conn.end();
    }

    expect((await agent.get('/api/auth/me')).status).toBe(401); // old session ended
    expect((await login(request.agent(app), ADMIN_EMAIL, ADMIN_TEMP)).status).toBe(401); // exposed password dead
    const fresh = await login(request.agent(app), ADMIN_EMAIL, temporary);
    expect(fresh.status).toBe(200); // lockout cleared
    expect(fresh.body.user.mustChangePassword).toBe(true);
    expect(
      await scalar<number>(
        pool,
        "SELECT COUNT(*) FROM audit_log WHERE action = 'auth.password_reset'",
      ),
    ).toBe(1);
  });

  it('refuses unknown accounts', async () => {
    const conn = await connectTest();
    try {
      await expect(
        resetPasswordToTemporary(conn, {
          email: 'nobody@example.com',
          actor: { id: null, email: 'server-cli' },
        }),
      ).rejects.toThrow(/No account exists/);
    } finally {
      await conn.end();
    }
  });

  it('can re-enable a disabled account when asked', async () => {
    // (The last active administrator can no longer be disabled at all, so use the judge.)
    await pool.query("UPDATE users SET status = 'disabled' WHERE email = ?", [JUDGE_EMAIL]);
    const conn = await connectTest();
    try {
      const result = await resetPasswordToTemporary(conn, {
        email: JUDGE_EMAIL,
        actor: { id: null, email: 'server-cli' },
        enable: true,
      });
      expect(result.wasDisabled).toBe(false);
    } finally {
      await conn.end();
    }
    expect(await scalar(pool, 'SELECT status FROM users WHERE email = ?', [JUDGE_EMAIL])).toBe(
      'active',
    );
  });
});
