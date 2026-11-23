import { testMysql as mysql } from './helpers.js';
/**
 * Phase 7: administrator review of evaluations, through the real API and a
 * real (scratch) MySQL database. Listing and filters, read-only review,
 * history and snapshots, reopening and resubmission, judge progress, mixed
 * rubric versions, access rules, audit consistency and concurrency.
 */
import bcrypt from 'bcryptjs';
import { type Pool, type RowDataPacket } from 'mysql2/promise';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  AdminEvaluationDetail,
  AdminEvaluationsResponse,
  EvaluationDetail,
  EvaluationEvent,
  JudgeProgressRow,
  RubricContent,
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
let admin2: Agent;
let judge: Agent;
let judge2: Agent;
let adminId: number;
let judgeId: number;
let judge2Id: number;
let teamA: number;
let teamB: number;
let teamC: number;

async function insertUser(email: string, role: 'admin' | 'judge', name: string) {
  const [r] = await pool.query(
    'INSERT INTO users (email, full_name, password_hash, role, must_change_password) VALUES (?, ?, ?, ?, FALSE)',
    [email, name, bcrypt.hashSync(PASSWORD, 4), role],
  );
  return (r as { insertId: number }).insertId;
}

function rubricContent(weights: number[], title = 'Final rubric'): RubricContent {
  return {
    title,
    description: '',
    instructions: '',
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

async function publishRubric(weights = [30, 30, 20, 20], title?: string) {
  // Legacy fixture imports deliberately span historical versions.
  await pool.query(
    "UPDATE competition SET state='preparation',locked_rubric_version_id=NULL WHERE id=1",
  );
  const state = (await admin.get('/api/admin/rubric')).body;
  const draft = state.draft ?? (await admin.post('/api/admin/rubric/draft').send({})).body.draft;
  const saved = await admin
    .put('/api/admin/rubric/draft')
    .send({ revision: draft.revision, content: rubricContent(weights, title) });
  const res = await admin
    .post('/api/admin/rubric/draft/publish')
    .send({ revision: saved.body.draft.revision, confirmExistingEvaluations: true });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  await pool.query(
    "UPDATE competition c JOIN rubric r ON r.id=c.id SET c.state='judging_open',c.locked_rubric_version_id=r.published_version_id WHERE c.id=1",
  );
}

async function assign(teamIds: number[], judgeIds: number[]) {
  expect((await admin.post('/api/admin/assignments/bulk').send({ teamIds, judgeIds })).status).toBe(
    200,
  );
}

async function start(agent: Agent, teamId: number) {
  const res = await agent.post(`/api/judge/teams/${teamId}/evaluation`).send({});
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.evaluation as EvaluationDetail;
}

async function save(agent: Agent, e: EvaluationDetail, stars: (number | null)[], note = '') {
  const res = await agent.put(`/api/judge/evaluations/${e.id}`).send({
    rowVersion: e.rowVersion,
    ratings: e.ratings.map((r, i) => ({
      criterionId: r.criterionId,
      rating: stars[i] ?? null,
      note,
    })),
    sectionNotes: e.sectionNotes.map((n) => ({
      sectionId: n.sectionId,
      note: note ? `section ${note}` : '',
    })),
    overallNotes: note ? `overall ${note}` : '',
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.evaluation as EvaluationDetail;
}

async function submit(agent: Agent, e: EvaluationDetail) {
  const res = await agent
    .post(`/api/judge/evaluations/${e.id}/submit`)
    .send({ rowVersion: e.rowVersion });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.evaluation as EvaluationDetail;
}

/** Start, rate everything and submit. */
async function evaluate(agent: Agent, teamId: number, stars: number[], note = '') {
  return submit(agent, await save(agent, await start(agent, teamId), stars, note));
}

const list = async (query = '') =>
  (await admin.get(`/api/admin/evaluations${query}`)).body as AdminEvaluationsResponse;
const detail = async (id: number) =>
  (await admin.get(`/api/admin/evaluations/${id}`)).body as AdminEvaluationDetail;
const history = async (id: number) =>
  ((await admin.get(`/api/admin/evaluations/${id}/history`)).body as { events: EvaluationEvent[] })
    .events;
const reopen = (agent: Agent, id: number, reason: string) =>
  agent.post(`/api/admin/evaluations/${id}/reopen`).send({ reason });

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
  adminId = await insertUser('youmna54@gmail.com', 'admin', 'Youmna Admin');
  await insertUser('second.admin@example.com', 'admin', 'Second Admin');
  judgeId = await insertUser('judge@example.com', 'judge', 'Judge One');
  judge2Id = await insertUser('judge2@example.com', 'judge', 'Judge Two');
  admin = await signIn(app, 'youmna54@gmail.com', PASSWORD);
  admin2 = await signIn(app, 'second.admin@example.com', PASSWORD);
  judge = await signIn(app, 'judge@example.com', PASSWORD);
  judge2 = await signIn(app, 'judge2@example.com', PASSWORD);
  const [t] = await pool.query(
    "INSERT INTO teams (team_code, name, project_name) VALUES ('AHL-1', 'Falcons', 'Irrigation'), ('AHL-2', 'Eagles', 'Solar'), ('AHL-3', 'Lions', 'Recycling')",
  );
  teamA = (t as { insertId: number }).insertId;
  teamB = teamA + 1;
  teamC = teamA + 2;
});

afterAll(async () => {
  await pool.end();
  await dropDatabase(TEST_DB);
});

describe('access', () => {
  it('keeps evaluation management and progress for administrators only', async () => {
    await publishRubric();
    await assign([teamA], [judgeId]);
    const e = await evaluate(judge, teamA, [5, 5, 5, 5, 5, 5, 5, 5]);
    const endpoints = [
      ['get', '/api/admin/evaluations'],
      ['get', `/api/admin/evaluations/${e.id}`],
      ['get', `/api/admin/evaluations/${e.id}/history`],
      ['post', `/api/admin/evaluations/${e.id}/reopen`],
      ['get', '/api/admin/judge-progress'],
    ] as const;
    for (const [method, path] of endpoints) {
      expect(
        (await request(app)[method](path).send({ reason: 'Because of a typo' })).status,
        path,
      ).toBe(401);
      expect((await judge[method](path).send({ reason: 'Because of a typo' })).status, path).toBe(
        403,
      );
    }
    expect((await detail(e.id)).evaluation.status).toBe('submitted');
  });
});

describe('the evaluations list', () => {
  beforeEach(async () => {
    await publishRubric([30, 30, 20, 20]);
    await assign([teamA], [judgeId, judge2Id, adminId]);
    await assign([teamB], [judgeId]);
    await evaluate(judge, teamA, [5, 5, 5, 5, 5, 5, 5, 5]); // 100
    await evaluate(judge2, teamA, [3, 3, 3, 3, 3, 3, 3, 3]); // 60
    await save(admin, await start(admin, teamA), [4, 4, 4]); // draft, 3/8
  });

  it('shows each team with its judges, scores, counts, average and versions', async () => {
    const { teams, total } = await list();
    expect(total).toBe(3);
    const a = teams.find((t) => t.teamCode === 'AHL-1')!;
    expect(a).toMatchObject({
      assignedJudges: 3,
      submitted: 2,
      pending: 1,
      completion: 'in_progress',
      provisionalAverage: 80,
      versions: [1],
      mixedVersions: false,
      readyForResults: false,
    });
    expect(a.judges.map((j) => [j.fullName, j.status, j.totalScore, j.ratedCount])).toEqual([
      ['Judge One', 'submitted', 100, 8],
      ['Judge Two', 'submitted', 60, 8],
      ['Youmna Admin', 'draft', null, 3],
    ]);
    expect(a.lastSubmittedAt).toEqual(expect.any(String));
    expect(teams.find((t) => t.teamCode === 'AHL-2')).toMatchObject({
      completion: 'not_started',
      pending: 1,
    });
    expect(teams.find((t) => t.teamCode === 'AHL-3')).toMatchObject({
      completion: 'no_judges',
      assignedJudges: 0,
    });
  });

  it('searches, filters, sorts and pages', async () => {
    const codes = (r: AdminEvaluationsResponse) => r.teams.map((t) => t.teamCode);
    expect(codes(await list('?search=falc'))).toEqual(['AHL-1']);
    expect(codes(await list('?search=judge2@'))).toEqual(['AHL-1']);
    expect(codes(await list(`?judgeId=${judgeId}`))).toEqual(['AHL-1', 'AHL-2']);
    expect(codes(await list('?status=draft'))).toEqual(['AHL-1']);
    expect(codes(await list('?status=not_started'))).toEqual(['AHL-2']);
    expect(codes(await list(`?judgeId=${judgeId}&status=not_started`))).toEqual(['AHL-2']);
    expect(codes(await list('?completion=incomplete'))).toEqual(['AHL-1', 'AHL-2']);
    expect(codes(await list('?completion=no_judges'))).toEqual(['AHL-3']);
    expect(codes(await list('?version=1'))).toEqual(['AHL-1']);
    expect(codes(await list(`?teamId=${teamB}`))).toEqual(['AHL-2']);
    expect(codes(await list('?sort=average&dir=desc'))).toEqual(['AHL-1', 'AHL-2', 'AHL-3']);
    expect(codes(await list('?sort=pending&dir=desc'))[0]).toBe('AHL-1');
    const page2 = await list('?pageSize=2&page=2');
    expect(codes(page2)).toEqual(['AHL-3']);
    expect(page2.total).toBe(3);
    expect((await list()).judges.map((j) => j.fullName)).toEqual([
      'Judge One',
      'Judge Two',
      'Youmna Admin',
    ]);
    expect((await admin.get('/api/admin/evaluations?sort=password')).status).toBe(400);
  });

  it('marks a team ready only when every assigned judge has submitted on one version', async () => {
    const draft = (await detail((await list()).teams[0]!.judges[2]!.evaluationId!)).evaluation;
    await submit(admin, await save(admin, draft, [5, 5, 5, 5, 5, 5, 5, 5]));
    const a = (await list('?completion=ready')).teams;
    expect(a.map((t) => t.teamCode)).toEqual(['AHL-1']);
    expect(a[0]).toMatchObject({
      completion: 'complete',
      submitted: 3,
      pending: 0,
      readyForResults: true,
    });
  });
});

describe('read-only review and history', () => {
  it('shows every rating, note, weight and score exactly as calculated for its version', async () => {
    await publishRubric([35, 25, 25, 15]);
    await assign([teamA], [judgeId]);
    const e = await evaluate(judge, teamA, [3, 4, 5, 5, 2, 3, 1, 4], 'great');
    const d = await detail(e.id);
    expect(d).toMatchObject({
      team: { teamCode: 'AHL-1', name: 'Falcons' },
      judge: { fullName: 'Judge One', email: 'judge@example.com' },
      judgeAssigned: true,
      canReopen: true,
      evaluation: {
        status: 'submitted',
        totalScore: 69.5,
        rubricVersionNo: 1,
        overallNotes: 'overall great',
      },
    });
    expect(d.rubric.sections.map((s) => s.weightPercent)).toEqual([35, 25, 25, 15]);
    expect(d.sectionScores).toEqual([24.5, 25, 12.5, 7.5]);
    expect(d.evaluation.ratings.map((r) => r.rating)).toEqual([3, 4, 5, 5, 2, 3, 1, 4]);
    expect(d.evaluation.ratings[0]!.note).toBe('great');
    expect(d.evaluation.sectionNotes[0]!.note).toBe('section great');
    expect(d.saveCount).toBe(1);
    expect(d.evaluation.submittedAt).toEqual(expect.any(String));
  });

  it('records the start, a throttled draft revision and an immutable submission snapshot', async () => {
    await publishRubric();
    await assign([teamA], [judgeId]);
    let e = await start(judge, teamA);
    for (let i = 1; i <= 5; i++) e = await save(judge, e, [i]); // five autosaves
    e = await save(judge, e, [5, 5, 5, 5, 5, 5, 5, 5], 'final');
    const done = await submit(judge, e);
    const events = await history(done.id);
    expect(events.map((x) => x.event)).toEqual(['started', 'submitted']); // draft revisions throttled
    expect(
      await scalar<number>(pool, 'SELECT save_count FROM evaluations WHERE id = ?', [done.id]),
    ).toBe(6);
    const snap = events[1]!.snapshot!;
    expect(snap.totalScore).toBe(100);
    expect(snap.ratings).toHaveLength(8);
    expect(snap.ratings[0]).toMatchObject({ title: 'Idea A', rating: 5, note: 'final' });
    expect(snap.sections.map((s) => [s.title, s.weightPercent, s.score])).toEqual([
      ['Idea', 30, 30],
      ['Execution', 30, 30],
      ['Presentation', 20, 20],
      ['Teamwork', 20, 20],
    ]);
    await expectRefused(pool.query('UPDATE evaluation_events SET total_score = 1'), /append-only/);
    await expectRefused(pool.query('DELETE FROM evaluation_events'), /never deleted/);
  });

  it('records a draft revision once the throttle interval has passed', async () => {
    await publishRubric();
    await assign([teamA], [judgeId]);
    const e = await start(judge, teamA);
    // Pretend the start happened long ago (TRUNCATE-free test shortcut: insert a fresh timeline).
    await pool.query('DROP TRIGGER trg_ee_no_update');
    await pool.query(
      'UPDATE evaluation_events SET created_at = NOW() - INTERVAL 1 HOUR WHERE evaluation_id = ?',
      [e.id],
    );
    await pool.query(`CREATE TRIGGER trg_ee_no_update BEFORE UPDATE ON evaluation_events FOR EACH ROW
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Evaluation history is append-only'`);
    await save(judge, e, [4, 4]);
    const events = await history(e.id);
    expect(events.map((x) => x.event)).toEqual(['started', 'draft_saved']);
    expect(events[1]).toMatchObject({ ratedCount: 2, totalScore: 24 });
  });
});

describe('reopening', () => {
  async function submittedEvaluation(stars = [5, 5, 5, 5, 5, 5, 5, 5]) {
    await publishRubric();
    await assign([teamA], [judgeId, judge2Id]);
    const mine = await evaluate(judge, teamA, stars, 'first');
    const other = await evaluate(judge2, teamA, [3, 3, 3, 3, 3, 3, 3, 3]);
    return { mine, other };
  }

  it('requires a meaningful reason', async () => {
    const { mine } = await submittedEvaluation();
    for (const reason of ['', '   ', 'typo', 'x'.repeat(501)]) {
      const res = await reopen(admin, mine.id, reason);
      expect(res.status, JSON.stringify(reason)).toBe(400);
    }
    expect((await admin.post(`/api/admin/evaluations/${mine.id}/reopen`).send({})).status).toBe(
      400,
    );
    expect((await detail(mine.id)).evaluation.status).toBe('submitted');
  });

  it('reopens to draft, records who, when and why, keeps the snapshot, and notifies the judge', async () => {
    const { mine, other } = await submittedEvaluation();
    const res = await reopen(admin, mine.id, '  Section 2 was scored for the wrong team.  ');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const d = res.body as AdminEvaluationDetail;
    expect(d.evaluation).toMatchObject({
      status: 'draft',
      submittedAt: null,
      reopenedCount: 1,
      rubricVersionNo: 1,
    });
    expect(d.reopen).toMatchObject({
      byEmail: 'youmna54@gmail.com',
      reason: 'Section 2 was scored for the wrong team.',
      count: 1,
    });
    expect(d.canReopen).toBe(false);
    // Ratings and notes stay so the judge can correct them.
    expect(d.evaluation.ratings.every((r) => r.rating === 5)).toBe(true);

    const events = await history(mine.id);
    expect(events.map((e) => e.event)).toEqual(['started', 'submitted', 'reopened']);
    expect(events[2]).toMatchObject({
      actorEmail: 'youmna54@gmail.com',
      previousScore: 100,
      reason: 'Section 2 was scored for the wrong team.',
    });
    expect(events[1]!.snapshot!.totalScore).toBe(100);

    // No longer a completed submission; the other judge's evaluation is untouched.
    const team = (await list()).teams.find((t) => t.teamCode === 'AHL-1')!;
    expect(team).toMatchObject({ submitted: 1, pending: 1, provisionalAverage: 60 });
    expect((await detail(other.id)).evaluation).toMatchObject({
      status: 'submitted',
      totalScore: 60,
    });

    // The judge is told, and the notice clears once they open it.
    const assignment = (await judge.get('/api/judge/assignments')).body.assignments[0];
    expect(assignment).toMatchObject({
      evaluationStatus: 'draft',
      reopenNotice: true,
      reopenReason: 'Section 2 was scored for the wrong team.',
    });
    const view = (await judge.get(`/api/judge/teams/${teamA}/evaluation`)).body;
    expect(view).toMatchObject({
      canEdit: true,
      evaluation: {
        reopenNoticePending: true,
        reopenReason: 'Section 2 was scored for the wrong team.',
      },
    });
    expect(
      (await judge.post(`/api/judge/evaluations/${mine.id}/acknowledge-reopen`).send({})).status,
    ).toBe(204);
    expect((await judge.get('/api/judge/assignments')).body.assignments[0].reopenNotice).toBe(
      false,
    );

    const [audit] = await pool.query<RowDataPacket[]>(
      "SELECT details FROM audit_log WHERE action = 'evaluation.reopened'",
    );
    const details =
      typeof audit[0]!.details === 'string' ? JSON.parse(audit[0]!.details) : audit[0]!.details;
    expect(details).toMatchObject({
      judge_email: 'judge@example.com',
      previous_score: 100,
      own_evaluation: false,
    });
  });

  it('lets only the original judge edit and resubmit, keeping old and new scores in history', async () => {
    const { mine } = await submittedEvaluation();
    await reopen(admin, mine.id, 'Please re-check the teamwork section.');
    const reopened = (await judge.get(`/api/judge/teams/${teamA}/evaluation`)).body
      .evaluation as EvaluationDetail;

    // Nobody else can edit it: another judge, or an admin through the judging API.
    expect(
      (
        await judge2.put(`/api/judge/evaluations/${mine.id}`).send({
          rowVersion: reopened.rowVersion,
          ratings: [],
          sectionNotes: [],
          overallNotes: '',
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await admin.put(`/api/judge/evaluations/${mine.id}`).send({
          rowVersion: reopened.rowVersion,
          ratings: [],
          sectionNotes: [],
          overallNotes: '',
        })
      ).status,
    ).toBe(404);

    const fixed = await save(judge, reopened, [5, 5, 5, 5, 5, 5, 3, 3], 'second');
    const again = await submit(judge, fixed);
    expect(again).toMatchObject({ status: 'submitted', totalScore: 92, rubricVersionNo: 1 });

    const events = await history(mine.id);
    expect(events.map((e) => e.event)).toEqual(['started', 'submitted', 'reopened', 'resubmitted']);
    expect(events[3]).toMatchObject({ totalScore: 92, previousScore: 100 });
    expect(events[1]!.snapshot!.ratings[0]!.note).toBe('first'); // the original submission is preserved
    expect(events[3]!.snapshot!.ratings[0]!.note).toBe('second');
    expect(
      await scalar<number>(
        pool,
        "SELECT COUNT(*) FROM audit_log WHERE action = 'evaluation.resubmitted'",
      ),
    ).toBe(1);
  });

  it('only reopens submitted evaluations, and only one of two simultaneous attempts succeeds', async () => {
    const { mine } = await submittedEvaluation();
    const results = await Promise.all([
      reopen(admin, mine.id, 'First administrator reason'),
      reopen(admin2, mine.id, 'Second administrator reason'),
      reopen(admin, mine.id, 'Third attempt reason'),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(
      await scalar<number>(pool, "SELECT COUNT(*) FROM evaluation_events WHERE event = 'reopened'"),
    ).toBe(1);
    expect(
      await scalar<number>(
        pool,
        "SELECT COUNT(*) FROM audit_log WHERE action = 'evaluation.reopened'",
      ),
    ).toBe(1);
    expect(
      await scalar<number>(pool, 'SELECT reopened_count FROM evaluations WHERE id = ?', [mine.id]),
    ).toBe(1);
  });

  it('refuses while the judge is unassigned, disabled or the team archived, and allows it once restored', async () => {
    const { mine } = await submittedEvaluation();
    await admin.delete(`/api/admin/teams/${teamA}/judges/${judgeId}`);
    let res = await reopen(admin, mine.id, 'Needs another look please');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('JUDGE_NOT_ASSIGNED');
    expect(await detail(mine.id)).toMatchObject({ judgeAssigned: false, canReopen: false });

    await assign([teamA], [judgeId]);
    await admin.patch(`/api/admin/users/${judgeId}`).send({ status: 'disabled' });
    res = await reopen(admin, mine.id, 'Needs another look please');
    expect(res.body.error.code).toBe('ACCOUNT_DISABLED');

    await admin.patch(`/api/admin/users/${judgeId}`).send({ status: 'active' });
    await admin.post(`/api/admin/teams/${teamA}/archive`).send({});
    res = await reopen(admin, mine.id, 'Needs another look please');
    expect(res.body.error.code).toBe('TEAM_ARCHIVED');
    // Archived teams keep their evaluations and can still be reviewed.
    expect((await list('?teamStatus=archived')).teams[0]).toMatchObject({
      teamCode: 'AHL-1',
      submitted: 2,
    });

    await admin.post(`/api/admin/teams/${teamA}/reactivate`).send({});
    expect((await reopen(admin, mine.id, 'Needs another look please')).status).toBe(200);
  });

  it('lets an administrator reopen their own evaluation, flagged in the audit log', async () => {
    await publishRubric();
    await assign([teamA], [adminId]);
    const own = await evaluate(admin, teamA, [4, 4, 4, 4, 4, 4, 4, 4]);
    expect((await reopen(admin, own.id, 'I rated the wrong team')).status).toBe(200);
    const [audit] = await pool.query<RowDataPacket[]>(
      "SELECT details FROM audit_log WHERE action = 'evaluation.reopened'",
    );
    const details =
      typeof audit[0]!.details === 'string' ? JSON.parse(audit[0]!.details) : audit[0]!.details;
    expect(details.own_evaluation).toBe(true);
    // Same rules after reopening: it must be resubmitted through judging.
    const view = (await admin.get(`/api/judge/teams/${teamA}/evaluation`)).body;
    expect(view.evaluation.status).toBe('draft');
  });
});

describe('judge progress', () => {
  it('counts current active assignments, keeps other evaluations separate, and includes admins who judge', async () => {
    await publishRubric();
    await assign([teamA, teamB, teamC], [judgeId]);
    await assign([teamA], [adminId]);
    await evaluate(judge, teamA, [5, 5, 5, 5, 5, 5, 5, 5]);
    await save(judge, await start(judge, teamB), [3]);
    await evaluate(admin, teamA, [4, 4, 4, 4, 4, 4, 4, 4]);
    // Archiving team C removes it from progress; unassigning B keeps its draft as history.
    await admin.post(`/api/admin/teams/${teamC}/archive`).send({});
    await admin.delete(`/api/admin/teams/${teamB}/judges/${judgeId}`);

    const rows = (
      (await admin.get('/api/admin/judge-progress')).body as { judges: JudgeProgressRow[] }
    ).judges;
    const byName = Object.fromEntries(rows.map((r) => [r.fullName, r]));
    expect(Object.keys(byName)).toEqual(['Judge One', 'Judge Two', 'Youmna Admin']);
    expect(byName['Judge One']).toMatchObject({
      assignedTeams: 1,
      notStarted: 0,
      draft: 0,
      submitted: 1,
      completionPercent: 100,
      otherEvaluations: 1,
    });
    expect(byName['Judge One']!.lastSubmittedAt).toEqual(expect.any(String));
    expect(byName['Judge Two']).toMatchObject({ assignedTeams: 0, completionPercent: null });
    expect(byName['Youmna Admin']).toMatchObject({ role: 'admin', assignedTeams: 1, submitted: 1 });

    const complete = (
      (await admin.get('/api/admin/judge-progress?completion=complete')).body as {
        judges: JudgeProgressRow[];
      }
    ).judges;
    expect(complete.map((r) => r.fullName)).toEqual(['Judge One', 'Youmna Admin']);
    const noTeams = (
      (await admin.get('/api/admin/judge-progress?completion=no_teams')).body as {
        judges: JudgeProgressRow[];
      }
    ).judges;
    expect(noTeams.map((r) => r.fullName)).toEqual(['Judge Two']);
    const search = (
      (await admin.get('/api/admin/judge-progress?search=judge2')).body as {
        judges: JudgeProgressRow[];
      }
    ).judges;
    expect(search.map((r) => r.fullName)).toEqual(['Judge Two']);
  });
});

describe('mixed rubric versions', () => {
  it('flags teams evaluated on different versions and shows each evaluation’s weights', async () => {
    await publishRubric([30, 30, 20, 20]);
    await assign([teamA], [judgeId, judge2Id]);
    const v1 = await evaluate(judge, teamA, [5, 5, 5, 5, 5, 5, 5, 5]);
    await publishRubric([10, 50, 20, 20], 'Revised rubric');
    const v2 = await evaluate(judge2, teamA, [5, 5, 1, 1, 5, 5, 5, 5]);

    const team = (await list('?completion=mixed_versions')).teams[0]!;
    expect(team).toMatchObject({
      teamCode: 'AHL-1',
      versions: [1, 2],
      mixedVersions: true,
      completion: 'complete',
      readyForResults: false,
    });
    expect((await list('?version=2')).teams.map((t) => t.teamCode)).toEqual(['AHL-1']);
    expect((await detail(v1.id)).rubric.sections.map((s) => s.weightPercent)).toEqual([
      30, 30, 20, 20,
    ]);
    expect((await detail(v2.id)).rubric.sections.map((s) => s.weightPercent)).toEqual([
      10, 50, 20, 20,
    ]);
    expect((await detail(v2.id)).evaluation.totalScore).toBe(10 + 10 + 20 + 20);

    const teamDetails = (await admin.get(`/api/admin/teams/${teamA}`)).body.team;
    expect(teamDetails).toMatchObject({
      mixedVersions: true,
      readyForResults: false,
      provisionalAverage: 80,
    });
    expect(teamDetails.assignments.map((a: { weights: number[] }) => a.weights)).toEqual([
      [30, 30, 20, 20],
      [10, 50, 20, 20],
    ]);
  });
});
