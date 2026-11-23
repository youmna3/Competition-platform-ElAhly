/**
 * Stage 3: the official numeric-points rubric (scoring format 4), end to end
 * through the real API on a disposable database. Two teams with three judges
 * each, numeric scoring, averages, ties, an administrator correction, rubric
 * locking, Excel/CSV exports and preservation of the older star rubric.
 */
import bcrypt from 'bcryptjs';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { Agent } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  defaultRubricContent,
  officialRubric2026,
  type AdminRubricResponse,
  type EvaluationDetail,
  type ResultsResponse,
} from '@judging/shared';
import { makeTestApp, signIn } from './appHelpers.js';
import { dropDatabase, freshTestDatabase, TEST_DB, testMysql, testTarget } from './helpers.js';

const PASSWORD = 'Disposable-Points-Pass-1!';
let pool: Pool;
let app: ReturnType<typeof makeTestApp>;
let admin: Agent;
const judges: { id: number; agent: Agent; name: string }[] = [];
const teams: { id: number; code: string }[] = [];

const MAXIMA = officialRubric2026().sections.flatMap((s) => s.criteria.map((c) => c.maxPoints!));

/** Whole points per criterion (official rubric order) that add up to `total`. */
function pointsFor(total: number): number[] {
  const values = [...MAXIMA];
  let remove = 100 - total;
  for (let i = 0; remove > 0; i = (i + 1) % values.length) {
    if (values[i]! > 0) {
      values[i]! -= 1;
      remove -= 1;
    }
  }
  return values;
}

async function insertUser(email: string, name: string, role: 'admin' | 'judge') {
  const [r] = await pool.query<ResultSetHeader>(
    'INSERT INTO users (email, full_name, password_hash, role, must_change_password) VALUES (?, ?, ?, ?, FALSE)',
    [email, name, bcrypt.hashSync(PASSWORD, 4), role],
  );
  return r.insertId;
}

async function rubricState() {
  return (await admin.get('/api/admin/rubric')).body as AdminRubricResponse;
}

async function open(agent: Agent, teamId: number): Promise<EvaluationDetail> {
  const existing = (await agent.get(`/api/judge/teams/${teamId}/evaluation`)).body.evaluation;
  if (existing) return existing;
  const res = await agent.post(`/api/judge/teams/${teamId}/evaluation`).send({});
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.evaluation;
}

const body = (e: EvaluationDetail, values: (number | null)[]) => ({
  rowVersion: e.rowVersion,
  ratings: e.ratings.map((r, i) => ({
    criterionId: r.criterionId,
    rating: values[i] ?? null,
    note: '',
  })),
  sectionNotes: e.sectionNotes.map((n) => ({ sectionId: n.sectionId, note: '' })),
  overallNotes: '',
});

async function score(agent: Agent, teamId: number, values: (number | null)[]) {
  const e = await open(agent, teamId);
  const saved = await agent.put(`/api/judge/evaluations/${e.id}`).send(body(e, values));
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  return saved.body.evaluation as EvaluationDetail;
}

async function submit(agent: Agent, e: EvaluationDetail) {
  const res = await agent
    .post(`/api/judge/evaluations/${e.id}/submit`)
    .send({ rowVersion: e.rowVersion });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.evaluation as EvaluationDetail;
}

async function transition(target: 'judging_open' | 'closed') {
  const status = (await admin.get('/api/admin/competition')).body;
  const res = await admin
    .post('/api/admin/competition/transition')
    .send({ target, rowVersion: status.rowVersion, confirmed: true });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

const ranking = (r: ResultsResponse) =>
  r.official.teams.map((t) => [t.teamCode, t.rank, Number(t.score.toFixed(6))]);

beforeAll(async () => {
  await freshTestDatabase();
  pool = testMysql.createPool({ ...testTarget, connectionLimit: 8 });
  app = makeTestApp(pool);
  await insertUser('youmna54@gmail.com', 'Youmna Admin', 'admin');
  admin = await signIn(app, 'youmna54@gmail.com', PASSWORD);
  for (const n of [1, 2, 3]) {
    const id = await insertUser(`points${n}@example.com`, `Points Judge ${n}`, 'judge');
    judges.push({
      id,
      agent: await signIn(app, `points${n}@example.com`, PASSWORD),
      name: `Points Judge ${n}`,
    });
  }
  for (const code of ['PT-A', 'PT-B']) {
    const [r] = await pool.query<ResultSetHeader>(
      'INSERT INTO teams (team_code, name, project_name) VALUES (?, ?, ?)',
      [code, `Team ${code}`, `Project ${code}`],
    );
    teams.push({ id: r.insertId, code });
  }
}, 60_000);

afterAll(async () => {
  await pool?.end();
  await dropDatabase(TEST_DB);
});

describe('official 2026 points rubric', () => {
  let starVersionId: number;

  it('keeps an older star rubric intact while the official rubric is loaded as a draft', async () => {
    // A published star rubric (version 1), as an earlier installation would have.
    let res = await admin.post('/api/admin/rubric/draft').send({});
    const content = defaultRubricContent();
    content.title = 'Legacy star rubric';
    content.sections.forEach((s) => (s.weightPercent = 25));
    res = await admin
      .put('/api/admin/rubric/draft')
      .send({ revision: res.body.draft.revision, content });
    expect(res.status).toBe(200);
    res = await admin
      .post('/api/admin/rubric/draft/publish')
      .send({ revision: res.body.draft.revision });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    starVersionId = res.body.published.id;
    const before = JSON.stringify(
      (
        await pool.query<RowDataPacket[]>(
          'SELECT * FROM rubric_criteria WHERE rubric_version_id = ? ORDER BY id',
          [starVersionId],
        )
      )[0],
    );

    res = await admin.post('/api/admin/rubric/draft/official').send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const state = res.body as AdminRubricResponse;
    expect(state.state).toBe('published_with_draft');
    expect(state.published!.versionNo).toBe(1);
    expect(state.published!.title).toBe('Legacy star rubric');
    expect(state.draft!.versionNo).toBe(2);
    expect(state.draft!.status).toBe('draft');
    expect(state.draft!.scoringFormat).toBe(4);

    // The draft is exactly the official rubric.
    const official = officialRubric2026();
    expect(state.draft!.title).toBe(official.title);
    expect(
      state.draft!.sections.map((s) => [
        s.title,
        s.description,
        s.weightPercent,
        s.criteria.map((c) => [c.title, c.description, c.maxPoints]),
      ]),
    ).toEqual(
      official.sections.map((s) => [
        s.title,
        s.description,
        s.criteria.reduce((n, c) => n + c.maxPoints!, 0),
        s.criteria.map((c) => [c.title, c.description, c.maxPoints]),
      ]),
    );
    const [[criteria]] = (await pool.query(
      'SELECT MIN(min_score) AS lo, SUM(max_score) AS total, MIN(weight) AS w1, MAX(weight) AS w2, MIN(is_required) AS req FROM rubric_criteria WHERE rubric_version_id = ?',
      [state.draft!.id],
    )) as unknown as [RowDataPacket[]];
    expect(criteria).toMatchObject({ lo: 0, total: '100', req: 1 });
    expect(Number(criteria!.w1)).toBe(1);
    expect(Number(criteria!.w2)).toBe(1);

    // Nothing was published or changed on version 1.
    const after = JSON.stringify(
      (
        await pool.query<RowDataPacket[]>(
          'SELECT * FROM rubric_criteria WHERE rubric_version_id = ? ORDER BY id',
          [starVersionId],
        )
      )[0],
    );
    expect(after).toBe(before);
    const [[audit]] = (await pool.query(
      "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'rubric.official_loaded'",
    )) as unknown as [RowDataPacket[]];
    expect(Number(audit!.n)).toBe(1);
  });

  it('asks before replacing an existing draft', async () => {
    let res = await admin.post('/api/admin/rubric/draft/official').send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DRAFT_EXISTS');
    res = await admin.post('/api/admin/rubric/draft/official').send({ replaceDraft: true });
    expect(res.status).toBe(200);
    expect((res.body as AdminRubricResponse).draft!.versionNo).toBe(2);
    expect(
      (await admin.post('/api/admin/rubric/draft/official').send({ replaceDraft: 'yes' })).status,
    ).toBe(400);
  });

  it('is refused by the database if a points version is published with a wrong total', async () => {
    const draftId = (await rubricState()).draft!.id;
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(
        'UPDATE rubric_criteria SET max_score = 9 WHERE rubric_version_id = ? ORDER BY position LIMIT 1',
        [draftId],
      );
      await expect(
        conn.query(
          "UPDATE rubric_versions SET status = 'published', published_at = NOW() WHERE id = ?",
          [draftId],
        ),
      ).rejects.toThrow(/Cannot publish/);
    } finally {
      await conn.rollback();
      conn.release();
    }
  });

  it('publishes only when the administrator chooses to, and judges then score with points', async () => {
    expect((await rubricState()).published!.versionNo).toBe(1);
    const draft = (await rubricState()).draft!;
    const res = await admin
      .post('/api/admin/rubric/draft/publish')
      .send({ revision: draft.revision, confirmExistingEvaluations: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const state = await rubricState();
    expect(state.published!.versionNo).toBe(2);
    const [[v1]] = (await pool.query(
      'SELECT status, scoring_format FROM rubric_versions WHERE id = ?',
      [starVersionId],
    )) as unknown as [RowDataPacket[]];
    expect(v1).toMatchObject({ status: 'retired', scoring_format: 1 });

    const assign = await admin
      .post('/api/admin/assignments/bulk')
      .send({ teamIds: teams.map((t) => t.id), judgeIds: judges.map((j) => j.id) });
    expect(assign.status, JSON.stringify(assign.body)).toBe(200);
    await transition('judging_open');
  });

  it('shows judges the required criteria count before they start (not 0/0)', async () => {
    const res = await judges[0]!.agent.get('/api/judge/assignments');
    expect(
      res.body.assignments.map((a: { ratedCount: number; requiredCount: number }) => [
        a.ratedCount,
        a.requiredCount,
      ]),
    ).toEqual([
      [0, 12],
      [0, 12],
    ]);
  });

  it('accepts 0 to each maximum, refuses anything else, and keeps blank as not scored', async () => {
    const [judge] = judges;
    const e = await open(judge!.agent, teams[0]!.id);
    expect(e.rubricVersionNo).toBe(2);
    for (const bad of [11, -1, 3.5]) {
      const values: (number | null)[] = MAXIMA.map(() => null);
      values[0] = bad;
      const res = await judge!.agent.put(`/api/judge/evaluations/${e.id}`).send(body(e, values));
      expect(res.status, String(bad)).toBe(400);
      expect(res.body.error.message).toMatch(/whole number from 0 to 10/);
    }
    const zeroes = await score(
      judge!.agent,
      teams[0]!.id,
      MAXIMA.map((_, i) => (i === 0 ? 0 : null)),
    );
    expect(zeroes.ratedCount).toBe(1);
    expect(zeroes.totalScore).toBe(0);
    const incomplete = await judge!.agent
      .post(`/api/judge/evaluations/${zeroes.id}/submit`)
      .send({ rowVersion: zeroes.rowVersion });
    expect(incomplete.status).toBe(400);
    expect(incomplete.body.error.code).toBe('EVALUATION_INCOMPLETE');
    // A running draft total is the sum of the points entered so far.
    const partial = await score(
      judge!.agent,
      teams[0]!.id,
      MAXIMA.map((m, i) => (i < 3 ? m : null)),
    );
    expect(partial.totalScore).toBe(30);
  });

  it('calculates each judge’s total, team averages and shared ranks exactly', async () => {
    // Team A: 80, 90, 70 → 80. Team B: 100, 60, 80 → 80. Equal averages share rank 1.
    const plan: Record<string, number[]> = { 'PT-A': [80, 90, 70], 'PT-B': [100, 60, 80] };
    for (const team of teams) {
      for (const [i, judge] of judges.entries()) {
        const e = await score(judge.agent, team.id, pointsFor(plan[team.code]![i]!));
        expect(e.totalScore).toBe(plan[team.code]![i]);
        const s = await submit(judge.agent, e);
        expect(s.status).toBe('submitted');
        expect(s.totalScore).toBe(plan[team.code]![i]);
      }
    }
    const [stored] = await pool.query<RowDataPacket[]>(
      "SELECT t.team_code, e.total_score FROM evaluations e JOIN teams t ON t.id = e.team_id WHERE e.status = 'submitted' ORDER BY t.team_code, e.judge_id",
    );
    expect(stored.map((r) => [r.team_code, Number(r.total_score)])).toEqual([
      ['PT-A', 80],
      ['PT-A', 90],
      ['PT-A', 70],
      ['PT-B', 100],
      ['PT-B', 60],
      ['PT-B', 80],
    ]);
    const results = (await admin.get('/api/admin/results')).body as ResultsResponse;
    expect(results.official.available).toBe(true);
    expect(results.official.rubricVersionNo).toBe(2);
    expect(ranking(results)).toEqual([
      ['PT-A', 1, 80],
      ['PT-B', 1, 80],
    ]);
    // The judge view shows the same official ranking, read-only.
    const judgeView = await judges[1]!.agent.get('/api/judge/leaderboard');
    expect(judgeView.status).toBe(200);
    expect(
      judgeView.body.official.teams.map((t: { teamCode: string; rank: number }) => [
        t.teamCode,
        t.rank,
      ]),
    ).toEqual([
      ['PT-A', 1],
      ['PT-B', 1],
    ]);
    expect((await judges[1]!.agent.get('/api/admin/results')).status).toBe(403);
  });

  it('applies an administrator correction with points, updates the average and keeps history', async () => {
    const [[row]] = (await pool.query(
      'SELECT id FROM evaluations WHERE team_id = ? AND judge_id = ?',
      [teams[0]!.id, judges[1]!.id],
    )) as unknown as [RowDataPacket[]];
    const detail = (await admin.get(`/api/admin/evaluations/${row!.id}`)).body;
    expect(detail.canCorrect).toBe(true);
    const e = detail.evaluation as EvaluationDetail;
    // 90 → 93 for judge 2 on team A: team A average becomes 81.
    const corrected = await admin.put(`/api/admin/evaluations/${e.id}/submission`).send({
      ...body(e, pointsFor(93)),
      reason: 'Arithmetic slip on the scoring sheet',
      confirmed: true,
    });
    expect(corrected.status, JSON.stringify(corrected.body)).toBe(200);
    expect(corrected.body.evaluation.totalScore).toBe(93);
    expect(corrected.body.evaluation.status).toBe('submitted');
    const bad = await admin.put(`/api/admin/evaluations/${e.id}/submission`).send({
      ...body(
        corrected.body.evaluation,
        MAXIMA.map((m) => m + 1),
      ),
      reason: 'Out of range test',
      confirmed: true,
    });
    expect(bad.status).toBe(400);

    const results = (await admin.get('/api/admin/results')).body as ResultsResponse;
    expect(ranking(results)).toEqual([
      ['PT-A', 1, 81],
      ['PT-B', 2, 80],
    ]);
    const history = (await admin.get(`/api/admin/evaluations/${e.id}/history`)).body.events as {
      event: string;
      previousScore: number | null;
      totalScore: number | null;
      snapshot: { ratings: { rating: number; maxPoints?: number }[] } | null;
    }[];
    const correction = history.find((h) => h.event === 'admin_corrected')!;
    expect([correction.previousScore, correction.totalScore]).toEqual([90, 93]);
    expect(correction.snapshot!.ratings[0]).toMatchObject({ maxPoints: 10 });
  });

  it('locks the rubric while judging is open', async () => {
    const res = await admin.post('/api/admin/rubric/draft/official').send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('COMPETITION_LOCKED');
  });

  it('exports the same numbers to CSV and Excel', async () => {
    const csv = await admin.get('/api/admin/reports/results?format=csv');
    expect(csv.status).toBe(200);
    const lines = csv.text
      .replace(/^\uFEFF/, '')
      .trim()
      .split(/\r?\n/);
    const header = lines[0]!.split('","').map((h) => h.replace(/"/g, ''));
    const rows = lines.slice(1).map((l) => l.split('","').map((c) => c.replace(/"/g, '')));
    const col = (name: string) => header.indexOf(name);
    expect(
      rows.map((r) => [r[col('Team ID')], r[col('Official rank')], r[col('Combined average')]]),
    ).toEqual([
      ['PT-A', '1', '81'],
      ['PT-B', '2', '80'],
    ]);

    const evaluations = await admin.get('/api/admin/reports/evaluations?format=csv&sheet=Criteria');
    expect(evaluations.status).toBe(200);
    expect(evaluations.text).toContain('Maximum (5 stars or criterion points)');
    expect(evaluations.text).toContain('"Prompt clarity & structure"');

    for (const kind of ['results', 'evaluations', 'progress', 'corrections', 'rubrics']) {
      const xlsx = await admin
        .get(`/api/admin/reports/${kind}?format=xlsx`)
        .buffer(true)
        .parse((res, done) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => done(null, Buffer.concat(chunks)));
        });
      expect(xlsx.status, kind).toBe(200);
      expect((xlsx.body as Buffer).subarray(0, 2).toString(), kind).toBe('PK');
    }
  });

  it('blocks judging and corrections after the competition closes', async () => {
    await transition('closed');
    const [[row]] = (await pool.query(
      'SELECT id, row_version FROM evaluations WHERE team_id = ? AND judge_id = ?',
      [teams[1]!.id, judges[0]!.id],
    )) as unknown as [RowDataPacket[]];
    const detail = (await admin.get(`/api/admin/evaluations/${row!.id}`)).body;
    expect(detail.canCorrect).toBe(false);
    const res = await admin.put(`/api/admin/evaluations/${row!.id}/submission`).send({
      ...body(detail.evaluation, pointsFor(50)),
      reason: 'After close',
      confirmed: true,
    });
    expect(res.status).toBe(409);
    const results = (await admin.get('/api/admin/results')).body as ResultsResponse;
    expect(ranking(results)).toEqual([
      ['PT-A', 1, 81],
      ['PT-B', 2, 80],
    ]);
  });
});
