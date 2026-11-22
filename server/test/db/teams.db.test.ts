/**
 * Phase 4: teams, judge assignments and team import, tested against a real
 * (scratch) MySQL database through the real Express app.
 */
import bcrypt from 'bcryptjs';
import mysql, { type Connection, type Pool } from 'mysql2/promise';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addCriterion,
  addSection,
  connectTest,
  createDraft,
  dropDatabase,
  expectRefused,
  freshTestDatabase,
  publish,
  scalar,
  TEST_DB,
  testTarget,
} from './helpers.js';
import { makeTestApp, signIn } from './appHelpers.js';

const ADMIN = { email: 'youmna54@gmail.com', password: 'Admin-Password-2026!' };
const JUDGE = { email: 'judge@example.com', password: 'Judge-Password-2026!' };
const JUDGE2 = { email: 'judge2@example.com', password: 'Judge-Password-2026!' };

let pool: Pool;
let conn: Connection;
let app: ReturnType<typeof makeTestApp>;
let judgeId: number;
let judge2Id: number;
let admin: Awaited<ReturnType<typeof signIn>>;

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

async function newTeam(
  teamCode: string,
  name = `Team ${teamCode}`,
  projectName = `Project ${teamCode}`,
) {
  const res = await admin.post('/api/admin/teams').send({ teamCode, name, projectName });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.team.id as number;
}

async function publishedRubric() {
  const version = await createDraft(conn, { versionNo: 1 });
  const section = await addSection(conn, version, { position: 1 });
  await addCriterion(conn, version, section, { position: 1 });
  await publish(conn, version);
  return version;
}

const auditActions = async () => {
  const [rows] = await pool.query('SELECT action FROM audit_log ORDER BY id');
  return (rows as { action: string }[]).map((r) => r.action);
};

beforeAll(async () => {
  await freshTestDatabase();
  pool = mysql.createPool({ ...testTarget, connectionLimit: 8 });
  conn = await connectTest();
  app = makeTestApp(pool);
});

beforeEach(async () => {
  // TRUNCATE bypasses the triggers that protect real data (teams are never
  // deleted, the audit log is append-only). Test cleanup only.
  await pool.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of [
    'evaluation_scores',
    'evaluations',
    'team_judges',
    'teams',
    'rubric_criteria',
    'rubric_sections',
    'rubric_versions',
    'sessions',
    'users',
    'audit_log',
  ]) {
    await pool.query(`TRUNCATE TABLE ${t}`);
  }
  await pool.query('SET FOREIGN_KEY_CHECKS = 1');
  await insertUser(ADMIN.email, 'Youmna Admin', 'admin', ADMIN.password);
  judgeId = await insertUser(JUDGE.email, 'Judge One', 'judge', JUDGE.password);
  judge2Id = await insertUser(JUDGE2.email, 'Judge Two', 'judge', JUDGE2.password);
  admin = await signIn(app, ADMIN.email, ADMIN.password);
});

afterAll(async () => {
  await conn.end();
  await pool.end();
  await dropDatabase(TEST_DB);
});

describe('access control', () => {
  const endpoints = [
    ['get', '/api/admin/teams'],
    ['post', '/api/admin/teams'],
    ['get', '/api/admin/teams/1'],
    ['patch', '/api/admin/teams/1'],
    ['post', '/api/admin/teams/1/archive'],
    ['post', '/api/admin/teams/1/reactivate'],
    ['put', '/api/admin/teams/1/judges'],
    ['delete', '/api/admin/teams/1/judges/1'],
    ['post', '/api/admin/assignments/bulk'],
    ['get', '/api/admin/assignable-users'],
    ['post', '/api/admin/teams/import/preview'],
    ['post', '/api/admin/teams/import/commit'],
  ] as const;

  it('requires a session', async () => {
    for (const [method, path] of endpoints) {
      const res = await request(app)[method](path).send({});
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it('is refused to judges', async () => {
    const judge = await signIn(app, JUDGE.email, JUDGE.password);
    for (const [method, path] of endpoints) {
      const res = await judge[method](path).send({});
      expect(res.status, `${method} ${path}`).toBe(403);
    }
  });
});

describe('creating and editing teams', () => {
  it('creates a team, audits it, and shows it in the list', async () => {
    const id = await newTeam('AHL-001', 'Falcons', 'Smart Irrigation');
    const res = await admin.get(`/api/admin/teams/${id}`);
    expect(res.body.team).toMatchObject({
      id,
      teamCode: 'AHL-001',
      name: 'Falcons',
      projectName: 'Smart Irrigation',
      status: 'active',
      createdByEmail: ADMIN.email,
      assignments: [],
      pastEvaluations: [],
    });
    expect(await auditActions()).toContain('team.created');
  });

  it('refuses a duplicate Team ID, ignoring letter case and spaces around it', async () => {
    await newTeam('AHL-001');
    const res = await admin
      .post('/api/admin/teams')
      .send({ teamCode: '  ahl-001 ', name: 'Other', projectName: 'Other' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TEAM_CODE_TAKEN');
    expect(await scalar<number>(conn, 'SELECT COUNT(*) FROM teams')).toBe(1);
  });

  it('validates required fields, lengths, characters and unknown fields', async () => {
    const cases: Record<string, unknown>[] = [
      { teamCode: '', name: 'A', projectName: 'B' },
      { teamCode: 'A1', name: '   ', projectName: 'B' },
      { teamCode: 'A1', name: 'A', projectName: '' },
      { teamCode: 'x'.repeat(41), name: 'A', projectName: 'B' },
      { teamCode: 'A1', name: 'n'.repeat(201), projectName: 'B' },
      { teamCode: '<script>', name: 'A', projectName: 'B' },
      { teamCode: 'A1', name: 'A', projectName: 'B', governorate: 'Cairo' },
    ];
    for (const body of cases) {
      const res = await admin.post('/api/admin/teams').send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect(await scalar<number>(conn, 'SELECT COUNT(*) FROM teams')).toBe(0);
  });

  it('accepts Arabic names and Team IDs', async () => {
    const id = await newTeam('فريق-١', 'الصقور', 'الري الذكي');
    const res = await admin.get(`/api/admin/teams/${id}`);
    expect(res.body.team.name).toBe('الصقور');
  });

  it('edits a team, audits the changes, and refuses taking another team’s ID', async () => {
    const a = await newTeam('AHL-001');
    await newTeam('AHL-002');
    const edit = await admin
      .patch(`/api/admin/teams/${a}`)
      .send({ name: 'Renamed', teamCode: 'AHL-010' });
    expect(edit.status).toBe(200);
    expect(edit.body.team).toMatchObject({ name: 'Renamed', teamCode: 'AHL-010' });

    const [rows] = await pool.query(
      "SELECT details FROM audit_log WHERE action = 'team.updated' ORDER BY id DESC LIMIT 1",
    );
    const details = (rows as { details: unknown }[])[0]!.details;
    expect(JSON.stringify(details)).toContain('Renamed');

    const clash = await admin.patch(`/api/admin/teams/${a}`).send({ teamCode: 'ahl-002' });
    expect(clash.status).toBe(409);
    expect((await admin.patch(`/api/admin/teams/${a}`).send({})).status).toBe(400);
    expect((await admin.patch('/api/admin/teams/99999').send({ name: 'X' })).status).toBe(404);
  });
});

describe('archiving', () => {
  it('archives with a reason and reactivates, refusing a no-op', async () => {
    const id = await newTeam('AHL-001');
    const archived = await admin
      .post(`/api/admin/teams/${id}/archive`)
      .send({ reason: 'Withdrew from the competition' });
    expect(archived.status).toBe(200);
    expect(archived.body.team).toMatchObject({
      status: 'archived',
      archiveReason: 'Withdrew from the competition',
    });
    expect((await admin.post(`/api/admin/teams/${id}/archive`).send({})).status).toBe(409);

    const back = await admin.post(`/api/admin/teams/${id}/reactivate`).send({});
    expect(back.body.team).toMatchObject({ status: 'active', archivedAt: null });
    expect(await auditActions()).toEqual(
      expect.arrayContaining(['team.archived', 'team.reactivated']),
    );
  });

  it('never deletes a team at the database level', async () => {
    const id = await newTeam('AHL-001');
    await expectRefused(pool.query('DELETE FROM teams WHERE id = ?', [id]), /never deleted/);
  });
});

describe('listing', () => {
  beforeEach(async () => {
    await newTeam('AHL-003', 'Cobras', 'Water sensors');
    await newTeam('AHL-001', 'Falcons', 'Smart irrigation');
    await newTeam('AHL-002', 'Eagles', 'Solar_power 100%');
    const old = await newTeam('AHL-004', 'Lions', 'Recycling');
    await admin.post(`/api/admin/teams/${old}/archive`).send({});
  });

  const codes = (body: { teams: { teamCode: string }[] }) => body.teams.map((t) => t.teamCode);

  it('shows active teams by default, sorted by Team ID', async () => {
    const res = await admin.get('/api/admin/teams?status=active');
    expect(codes(res.body)).toEqual(['AHL-001', 'AHL-002', 'AHL-003']);
    expect(res.body.total).toBe(3);
    const archived = await admin.get('/api/admin/teams?status=archived');
    expect(codes(archived.body)).toEqual(['AHL-004']);
    const all = await admin.get('/api/admin/teams');
    expect(all.body.total).toBe(4);
  });

  it('searches Team ID, name and project, treating % and _ literally', async () => {
    expect(codes((await admin.get('/api/admin/teams?search=falc')).body)).toEqual(['AHL-001']);
    expect(codes((await admin.get('/api/admin/teams?search=sensors')).body)).toEqual(['AHL-003']);
    expect(codes((await admin.get('/api/admin/teams?search=AHL-00')).body)).toHaveLength(4);
    expect(codes((await admin.get('/api/admin/teams?search=100%25')).body)).toEqual(['AHL-002']);
    expect(codes((await admin.get('/api/admin/teams?search=r_p')).body)).toEqual(['AHL-002']);
    expect(codes((await admin.get('/api/admin/teams?search=%25')).body)).toEqual(['AHL-002']);
  });

  it('sorts and paginates', async () => {
    const byName = await admin.get('/api/admin/teams?status=active&sort=name&dir=desc');
    expect(codes(byName.body)).toEqual(['AHL-001', 'AHL-002', 'AHL-003']);
    const page1 = await admin.get('/api/admin/teams?pageSize=2&page=1');
    const page2 = await admin.get('/api/admin/teams?pageSize=2&page=2');
    expect(codes(page1.body)).toEqual(['AHL-001', 'AHL-002']);
    expect(codes(page2.body)).toEqual(['AHL-003', 'AHL-004']);
    expect(page2.body.total).toBe(4);
  });

  it('refuses unknown sort fields and filters', async () => {
    expect((await admin.get('/api/admin/teams?sort=password_hash')).status).toBe(400);
    expect((await admin.get('/api/admin/teams?governorate=1')).status).toBe(400);
    expect((await admin.get('/api/admin/teams?pageSize=1000')).status).toBe(400);
  });

  it('sorts by judge count', async () => {
    const [rows] = await pool.query("SELECT id FROM teams WHERE team_code = 'AHL-003'");
    const id = (rows as { id: number }[])[0]!.id;
    await admin.put(`/api/admin/teams/${id}/judges`).send({ judgeIds: [judgeId, judge2Id] });
    const res = await admin.get('/api/admin/teams?status=active&sort=assignedJudges&dir=desc');
    expect(codes(res.body)[0]).toBe('AHL-003');
    expect(res.body.teams[0].assignedJudges).toBe(2);
  });
});

describe('assigning judges', () => {
  it('assigns several judges to a team and one judge to several teams', async () => {
    const a = await newTeam('AHL-001');
    const b = await newTeam('AHL-002');
    const set = await admin
      .put(`/api/admin/teams/${a}/judges`)
      .send({ judgeIds: [judgeId, judge2Id] });
    expect(set.body).toEqual({ added: 2, removed: 0 });
    await admin.put(`/api/admin/teams/${b}/judges`).send({ judgeIds: [judgeId] });

    const details = await admin.get(`/api/admin/teams/${a}`);
    expect(details.body.team.assignments.map((x: { email: string }) => x.email).sort()).toEqual([
      JUDGE2.email,
      JUDGE.email,
    ]);
    expect(
      details.body.team.assignments.every(
        (x: { evaluationStatus: string }) => x.evaluationStatus === 'not_started',
      ),
    ).toBe(true);

    const users = await admin.get('/api/admin/users');
    const one = users.body.users.find((u: { id: number }) => u.id === judgeId);
    expect(one.assignedTeams).toBe(2);
  });

  it('never creates duplicate assignments', async () => {
    const a = await newTeam('AHL-001');
    await admin.put(`/api/admin/teams/${a}/judges`).send({ judgeIds: [judgeId, judgeId] });
    const again = await admin
      .post('/api/admin/assignments/bulk')
      .send({ teamIds: [a], judgeIds: [judgeId] });
    expect(again.body).toEqual({ added: 0, alreadyAssigned: 1 });
    expect(await scalar<number>(conn, 'SELECT COUNT(*) FROM team_judges')).toBe(1);
    await expectRefused(
      pool.query('INSERT INTO team_judges (team_id, judge_id) VALUES (?, ?)', [a, judgeId]),
      /ER_DUP_ENTRY/,
    );
  });

  it('bulk-assigns judges to many teams in one step', async () => {
    const ids = [await newTeam('AHL-001'), await newTeam('AHL-002'), await newTeam('AHL-003')];
    await admin.put(`/api/admin/teams/${ids[0]}/judges`).send({ judgeIds: [judgeId] });
    const res = await admin
      .post('/api/admin/assignments/bulk')
      .send({ teamIds: ids, judgeIds: [judgeId, judge2Id] });
    expect(res.body).toEqual({ added: 5, alreadyAssigned: 1 });
    expect(await scalar<number>(conn, 'SELECT COUNT(*) FROM team_judges')).toBe(6);
    const added = (await auditActions()).filter((a) => a === 'assignment.added');
    expect(added).toHaveLength(6);
  });

  it('refuses disabled accounts and archived teams, in the API and in the database', async () => {
    const a = await newTeam('AHL-001');
    const b = await newTeam('AHL-002');
    await pool.query("UPDATE users SET status = 'disabled' WHERE id = ?", [judge2Id]);
    const disabled = await admin
      .post('/api/admin/assignments/bulk')
      .send({ teamIds: [a], judgeIds: [judgeId, judge2Id] });
    expect(disabled.status).toBe(409);
    expect(disabled.body.error.code).toBe('ACCOUNT_DISABLED');
    // All or nothing: the active judge was not assigned either.
    expect(await scalar<number>(conn, 'SELECT COUNT(*) FROM team_judges')).toBe(0);

    await admin.post(`/api/admin/teams/${b}/archive`).send({});
    const archived = await admin
      .post('/api/admin/assignments/bulk')
      .send({ teamIds: [a, b], judgeIds: [judgeId] });
    expect(archived.status).toBe(409);
    expect(archived.body.error.code).toBe('TEAM_ARCHIVED');

    await expectRefused(
      pool.query('INSERT INTO team_judges (team_id, judge_id) VALUES (?, ?)', [a, judge2Id]),
      /Disabled accounts/,
    );
    await expectRefused(
      pool.query('INSERT INTO team_judges (team_id, judge_id) VALUES (?, ?)', [b, judgeId]),
      /Archived teams/,
    );
    const missing = await admin
      .post('/api/admin/assignments/bulk')
      .send({ teamIds: [a], judgeIds: [99999] });
    expect(missing.status).toBe(404);
  });

  it('keeps assignments when a team is archived', async () => {
    const a = await newTeam('AHL-001');
    await admin.put(`/api/admin/teams/${a}/judges`).send({ judgeIds: [judgeId] });
    await admin.post(`/api/admin/teams/${a}/archive`).send({});
    expect(await scalar<number>(conn, 'SELECT COUNT(*) FROM team_judges')).toBe(1);
  });

  it('unassigns a judge, keeping the evaluation and showing it as past history', async () => {
    const version = await publishedRubric();
    const a = await newTeam('AHL-001');
    await admin.put(`/api/admin/teams/${a}/judges`).send({ judgeIds: [judgeId, judge2Id] });
    await pool.query(
      'INSERT INTO evaluations (team_id, judge_id, rubric_version_id) VALUES (?, ?, ?)',
      [a, judgeId, version],
    );
    const listed = await admin.get('/api/admin/teams');
    expect(listed.body.teams[0]).toMatchObject({ assignedJudges: 2, draftEvaluations: 1 });

    const res = await admin.delete(`/api/admin/teams/${a}/judges/${judgeId}`);
    expect(res.status).toBe(204);
    expect(await scalar<number>(conn, 'SELECT COUNT(*) FROM evaluations')).toBe(1);

    const details = await admin.get(`/api/admin/teams/${a}`);
    expect(details.body.team.assignments).toHaveLength(1);
    expect(details.body.team.pastEvaluations).toEqual([
      expect.objectContaining({ email: JUDGE.email, evaluationStatus: 'draft' }),
    ]);
    // Progress counts only judges still assigned.
    const after = await admin.get('/api/admin/teams');
    expect(after.body.teams[0]).toMatchObject({ assignedJudges: 1, draftEvaluations: 0 });

    const [rows] = await pool.query(
      "SELECT details FROM audit_log WHERE action = 'assignment.removed'",
    );
    expect(JSON.stringify((rows as { details: unknown }[])[0]!.details)).toContain('draft');
    expect((await admin.delete(`/api/admin/teams/${a}/judges/${judgeId}`)).status).toBe(404);
  });
});

describe('what judges see', () => {
  it('shows a judge only their own active teams, with the assignment date', async () => {
    const a = await newTeam('AHL-001');
    const b = await newTeam('AHL-002');
    const c = await newTeam('AHL-003');
    await admin.post('/api/admin/assignments/bulk').send({ teamIds: [a, b], judgeIds: [judgeId] });
    await admin.put(`/api/admin/teams/${c}/judges`).send({ judgeIds: [judge2Id] });
    await admin.post(`/api/admin/teams/${b}/archive`).send({});

    const judge = await signIn(app, JUDGE.email, JUDGE.password);
    const res = await judge.get('/api/judge/assignments');
    expect(res.status).toBe(200);
    expect(res.body.assignments).toEqual([
      expect.objectContaining({
        teamCode: 'AHL-001',
        evaluationStatus: 'not_started',
        assignedAt: expect.any(String),
      }),
    ]);
  });
});

describe('import', () => {
  const row = (
    rowNumber: number,
    teamCode: string,
    name = `Team ${teamCode}`,
    projectName = 'P',
  ) => ({
    rowNumber,
    teamCode,
    name,
    projectName,
  });

  it('previews without writing anything', async () => {
    await newTeam('AHL-001', 'Falcons', 'P');
    const res = await admin.post('/api/admin/teams/import/preview').send({
      rows: [
        row(2, 'AHL-001', 'Falcons'),
        row(3, 'AHL-002'),
        row(4, 'AHL-003'),
        row(5, 'ahl-003', 'Same ID, other case'),
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.rows.map((r: { action: string }) => r.action)).toEqual([
      'unchanged',
      'create',
      'error',
      'error',
    ]);
    // Both copies of a repeated Team ID are flagged, naming the rows.
    expect(res.body.rows[3].errors.join(' ')).toMatch(/rows 4, 5/);
    expect(res.body.summary).toEqual({ create: 1, update: 0, unchanged: 1, error: 2 });
    expect(await scalar<number>(conn, 'SELECT COUNT(*) FROM teams')).toBe(1);
  });

  it('reports row-level validation errors and refuses to commit any of the file', async () => {
    const rows = [row(2, 'AHL-001'), row(3, '', 'No ID'), row(4, 'AHL-003', '')];
    const preview = await admin.post('/api/admin/teams/import/preview').send({ rows });
    expect(preview.body.summary).toEqual({ create: 1, update: 0, unchanged: 0, error: 2 });
    expect(preview.body.rows[1].errors[0]).toMatch(/Team ID/);

    const commit = await admin.post('/api/admin/teams/import/commit').send({ rows });
    expect(commit.status).toBe(400);
    expect(commit.body.error.code).toBe('IMPORT_INVALID');
    expect(commit.body.preview.summary.error).toBe(2);
    expect(await scalar<number>(conn, 'SELECT COUNT(*) FROM teams')).toBe(0);
  });

  it('creates new teams and audits the import', async () => {
    const res = await admin
      .post('/api/admin/teams/import/commit')
      .send({ rows: [row(2, 'AHL-001'), row(3, 'AHL-002')] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ created: 2, updated: 0, unchanged: 0 });
    const actions = await auditActions();
    expect(actions.filter((a) => a === 'team.created')).toHaveLength(2);
    expect(actions).toContain('team.import');
  });

  it('needs explicit confirmation before updating existing teams', async () => {
    const id = await newTeam('AHL-001', 'Old name', 'Old project');
    const rows = [row(2, 'ahl-001', 'New name', 'Old project'), row(3, 'AHL-002')];
    const refused = await admin.post('/api/admin/teams/import/commit').send({ rows });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('UPDATE_CONFIRMATION_REQUIRED');
    expect(await scalar<number>(conn, 'SELECT COUNT(*) FROM teams')).toBe(1);

    const ok = await admin
      .post('/api/admin/teams/import/commit')
      .send({ rows, confirmUpdates: true });
    expect(ok.body).toEqual({ created: 1, updated: 1, unchanged: 0 });
    const team = (await admin.get(`/api/admin/teams/${id}`)).body.team;
    // The existing Team ID keeps its original letter case.
    expect(team).toMatchObject({
      teamCode: 'AHL-001',
      name: 'New name',
      projectName: 'Old project',
    });
  });

  it('rolls back the whole file if any write fails part-way', async () => {
    await pool.query(`CREATE TRIGGER trg_test_fail_import BEFORE INSERT ON teams FOR EACH ROW
      BEGIN IF NEW.team_code = 'BOOM' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'test failure'; END IF; END`);
    try {
      const res = await admin
        .post('/api/admin/teams/import/commit')
        .send({ rows: [row(2, 'AHL-001'), row(3, 'AHL-002'), row(4, 'BOOM')] });
      expect(res.status).toBe(500);
      expect(await scalar<number>(conn, 'SELECT COUNT(*) FROM teams')).toBe(0);
      expect(await auditActions()).not.toContain('team.import');
    } finally {
      await pool.query('DROP TRIGGER trg_test_fail_import');
    }
  });

  it('refuses empty and oversized files', async () => {
    const empty = await admin.post('/api/admin/teams/import/preview').send({ rows: [] });
    expect(empty.status).toBe(400);
    const big = Array.from({ length: 2001 }, (_, i) => row(i + 2, `T${i}`));
    const tooBig = await admin.post('/api/admin/teams/import/preview').send({ rows: big });
    expect(tooBig.status).toBe(400);
  });

  it('warns when an imported row matches an archived team', async () => {
    const id = await newTeam('AHL-001', 'Falcons', 'P');
    await admin.post(`/api/admin/teams/${id}/archive`).send({});
    const res = await admin
      .post('/api/admin/teams/import/preview')
      .send({ rows: [row(2, 'AHL-001', 'Falcons', 'P')] });
    expect(res.body.rows[0].warnings.join(' ')).toMatch(/archived/i);
  });
});
