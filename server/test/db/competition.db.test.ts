import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import request from 'supertest';
import { mkdtempSync, readFileSync, readdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultRubricContent, RESET_PHRASE } from '@judging/shared';
import {
  freshTestDatabase,
  dropDatabase,
  TEST_DB,
  RESTORE_DB,
  testTarget,
  testMysql,
  adminServer,
  config,
  guardTestName,
  restoreTestDatabase,
} from './helpers.js';
import { createDraft, saveDraft, publishDraft } from '../../src/rubric/service.js';
import { competitionStatus, transitionCompetition } from '../../src/competition/service.js';
import { CompetitionReset, type MaintenanceOptions } from '../../src/competition/reset.js';
import {
  startEvaluation,
  saveEvaluation,
  submitEvaluation,
  getJudgeEvaluation,
} from '../../src/evaluations/service.js';
import {
  correctSubmission,
  getEvaluationHistory,
  reopenEvaluation,
} from '../../src/review/service.js';
import { createApp } from '../../src/app.js';
import { MySqlSessionStore } from '../../src/auth/sessionStore.js';
import { testAuthConfig, signIn } from './appHelpers.js';
import { fingerprintDatabase, compareFingerprints } from '../../src/db/backup.js';
import { getResults } from '../../src/results/service.js';
import { buildReport } from '../../src/reports/service.js';

let pool: Pool;
const password = 'Disposable-Admin-Password-1!';
const email = 'youmna54@gmail.com';
let actor: { id: number; email: string };
// The two other preserved accounts: an administrator without reset permission and a judge.
const nada = { email: 'nada.hussien@ischooltech.com', password: 'Disposable-Nada-Password-2!' };
const abdelrhman = {
  email: 'abdelrhman.elagan@ischooltech.com',
  password: 'Disposable-Abdo-Password-3!',
};
const preservedIds: number[] = [];
let options: MaintenanceOptions;
const dir = mkdtempSync(join(tmpdir(), 'judging-lifecycle-test-'));
beforeAll(async () => {
  guardTestName(TEST_DB);
  await freshTestDatabase();
  pool = testMysql.createPool(testTarget);
  const [u] = await pool.query<ResultSetHeader>(
    "INSERT INTO users(email,full_name,password_hash,role,must_change_password) VALUES(?,'Preserved administrator',?,'admin',FALSE)",
    [email, bcrypt.hashSync(password, 4)],
  );
  actor = { id: u.insertId, email };
  preservedIds.push(u.insertId);
  for (const [who, role] of [
    [nada, 'admin'],
    [abdelrhman, 'judge'],
  ] as const) {
    const [p] = await pool.query<ResultSetHeader>(
      "INSERT INTO users(email,full_name,password_hash,role,must_change_password,created_by) VALUES(?,'Preserved',?,?,FALSE,?)",
      [who.email, bcrypt.hashSync(who.password, 4), role, actor.id],
    );
    preservedIds.push(p.insertId);
  }
  options = {
    server: adminServer,
    database: TEST_DB,
    backupDir: dir,
    binDir: config.mysqlBinDir,
    executionEnabled: true,
  };
});
afterAll(async () => {
  await pool?.end();
  await dropDatabase(RESTORE_DB);
  await dropDatabase(TEST_DB);
});
it('enforces the entire lifecycle, corrections, immutable history and three judges on one locked rubric', async () => {
  const [t] = await pool.query<ResultSetHeader>(
    "INSERT INTO teams(team_code,name,project_name) VALUES('LIFE','Lifecycle','Project')",
  );
  const judges = [actor];
  for (let i = 1; i < 3; i++) {
    const [u] = await pool.query<ResultSetHeader>(
      "INSERT INTO users(email,full_name,password_hash,role,must_change_password) VALUES(?, ?,?,'judge',FALSE)",
      [`life${i}@example.com`, `Judge ${i}`, bcrypt.hashSync(password, 4)],
    );
    judges.push({ id: u.insertId, email: `life${i}@example.com` });
  }
  // A preserved account created by a user that the reset deletes.
  await pool.query('UPDATE users SET created_by=? WHERE id=?', [judges[1]!.id, preservedIds[2]]);
  await expect(transitionCompetition(pool, actor, 'judging_open', 1)).rejects.toMatchObject({
    code: 'COMPETITION_NOT_READY',
  });
  let draft = (await createDraft(pool, actor)).draft!;
  const content = defaultRubricContent();
  content.title = 'Locked rubric';
  content.sections.forEach((s) => (s.weightPercent = 25));
  draft = await saveDraft(pool, actor, draft.revision, content);
  const version = (await publishDraft(pool, actor, draft.revision, false)).published;
  await expect(startEvaluation(pool, actor, t.insertId)).rejects.toMatchObject({
    code: 'COMPETITION_LOCKED',
  });
  for (const judge of judges)
    await pool.query('INSERT INTO team_judges(team_id,judge_id) VALUES(?,?)', [
      t.insertId,
      judge.id,
    ]);
  let c = await competitionStatus(pool);
  await expect(transitionCompetition(pool, actor, 'judging_open', 999)).rejects.toMatchObject({
    code: 'COMPETITION_CONFLICT',
  });
  c = await transitionCompetition(pool, actor, 'judging_open', c.rowVersion);
  expect(c.lockedRubricVersionId).toBe(version.id);
  await expect(createDraft(pool, actor)).rejects.toMatchObject({ code: 'COMPETITION_LOCKED' });
  await expect(publishDraft(pool, actor, 1, true)).rejects.toMatchObject({
    code: 'COMPETITION_LOCKED',
  });
  const submissions = [];
  for (const judge of judges) {
    let e = await startEvaluation(pool, judge, t.insertId);
    expect(e.rubricVersionId).toBe(version.id);
    e = await saveEvaluation(pool, judge, e.id, e.rowVersion, {
      ratings: e.ratings.map((r) => ({ ...r, rating: 4 })),
      sectionNotes: e.sectionNotes,
      overallNotes: 'Submitted before close',
    });
    e = (await submitEvaluation(pool, judge, e.id, e.rowVersion)).evaluation;
    submissions.push(e);
  }
  const e = submissions[1]!;
  const input = {
    ratings: e.ratings.map((r) => ({ ...r, rating: 5 })),
    sectionNotes: e.sectionNotes,
    overallNotes: 'Administrator correction',
  };
  const corrected = await correctSubmission(
    pool,
    actor,
    e.id,
    e.rowVersion,
    input,
    'Verified correction while open',
  );
  expect(corrected.evaluation.totalScore).toBe(100);
  await expect(
    correctSubmission(pool, actor, e.id, e.rowVersion, input, 'Stale correction'),
  ).rejects.toMatchObject({ status: 409 });
  expect(
    (await getEvaluationHistory(pool, e.id)).filter((e) => e.event === 'admin_corrected'),
  ).toHaveLength(1);
  await reopenEvaluation(pool, actor, e.id, 'Reopen before competition closes');
  c = await transitionCompetition(pool, actor, 'closed', c.rowVersion);
  expect(c.state).toBe('closed');
  await expect(startEvaluation(pool, actor, t.insertId)).rejects.toMatchObject({
    code: 'COMPETITION_LOCKED',
  });
  await expect(saveEvaluation(pool, judges[1]!, e.id, 99, input)).rejects.toMatchObject({
    code: 'COMPETITION_LOCKED',
  });
  await expect(submitEvaluation(pool, judges[1]!, e.id, 99)).rejects.toMatchObject({
    code: 'COMPETITION_LOCKED',
  });
  await expect(
    correctSubmission(
      pool,
      actor,
      submissions[0]!.id,
      submissions[0]!.rowVersion,
      input,
      'Correction after close',
    ),
  ).rejects.toMatchObject({ code: 'COMPETITION_LOCKED' });
  await expect(
    reopenEvaluation(pool, actor, submissions[0]!.id, 'Reopen after close'),
  ).rejects.toMatchObject({ code: 'COMPETITION_LOCKED' });
  expect((await getJudgeEvaluation(pool, actor.id, t.insertId)).canEdit).toBe(false);
  expect(await getResults(pool, { sort: 'rank', dir: 'asc' })).toBeDefined();
});

it('requires preserved-admin authorization, fresh passwords, a verified backup, unchanged preview, exact phrase and final confirmation', async () => {
  const reset = new CompetitionReset(options);
  await expect(
    reset.prepare({ id: 999, email: 'another@example.com' }, 'session', password),
  ).rejects.toMatchObject({ status: 403 });
  await expect(reset.prepare(actor, 'session', 'wrong')).rejects.toMatchObject({ status: 403 });
  // Being preserved does not grant reset permission.
  await expect(
    reset.prepare({ id: preservedIds[1]!, email: nada.email }, 'session', nada.password),
  ).rejects.toMatchObject({ status: 403 });
  const preview = await reset.prepare(actor, 'session', password);
  expect(preview.counts.teams).toBe(1);
  expect(preview.counts.users).toBe(2); // the two life judges; the three preserved are excluded
  expect(preview.database).toBe(TEST_DB);
  expect(preview.backup.bytes).toBeGreaterThan(1000);
  expect(preview.backup).toMatchObject({ checksumVerified: true, restoreVerified: true });
  expect(preview.backup.restored.triggers).toBeGreaterThan(10);
  expect(preview.backup.restored.routines).toBeGreaterThanOrEqual(1);
  expect(preview.preservedAccounts.map((a) => [a.id, a.email, a.role, a.status])).toEqual([
    [preservedIds[0], email, 'admin', 'active'],
    [preservedIds[1], nada.email, 'admin', 'active'],
    [preservedIds[2], abdelrhman.email, 'judge', 'active'],
  ]);
  // No password hashes leave the server.
  expect(JSON.stringify(preview)).not.toMatch(/[$]2[aby][$]/);
  const input = { token: preview.token, password, phrase: RESET_PHRASE, confirmed: true };
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60_000);
  try {
    await expect(reset.execute(actor, 'session', input)).rejects.toThrow(/expired/);
  } finally {
    clock.mockRestore();
  }
  await expect(
    new CompetitionReset({ ...options, executionEnabled: false }).execute(actor, 'session', input),
  ).rejects.toMatchObject({ status: 403 });
  await expect(reset.execute(actor, 'other-session', input)).rejects.toMatchObject({ status: 409 });
  await expect(
    reset.execute(actor, 'session', { ...input, phrase: 'reset judging platform' }),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    reset.execute(actor, 'session', { ...input, confirmed: false }),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    reset.execute(actor, 'session', { ...input, password: 'incorrect' }),
  ).rejects.toMatchObject({ status: 403 });
  await pool.query(
    "INSERT INTO audit_log(action,entity_type,details) VALUES('test.change','test','{}')",
  );
  await expect(reset.execute(actor, 'session', input)).rejects.toThrow(/Data changed/);
  expect((await pool.query<RowDataPacket[]>('SELECT COUNT(*) n FROM teams'))[0][0]?.n).toBe(1);
  const fresh = await reset.prepare(actor, 'session', password);
  const backupFile = join(dir, 'competition-maintenance', fresh.backup.name);
  const original = readFileSync(backupFile);
  appendFileSync(backupFile, '\n-- tampered');
  await expect(reset.execute(actor, 'session', { ...input, token: fresh.token })).rejects.toThrow(
    /checksum/,
  );
  writeFileSync(backupFile, original);
  // The actual CALL is also bound to the exact database and unique instance identity.
  await expect(
    pool.query('CALL reset_competition(?,?,?,?)', [
      'judging_platform',
      'wrong',
      'a'.repeat(64),
      actor.id,
    ]),
  ).rejects.toThrow(/identity mismatch/);
  expect(
    (await pool.query<RowDataPacket[]>('SELECT COUNT(*) n FROM maintenance_reset_context'))[0][0]
      ?.n,
  ).toBe(0);
});

it('refuses preview and execution when any preserved account is missing', async () => {
  const reset = new CompetitionReset(options);
  const backups = () =>
    readdirSync(join(dir, 'competition-maintenance')).filter((f) => f.endsWith('.sql')).length;
  const p = await reset.prepare(actor, 'missing-session', password);
  const before = backups();
  await pool.query("UPDATE users SET email='renamed@example.com' WHERE id=?", [preservedIds[2]]);
  try {
    await expect(reset.prepare(actor, 'missing-session', password)).rejects.toThrow(
      /preserved account does not exist: abdelrhman[.]elagan@ischooltech[.]com/,
    );
    expect(backups()).toBe(before); // refused before any backup was taken
    await expect(
      reset.execute(actor, 'missing-session', {
        token: p.token,
        password,
        phrase: RESET_PHRASE,
        confirmed: true,
      }),
    ).rejects.toThrow(/preserved account does not exist/);
    // The procedure enforces the same rule even with an otherwise valid permit.
    const [[c]] = await pool.query<RowDataPacket[]>('SELECT instance_id FROM competition');
    await pool.query(
      'INSERT INTO maintenance_reset_permits(permit_hash,instance_id,actor_id,backup_sha256,expires_at) VALUES(?,?,?,?,NOW(3)+INTERVAL 5 MINUTE)',
      ['c'.repeat(64), c!.instance_id, actor.id, 'd'.repeat(64)],
    );
    await expect(
      pool.query('CALL reset_competition(?,?,?,?)', [
        TEST_DB,
        c!.instance_id,
        'c'.repeat(64),
        actor.id,
      ]),
    ).rejects.toThrow(/preserved account is missing/);
    expect((await pool.query<RowDataPacket[]>('SELECT COUNT(*) n FROM teams'))[0][0]?.n).toBe(1);
    expect((await pool.query<RowDataPacket[]>('SELECT COUNT(*) n FROM users'))[0][0]?.n).toBe(5);
  } finally {
    await pool.query('DELETE FROM maintenance_reset_permits');
    await pool.query('UPDATE users SET email=? WHERE id=?', [abdelrhman.email, preservedIds[2]]);
  }
});

it('refuses a preview on a database without migration 015, before taking a backup', async () => {
  const [[row]] = await pool.query<RowDataPacket[]>(
    'SELECT * FROM schema_migrations WHERE version=15',
  );
  expect(row).toBeDefined();
  await pool.query('DELETE FROM schema_migrations WHERE version=15');
  try {
    await expect(
      new CompetitionReset(options).prepare(actor, 'old-schema', password),
    ).rejects.toThrow(/migration 015/);
  } finally {
    await pool.query('INSERT INTO schema_migrations SET ?', [row]);
  }
});

it('rolls back every prior deletion and maintenance authorization if a later deletion fails', async () => {
  await pool.query(
    "CREATE TRIGGER trg_reset_fixture_failure BEFORE DELETE ON teams FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Fixture reset failure'",
  );
  try {
    const before = await fingerprintDatabase(adminServer, TEST_DB);
    const reset = new CompetitionReset(options);
    const p = await reset.prepare(actor, 'rollback-session', password);
    await expect(
      reset.execute(actor, 'rollback-session', {
        token: p.token,
        password,
        phrase: RESET_PHRASE,
        confirmed: true,
      }),
    ).rejects.toThrow(/Fixture reset failure/);
    const after = await fingerprintDatabase(adminServer, TEST_DB);
    expect(compareFingerprints(before, after)).toEqual([]);
    expect(
      (await pool.query<RowDataPacket[]>('SELECT COUNT(*) n FROM maintenance_reset_context'))[0][0]
        ?.n,
    ).toBe(0);
    expect(
      (await pool.query<RowDataPacket[]>('SELECT COUNT(*) n FROM maintenance_reset_permits'))[0][0]
        ?.n,
    ).toBe(0);
  } finally {
    await pool.query('DROP TRIGGER trg_reset_fixture_failure');
  }
});

it('backs up before deletion, resets only the disposable database, preserves credentials, schema and final reports, and permits a new competition', async () => {
  const app = createApp({
    environment: 'test',
    version: 'test',
    checkDatabase: async () => ({
      status: 'ok',
      database: TEST_DB,
      serverVersion: 'test',
      latencyMs: 0,
    }),
    auth: {
      pool,
      config: testAuthConfig,
      store: new MySqlSessionStore(pool, testAuthConfig.maxSessionMs),
    },
    maintenance: options,
  });
  const admin = await signIn(app, email, password);
  const other = await signIn(app, 'life1@example.com', password);
  const nadaSession = await signIn(app, nada.email, nada.password);
  expect((await other.post('/api/admin/competition/reset/preview').send({ password })).status).toBe(
    403,
  );
  // A preserved administrator other than the reset administrator is refused too.
  expect(
    (
      await nadaSession
        .post('/api/admin/competition/reset/preview')
        .send({ password: nada.password })
    ).status,
  ).toBe(403);
  expect(
    (await request(app).post('/api/admin/competition/reset/preview').send({ password })).status,
  ).toBe(401);
  const [preservedBefore] = await pool.query<RowDataPacket[]>(
    'SELECT id,email,role,status,password_hash FROM users WHERE id IN (?) ORDER BY id',
    [preservedIds],
  );
  expect(preservedBefore).toHaveLength(3);
  const [triggers] = await pool.query<RowDataPacket[]>(
    'SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() ORDER BY TRIGGER_NAME',
  );
  const p = await admin.post('/api/admin/competition/reset/preview').send({ password });
  expect(p.status).toBe(200);
  const backupFile = join(dir, 'competition-maintenance', p.body.backup.name);
  // Restore verification goes only to the guarded disposable restore target, never the configured database.
  await restoreTestDatabase(backupFile, RESTORE_DB, { binDir: config.mysqlBinDir, inPlace: true });
  const originalFingerprint = await fingerprintDatabase(adminServer, TEST_DB);
  const restoredFingerprint = await fingerprintDatabase(adminServer, RESTORE_DB);
  delete originalFingerprint.tables.sessions;
  delete restoredFingerprint.tables.sessions;
  expect(compareFingerprints(originalFingerprint, restoredFingerprint)).toEqual([]);
  const restored = await testMysql.createConnection({ ...testTarget, database: RESTORE_DB });
  expect((await restored.query<RowDataPacket[]>('SELECT COUNT(*) n FROM teams'))[0][0]?.n).toBe(1);
  await restored.end();
  const result = await admin
    .post('/api/admin/competition/reset/execute')
    .send({ token: p.body.token, password, phrase: RESET_PHRASE, confirmed: true });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  expect((await other.get('/api/auth/me')).status).toBe(401);
  expect((await admin.get('/api/auth/me')).status).toBe(401);
  expect((await nadaSession.get('/api/auth/me')).status).toBe(401);
  // Exactly the three preserved accounts remain with unchanged IDs, e-mails, hashes, roles and status.
  const [users] = await pool.query<RowDataPacket[]>(
    'SELECT id,email,role,status,password_hash,created_by FROM users ORDER BY id',
  );
  expect(users.map(({ created_by: _c, ...u }) => u)).toEqual(preservedBefore);
  expect(users.find((u) => u.id === preservedIds[2])?.created_by).toBeNull();
  expect(users.find((u) => u.id === preservedIds[1])?.created_by).toBe(actor.id);
  for (const table of [
    'teams',
    'team_judges',
    'evaluations',
    'evaluation_scores',
    'evaluation_section_notes',
    'evaluation_events',
    'audit_log',
    'rubric_versions',
    'rubric_sections',
    'rubric_criteria',
    'rubric_scale_levels',
    'maintenance_reset_context',
    'maintenance_reset_permits',
  ]) {
    expect(
      (await pool.query<RowDataPacket[]>(`SELECT COUNT(*) n FROM ${table}`))[0][0]?.n,
      table,
    ).toBe(0);
  }
  expect((await competitionStatus(pool)).state).toBe('preparation');
  const [after] = await pool.query<RowDataPacket[]>(
    'SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() ORDER BY TRIGGER_NAME',
  );
  expect(after).toEqual(triggers);
  expect((await pool.query<RowDataPacket[]>('SELECT @@foreign_key_checks AS n'))[0][0]?.n).toBe(1);
  expect((await (await signIn(app, email, password)).get('/api/admin/overview')).status).toBe(200);
  // The other two preserved accounts sign in with their unchanged passwords
  // (sign-ins write new audit events, so this runs after the emptiness checks).
  for (const who of [nada, abdelrhman])
    expect((await (await signIn(app, who.email, who.password)).get('/api/auth/me')).status).toBe(
      200,
    );
  const emptyResults = await getResults(pool, { sort: 'rank', dir: 'asc' });
  expect(emptyResults.official.teams).toEqual([]);
  expect(emptyResults.provisional).toEqual([]);
  expect(emptyResults.notRanked).toEqual([]);
  for (const kind of ['results', 'progress', 'evaluations', 'corrections', 'rubrics'] as const) {
    const report = await buildReport(pool, kind, {});
    expect(report.sheets[0]!.rows, kind).toHaveLength(0);
  }
  const log = readFileSync(join(dir, 'competition-maintenance', 'maintenance.jsonl'), 'utf8');
  expect(log.indexOf('reset.preview_backed_up')).toBeLessThan(
    log.indexOf('reset.execution_started'),
  );
  expect(log).toContain('reset.completed');
  expect(log).not.toContain(password);
  expect((await createDraft(pool, actor)).draft).not.toBeNull();
  // Turning maintenance off again (no maintenance options) disables the reset API entirely.
  const closed = createApp({
    environment: 'test',
    version: 'test',
    checkDatabase: async () => ({
      status: 'ok',
      database: TEST_DB,
      serverVersion: 'test',
      latencyMs: 0,
    }),
    auth: {
      pool,
      config: testAuthConfig,
      store: new MySqlSessionStore(pool, testAuthConfig.maxSessionMs),
    },
  });
  const again = await signIn(closed, email, password);
  expect((await again.get('/api/admin/competition')).body).toMatchObject({
    maintenanceAvailable: false,
    resetExecutionEnabled: false,
  });
  expect((await again.post('/api/admin/competition/reset/preview').send({ password })).status).toBe(
    503,
  );
});
