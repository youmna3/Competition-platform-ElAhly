import { testMysql as mysql } from './helpers.js';
/**
 * Phase 6: judge evaluations through the real API and a real (scratch) MySQL
 * database. Starting, autosaved drafts, scoring, submission and locking,
 * concurrency, access rules, admins as judges, rubric versions and audit.
 */
import bcrypt from 'bcryptjs';
import { type Pool, type RowDataPacket } from 'mysql2/promise';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  EvaluationDetail,
  JudgeEvaluationResponse,
  RubricContent,
  RubricVersion,
} from '@judging/shared';
import {
  dropDatabase,
  expectRefused,
  freshTestDatabase,
  scalar,
  TEST_DB,
  testTarget,
} from './helpers.js';
import { makeTestApp, signIn } from './appHelpers.js';

const PASSWORD = 'Strong-Password-2026!';
type Agent = Awaited<ReturnType<typeof signIn>>;

let pool: Pool;
let app: ReturnType<typeof makeTestApp>;
let admin: Agent;
let judge: Agent;
let judge2: Agent;
let adminId: number;
let judgeId: number;
let judge2Id: number;
let teamA: number;
let teamB: number;

async function insertUser(email: string, role: 'admin' | 'judge') {
  const [r] = await pool.query(
    'INSERT INTO users (email, full_name, password_hash, role, must_change_password) VALUES (?, ?, ?, ?, FALSE)',
    [email, email.split('@')[0], bcrypt.hashSync(PASSWORD, 4), role],
  );
  return (r as { insertId: number }).insertId;
}

function rubricContent(weights: number[], title = 'Final rubric'): RubricContent {
  return {
    title,
    description: '',
    instructions: 'Rate fairly.',
    sections: ['Idea', 'Execution', 'Presentation', 'Teamwork'].map((name, i) => ({
      title: name,
      description: '',
      weightPercent: weights[i]!,
      criteria: [
        { title: `${name} A`, description: '', guidelines: '' },
        { title: `${name} B`, description: '', guidelines: '' },
      ],
    })),
  };
}

async function publishRubric(weights = [30, 30, 20, 20], title?: string): Promise<RubricVersion> {
  // Legacy fixture imports deliberately span historical versions.
  await pool.query(
    "UPDATE competition SET state='preparation',locked_rubric_version_id=NULL WHERE id=1",
  );
  const state = (await admin.get('/api/admin/rubric')).body;
  const draft = state.draft ?? (await admin.post('/api/admin/rubric/draft').send({})).body.draft;
  const saved = await admin
    .put('/api/admin/rubric/draft')
    .send({ revision: draft.revision, content: rubricContent(weights, title) });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  const res = await admin
    .post('/api/admin/rubric/draft/publish')
    .send({ revision: saved.body.draft.revision, confirmExistingEvaluations: true });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  await pool.query(
    "UPDATE competition c JOIN rubric r ON r.id=c.id SET c.state='judging_open',c.locked_rubric_version_id=r.published_version_id WHERE c.id=1",
  );
  return res.body.published;
}

async function assign(teamIds: number[], judgeIds: number[]) {
  const res = await admin.post('/api/admin/assignments/bulk').send({ teamIds, judgeIds });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

async function open(agent: Agent, teamId: number) {
  return (await agent.get(`/api/judge/teams/${teamId}/evaluation`)).body as JudgeEvaluationResponse;
}

async function start(agent: Agent, teamId: number) {
  const res = await agent.post(`/api/judge/teams/${teamId}/evaluation`).send({});
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.evaluation as EvaluationDetail;
}

/** Ratings in rubric order (8 values, null = not rated). */
function payload(
  e: EvaluationDetail,
  stars: (number | null)[],
  extra: Partial<{ notes: string; overall: string }> = {},
) {
  return {
    rowVersion: e.rowVersion,
    ratings: e.ratings.map((r, i) => ({
      criterionId: r.criterionId,
      rating: stars[i] ?? null,
      note: extra.notes ?? '',
    })),
    sectionNotes: e.sectionNotes.map((n) => ({ sectionId: n.sectionId, note: '' })),
    overallNotes: extra.overall ?? '',
  };
}

async function save(agent: Agent, e: EvaluationDetail, stars: (number | null)[], extra = {}) {
  return agent.put(`/api/judge/evaluations/${e.id}`).send(payload(e, stars, extra));
}

const auditCount = async (action: string) =>
  scalar<number>(pool, 'SELECT COUNT(*) FROM audit_log WHERE action = ?', [action]);

beforeAll(async () => {
  await freshTestDatabase();
  pool = mysql.createPool({ ...testTarget, connectionLimit: 12 });
  app = makeTestApp(pool);
});

beforeEach(async () => {
  await pool.query(
    "UPDATE competition SET state='preparation',locked_rubric_version_id=NULL WHERE id=1",
  );
  await pool.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of [
    'evaluation_events',
    'evaluation_section_notes',
    'evaluation_scores',
    'evaluations',
    'team_judges',
    'teams',
    'rubric_scale_levels',
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
  // Reset the single rubric row (its trigger refuses unpublishing; test cleanup only).
  await pool.query('DROP TRIGGER IF EXISTS trg_rubric_before_update');
  await pool.query(
    'UPDATE rubric SET published_version_id = NULL, draft_version_id = NULL WHERE id = 1',
  );
  await pool.query(`CREATE TRIGGER trg_rubric_before_update BEFORE UPDATE ON rubric FOR EACH ROW
    BEGIN
      IF NEW.published_version_id IS NOT NULL
         AND (SELECT status FROM rubric_versions WHERE id = NEW.published_version_id) <> 'published' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'The active rubric must point at a published version';
      END IF;
      IF NEW.draft_version_id IS NOT NULL
         AND (SELECT status FROM rubric_versions WHERE id = NEW.draft_version_id) <> 'draft' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'The rubric draft must point at a draft version';
      END IF;
      IF OLD.published_version_id IS NOT NULL AND NEW.published_version_id IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'A published rubric cannot be unpublished';
      END IF;
    END`);
  adminId = await insertUser('youmna54@gmail.com', 'admin');
  judgeId = await insertUser('judge@example.com', 'judge');
  judge2Id = await insertUser('judge2@example.com', 'judge');
  admin = await signIn(app, 'youmna54@gmail.com', PASSWORD);
  judge = await signIn(app, 'judge@example.com', PASSWORD);
  judge2 = await signIn(app, 'judge2@example.com', PASSWORD);
  const [t] = await pool.query(
    "INSERT INTO teams (team_code, name, project_name) VALUES ('AHL-1', 'Falcons', 'Irrigation'), ('AHL-2', 'Eagles', 'Solar')",
  );
  teamA = (t as { insertId: number }).insertId;
  teamB = teamA + 1;
});

afterAll(async () => {
  await pool.end();
  await dropDatabase(TEST_DB);
});

describe('access', () => {
  it('requires a session', async () => {
    for (const [method, path] of [
      ['get', `/api/judge/teams/${teamA}/evaluation`],
      ['post', `/api/judge/teams/${teamA}/evaluation`],
      ['put', '/api/judge/evaluations/1'],
      ['post', '/api/judge/evaluations/1/submit'],
    ] as const) {
      expect((await request(app)[method](path).send({})).status, path).toBe(401);
    }
  });

  it('only opens teams assigned to the judge, and never another judge’s evaluation', async () => {
    await publishRubric();
    await assign([teamA], [judgeId]);
    expect((await judge.get(`/api/judge/teams/${teamB}/evaluation`)).status).toBe(404);
    expect((await judge.post(`/api/judge/teams/${teamB}/evaluation`).send({})).status).toBe(404);
    expect((await judge2.get(`/api/judge/teams/${teamA}/evaluation`)).status).toBe(404);

    const mine = await start(judge, teamA);
    // judge2 knows the id but it is not theirs.
    expect((await save(judge2, mine, [5])).status).toBe(404);
    expect(
      (
        await judge2
          .post(`/api/judge/evaluations/${mine.id}/submit`)
          .send({ rowVersion: mine.rowVersion })
      ).status,
    ).toBe(404);
    expect((await judge.get('/api/judge/assignments')).body.assignments).toHaveLength(1);
  });

  it('cannot start before the rubric is published', async () => {
    await assign([teamA], [judgeId]);
    const view = await open(judge, teamA);
    expect(view).toMatchObject({ rubric: null, evaluation: null, canEdit: false });
    const res = await judge.post(`/api/judge/teams/${teamA}/evaluation`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('COMPETITION_LOCKED');
  });
});

describe('starting and saving drafts', () => {
  it('starts once, pinned to the published version, with every criterion unrated', async () => {
    const v1 = await publishRubric();
    await assign([teamA], [judgeId]);
    const before = await open(judge, teamA);
    expect(before).toMatchObject({ evaluation: null, canEdit: true });
    expect(before.rubric!.versionNo).toBe(1);

    const e = await start(judge, teamA);
    expect(e).toMatchObject({
      status: 'draft',
      rubricVersionId: v1.id,
      ratedCount: 0,
      requiredCount: 8,
      totalScore: 0,
    });
    expect(e.ratings).toHaveLength(8);
    expect(e.ratings.every((r) => r.rating === null)).toBe(true);
    expect(e.sectionNotes).toHaveLength(4);

    const again = await start(judge, teamA);
    expect(again.id).toBe(e.id);
    expect(await auditCount('evaluation.started')).toBe(1);
  });

  it('creates a single evaluation when two tabs press Start at once', async () => {
    await publishRubric();
    await assign([teamA], [judgeId]);
    const results = await Promise.all(
      [1, 2, 3].map(() => judge.post(`/api/judge/teams/${teamA}/evaluation`).send({})),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => r.body.evaluation.id)).size).toBe(1);
    expect(await scalar<number>(pool, 'SELECT COUNT(*) FROM evaluations')).toBe(1);
  });

  it('saves an incomplete draft with notes, recomputing the score on the server', async () => {
    await publishRubric([30, 30, 20, 20]);
    await assign([teamA], [judgeId]);
    const e = await start(judge, teamA);
    const res = await save(judge, e, [4, 5, 3], { notes: 'Good start', overall: 'Promising team' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const saved = res.body.evaluation as EvaluationDetail;
    expect(saved).toMatchObject({
      ratedCount: 3,
      totalScore: 27,
      rowVersion: e.rowVersion + 1,
      overallNotes: 'Promising team',
    });
    expect(saved.ratings.slice(0, 3).map((r) => [r.rating, r.note])).toEqual([
      [4, 'Good start'],
      [5, 'Good start'],
      [3, 'Good start'],
    ]);

    // Continue later: the draft comes back exactly.
    const reopened = await open(judge, teamA);
    expect(reopened.evaluation).toMatchObject({
      ratedCount: 3,
      totalScore: 27,
      overallNotes: 'Promising team',
    });
    expect((await judge.get('/api/judge/assignments')).body.assignments[0]).toMatchObject({
      evaluationStatus: 'draft',
      ratedCount: 3,
      totalScore: null,
    });
  });

  it('never accepts totals from the browser and validates every rating', async () => {
    await publishRubric();
    await assign([teamA], [judgeId]);
    const e = await start(judge, teamA);
    const base = payload(e, [5]);
    const withTotal = await judge
      .put(`/api/judge/evaluations/${e.id}`)
      .send({ ...base, totalScore: 100 });
    expect(withTotal.status).toBe(400);

    for (const bad of [0, 6, 2.5, -1]) {
      const res = await save(judge, e, [bad]);
      expect(res.status, String(bad)).toBe(400);
      expect(res.body.error.code).toBe('EVALUATION_INVALID');
    }
    const foreign = payload(e, []);
    foreign.ratings[0]!.criterionId = 999_999;
    expect((await judge.put(`/api/judge/evaluations/${e.id}`).send(foreign)).status).toBe(400);
    const twice = payload(e, []);
    twice.ratings[1]!.criterionId = twice.ratings[0]!.criterionId;
    expect((await judge.put(`/api/judge/evaluations/${e.id}`).send(twice)).status).toBe(400);
    const longNote = payload(e, [], { notes: 'x'.repeat(2001) });
    expect((await judge.put(`/api/judge/evaluations/${e.id}`).send(longNote)).status).toBe(400);
    expect((await open(judge, teamA)).evaluation).toMatchObject({
      ratedCount: 0,
      rowVersion: e.rowVersion,
    });
  });

  it('refuses a save from a stale tab instead of overwriting, returning the stored version', async () => {
    await publishRubric();
    await assign([teamA], [judgeId]);
    const e = await start(judge, teamA);
    const tab1 = await save(judge, e, [5, 5]);
    expect(tab1.status).toBe(200);
    const tab2 = await save(judge, e, [1, 1]); // still has the old row version
    expect(tab2.status).toBe(409);
    expect(tab2.body.error.code).toBe('EVALUATION_CONFLICT');
    expect(
      tab2.body.evaluation.ratings.slice(0, 2).map((r: { rating: number }) => r.rating),
    ).toEqual([5, 5]);
    // Choosing to keep tab 2's changes means saving again with the current version.
    const keep = await save(judge, tab2.body.evaluation, [1, 1]);
    expect(keep.status).toBe(200);
  });

  it('rolls back a save that fails part-way, leaving the draft as it was', async () => {
    await publishRubric();
    await assign([teamA], [judgeId]);
    const e = await start(judge, teamA);
    const first = (await save(judge, e, [3, 3])).body.evaluation as EvaluationDetail;
    await pool.query(`CREATE TRIGGER trg_test_fail_note BEFORE UPDATE ON evaluation_section_notes FOR EACH ROW
      BEGIN IF NEW.note = 'BOOM' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'test failure'; END IF; END`);
    try {
      const body = payload(first, [5, 5, 5]);
      body.sectionNotes[0]!.note = 'BOOM';
      const res = await judge.put(`/api/judge/evaluations/${e.id}`).send(body);
      expect(res.status).toBe(500);
    } finally {
      await pool.query('DROP TRIGGER trg_test_fail_note');
    }
    const after = (await open(judge, teamA)).evaluation!;
    expect(after.rowVersion).toBe(first.rowVersion);
    expect(after.ratings.slice(0, 3).map((r) => r.rating)).toEqual([3, 3, null]);
  });
});

describe('submitting', () => {
  it('refuses to submit until all eight criteria are rated, naming the missing ones', async () => {
    await publishRubric();
    await assign([teamA], [judgeId]);
    const e = await start(judge, teamA);
    const saved = (await save(judge, e, [5, 5, 5, 5, 5, 5, 5])).body.evaluation as EvaluationDetail;
    const res = await judge
      .post(`/api/judge/evaluations/${e.id}/submit`)
      .send({ rowVersion: saved.rowVersion });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('EVALUATION_INCOMPLETE');
    expect(res.body.missingCriteria).toEqual([saved.ratings[7]!.criterionId]);
    expect((await open(judge, teamA)).evaluation!.status).toBe('draft');
  });

  it('submits, recomputes the weighted score, locks it and records it', async () => {
    await publishRubric([35, 25, 25, 15]);
    await assign([teamA], [judgeId]);
    const e = await start(judge, teamA);
    // 3.5/5×35 = 24.5, 5/5×25 = 25, 2.5/5×25 = 12.5, 2.5/5×15 = 7.5 → 69.5
    const saved = (await save(judge, e, [3, 4, 5, 5, 2, 3, 1, 4])).body
      .evaluation as EvaluationDetail;
    expect(saved.totalScore).toBe(69.5);
    // Tamper with the stored total: submission recomputes it anyway.
    await pool.query('UPDATE evaluations SET total_score = 99 WHERE id = ?', [e.id]);
    const res = await judge
      .post(`/api/judge/evaluations/${e.id}/submit`)
      .send({ rowVersion: saved.rowVersion });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      alreadySubmitted: false,
      evaluation: { status: 'submitted', totalScore: 69.5, ratedCount: 8 },
    });
    expect(res.body.evaluation.submittedAt).toEqual(expect.any(String));

    // Locked: no further saves, by the API or directly in the database.
    const later = await save(judge, res.body.evaluation, [1, 1, 1, 1, 1, 1, 1, 1]);
    expect(later.status).toBe(409);
    expect(later.body.error.code).toBe('EVALUATION_LOCKED');
    await expectRefused(
      pool.query('UPDATE evaluation_scores SET score = 1 WHERE evaluation_id = ?', [e.id]),
      /locked/,
    );
    const view = await open(judge, teamA);
    expect(view).toMatchObject({
      canEdit: false,
      evaluation: { status: 'submitted', totalScore: 69.5 },
    });
    expect((await judge.get('/api/judge/assignments')).body.assignments[0]).toMatchObject({
      evaluationStatus: 'submitted',
      totalScore: 69.5,
    });
    const [audit] = await pool.query<RowDataPacket[]>(
      "SELECT details FROM audit_log WHERE action = 'evaluation.submitted'",
    );
    const details =
      typeof audit[0]!.details === 'string' ? JSON.parse(audit[0]!.details) : audit[0]!.details;
    expect(details).toMatchObject({ team_code: 'AHL-1', total_score: 69.5, rubric_version_no: 1 });
  });

  it('never submits twice, whether clicked twice or sent in parallel', async () => {
    await publishRubric();
    await assign([teamA], [judgeId]);
    const e = await start(judge, teamA);
    const saved = (await save(judge, e, [5, 5, 5, 5, 5, 5, 5, 5])).body
      .evaluation as EvaluationDetail;
    const results = await Promise.all(
      [1, 2, 3, 4].map(() =>
        judge.post(`/api/judge/evaluations/${e.id}/submit`).send({ rowVersion: saved.rowVersion }),
      ),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.body.alreadySubmitted === false)).toHaveLength(1);
    expect(results.every((r) => r.body.evaluation.totalScore === 100)).toBe(true);
    expect(await auditCount('evaluation.submitted')).toBe(1);
  });
});

describe('administrators as judges', () => {
  it('evaluate only teams assigned to them, with exactly the same rules', async () => {
    await publishRubric();
    expect((await admin.post(`/api/judge/teams/${teamA}/evaluation`).send({})).status).toBe(404);
    await assign([teamA], [adminId, judgeId]);
    const mine = await start(admin, teamA);
    const incomplete = (await save(admin, mine, [5, 5])).body.evaluation as EvaluationDetail;
    const early = await admin
      .post(`/api/judge/evaluations/${mine.id}/submit`)
      .send({ rowVersion: incomplete.rowVersion });
    expect(early.status).toBe(400);
    const full = (await save(admin, incomplete, [5, 5, 4, 4, 3, 3, 2, 2])).body
      .evaluation as EvaluationDetail;
    const done = await admin
      .post(`/api/judge/evaluations/${mine.id}/submit`)
      .send({ rowVersion: full.rowVersion });
    expect(done.body.evaluation.totalScore).toBe(30 + 24 + 12 + 8);
    expect((await save(admin, done.body.evaluation, [1])).status).toBe(409); // locked for admins too

    // An admin cannot touch a judge's evaluation through the judging API.
    const theirs = await start(judge, teamA);
    expect((await save(admin, theirs, [1])).status).toBe(404);
    expect((await admin.get('/api/judge/assignments')).body.assignments[0]).toMatchObject({
      teamCode: 'AHL-1',
      evaluationStatus: 'submitted',
    });
  });
});

describe('archived teams, disabled accounts and assignment changes', () => {
  it('blocks new evaluations and draft edits for archived teams, keeping what exists', async () => {
    await publishRubric();
    await assign([teamA, teamB], [judgeId]);
    const draft = await start(judge, teamA);
    await admin.post(`/api/admin/teams/${teamA}/archive`).send({});
    await admin.post(`/api/admin/teams/${teamB}/archive`).send({});

    const startB = await judge.post(`/api/judge/teams/${teamB}/evaluation`).send({});
    expect(startB.status).toBe(409);
    expect(startB.body.error.code).toBe('TEAM_ARCHIVED');
    expect((await save(judge, draft, [5])).status).toBe(409);
    expect((await open(judge, teamA)).canEdit).toBe(false);
    expect(await scalar<number>(pool, 'SELECT COUNT(*) FROM evaluations')).toBe(1);
    // The database refuses it too.
    const [v] = await pool.query<RowDataPacket[]>('SELECT published_version_id FROM rubric');
    await expectRefused(
      pool.query(
        'INSERT INTO evaluations (team_id, judge_id, rubric_version_id) VALUES (?, ?, ?)',
        [teamB, judge2Id, v[0]!.published_version_id],
      ),
      /Archived teams cannot receive new evaluations/,
    );
  });

  it('stops disabled accounts, in the API and in the database', async () => {
    await publishRubric();
    await assign([teamA], [judgeId, judge2Id]);
    await admin.patch(`/api/admin/users/${judgeId}`).send({ status: 'disabled' });
    expect((await judge.post(`/api/judge/teams/${teamA}/evaluation`).send({})).status).toBe(401);
    const [v] = await pool.query<RowDataPacket[]>('SELECT published_version_id FROM rubric');
    await expectRefused(
      pool.query(
        'INSERT INTO evaluations (team_id, judge_id, rubric_version_id) VALUES (?, ?, ?)',
        [teamA, judgeId, v[0]!.published_version_id],
      ),
      /Disabled accounts cannot evaluate/,
    );
  });

  it('keeps evaluations when a judge is unassigned, and protects submitted ones', async () => {
    await publishRubric();
    await assign([teamA], [judgeId, judge2Id]);
    const submitted = await start(judge, teamA);
    const full = (await save(judge, submitted, [4, 4, 4, 4, 4, 4, 4, 4])).body
      .evaluation as EvaluationDetail;
    await judge
      .post(`/api/judge/evaluations/${submitted.id}/submit`)
      .send({ rowVersion: full.rowVersion });
    const draft = await start(judge2, teamA);

    await admin.delete(`/api/admin/teams/${teamA}/judges/${judgeId}`);
    await admin.delete(`/api/admin/teams/${teamA}/judges/${judge2Id}`);
    expect((await judge.get(`/api/judge/teams/${teamA}/evaluation`)).status).toBe(404);
    expect((await save(judge2, draft, [5])).status).toBe(404);
    expect(await scalar<number>(pool, 'SELECT COUNT(*) FROM evaluations')).toBe(2);

    const details = (await admin.get(`/api/admin/teams/${teamA}`)).body.team;
    expect(details.pastEvaluations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          judgeId,
          evaluationStatus: 'submitted',
          totalScore: 80,
          rubricVersionNo: 1,
        }),
        expect.objectContaining({ judgeId: judge2Id, evaluationStatus: 'draft', totalScore: null }),
      ]),
    );

    // Reassigned: the judge sees their own submitted evaluation again, unchanged.
    await assign([teamA], [judgeId]);
    expect((await open(judge, teamA)).evaluation).toMatchObject({
      id: submitted.id,
      status: 'submitted',
      totalScore: 80,
    });
  });
});

describe('rubric versions', () => {
  it('keeps an evaluation on its version and weights, warns, and flags mixed versions for the admin', async () => {
    const v1 = await publishRubric([30, 30, 20, 20]);
    await assign([teamA], [judgeId, judge2Id]);
    const old = await start(judge, teamA);
    await publishRubric([10, 50, 20, 20], 'Revised rubric');

    const view = await open(judge, teamA);
    expect(view.rubric!.id).toBe(v1.id);
    expect(view.publishedVersionNo).toBe(2);
    expect(view.canEdit).toBe(true);

    // Scored with version 1's weights: 4★+5★ in a 30% section = 27.
    const saved = (await save(judge, old, [4, 5, 5, 5, 5, 5, 5, 5])).body
      .evaluation as EvaluationDetail;
    expect(saved.totalScore).toBe(27 + 30 + 20 + 20);
    const done = await judge
      .post(`/api/judge/evaluations/${old.id}/submit`)
      .send({ rowVersion: saved.rowVersion });
    expect(done.body.evaluation).toMatchObject({ rubricVersionNo: 1, totalScore: 97 });

    const fresh = await start(judge2, teamA);
    expect(fresh.rubricVersionNo).toBe(2);

    expect((await judge.get('/api/judge/assignments')).body.assignments[0]).toMatchObject({
      outdatedVersion: true,
      rubricVersionNo: 1,
    });
    const list = (await admin.get('/api/admin/teams')).body.teams;
    expect(list[0]).toMatchObject({
      teamCode: 'AHL-1',
      mixedVersions: true,
      submittedEvaluations: 1,
      draftEvaluations: 1,
    });
    const details = (await admin.get(`/api/admin/teams/${teamA}`)).body.team;
    const byJudge = Object.fromEntries(
      details.assignments.map((a: { judgeId: number }) => [a.judgeId, a]),
    );
    expect(byJudge[judgeId]).toMatchObject({
      outdatedVersion: true,
      rubricVersionNo: 1,
      totalScore: 97,
      ratedCount: 8,
    });
    expect(byJudge[judge2Id]).toMatchObject({
      outdatedVersion: false,
      rubricVersionNo: 2,
      ratedCount: 0,
    });
  });
});
