import { testMysql as mysql } from './helpers.js';
/**
 * Phase 8: official results and the administrator dashboard, through the real
 * API and a real (scratch) MySQL database. Scoring, competition ranking and
 * ties, eligibility, every data change that must move a team in or out of the
 * ranking, rubric versions, access rules, session expiry and concurrency.
 */
import bcrypt from 'bcryptjs';
import { type Pool, type RowDataPacket } from 'mysql2/promise';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  DashboardResponse,
  EvaluationDetail,
  JudgeLeaderboardResponse,
  ResultsResponse,
  RubricContent,
  TeamResult,
} from '@judging/shared';
import { dropDatabase, freshTestDatabase, TEST_DB, testTarget } from './helpers.js';
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
let judge3: Agent;
let judge3Id: number;
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

const results = async (query = '') => {
  const res = await admin.get(`/api/admin/results${query}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as ResultsResponse;
};
const dashboard = async () => {
  const res = await admin.get('/api/admin/dashboard');
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as DashboardResponse;
};
const reopen = (id: number, reason = 'Please re-check the scores') =>
  admin.post(`/api/admin/evaluations/${id}/reopen`).send({ reason });
const notRanked = (r: ResultsResponse, code: string) =>
  r.notRanked.find((t) => t.teamCode === code) as TeamResult;
const ranking = (r: ResultsResponse) =>
  r.official.teams.map((t) => [t.teamCode, t.rank, Number(t.score.toFixed(3))]);

/** Star sets with known totals at weights 30/30/20/20. */
const S = {
  100: [5, 5, 5, 5, 5, 5, 5, 5],
  90: [5, 5, 4, 4, 5, 5, 4, 4],
  80: [4, 4, 4, 4, 4, 4, 4, 4],
  70: [4, 4, 3, 3, 4, 4, 3, 3],
  60: [3, 3, 3, 3, 3, 3, 3, 3],
  81: [5, 4, 4, 4, 4, 4, 4, 3],
};

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
  judge = await signIn(app, 'judge@example.com', PASSWORD);
  judge2 = await signIn(app, 'judge2@example.com', PASSWORD);
  judge3Id = await insertUser('judge3@example.com', 'judge', 'Judge Three');
  judge3 = await signIn(app, 'judge3@example.com', PASSWORD);
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

describe('access and validation', () => {
  it('allows both authenticated roles to read the judge leaderboard, with no mutation endpoints', async () => {
    expect((await request(app).get('/api/judge/leaderboard')).status).toBe(401);
    for (const agent of [admin, judge]) {
      const response = await agent.get('/api/judge/leaderboard');
      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      for (const method of ['post', 'put', 'patch', 'delete'] as const) {
        expect((await agent[method]('/api/judge/leaderboard').send({ score: 100 })).status).toBe(
          404,
        );
      }
    }
    for (const query of [
      '?sort=judges',
      '?sort=submitted',
      '?include=notes',
      '?dir=invalid',
      `?search=${'a'.repeat(101)}`,
    ]) {
      expect((await judge.get(`/api/judge/leaderboard${query}`)).status).toBe(400);
    }
  });

  it('never leaks judge identities, individual scores, notes or provisional scores and cannot search private names', async () => {
    await publishRubric();
    await assign([teamA], [judgeId, judge2Id]);
    await assign([teamB], [judgeId, judge2Id]);
    await evaluate(judge, teamA, S[80], 'Private evaluation notes');
    await evaluate(judge2, teamA, S[90]);
    await evaluate(judge, teamB, S[70]);
    const response = await judge.get('/api/judge/leaderboard');
    expect(response.status).toBe(200);
    const body = response.body as JudgeLeaderboardResponse;
    expect(body.official.teams).toEqual([
      {
        teamId: teamA,
        teamCode: 'AHL-1',
        name: 'Falcons',
        projectName: 'Irrigation',
        rank: 1,
        score: 85,
        baseAverage: 85,
        bonusAverage: 0,
        maximumScore: 100,
        rubricVersionNo: 1,
      },
    ]);
    expect(body.notRanked.find((t) => t.teamId === teamB)).toEqual({
      teamId: teamB,
      teamCode: 'AHL-2',
      name: 'Eagles',
      projectName: 'Solar',
      status: 'in_progress',
    });
    for (const key of [
      'judges',
      'judgeId',
      'evaluationId',
      'provisionalAverage',
      'notes',
      'reasons',
      'assignedJudges',
      'audit',
    ]) {
      expect(JSON.stringify(body)).not.toContain(`"${key}"`);
    }
    expect(JSON.stringify(body)).not.toContain('Judge One');
    expect(JSON.stringify(body)).not.toContain('Private evaluation notes');
    const searched = (await judge.get('/api/judge/leaderboard?search=Judge%20One')).body;
    expect(searched.official.teams).toEqual([]);
    expect(searched.notRanked).toEqual([]);
    // The administrator still gets individual judge results on the original endpoint.
    expect((await results()).official.teams[0]!.judges).toHaveLength(2);
  });

  it('keeps version-incompatible comparisons outside official judge rankings', async () => {
    await publishRubric();
    await assign([teamA, teamB], [judgeId]);
    await evaluate(judge, teamA, S[80]);
    await publishRubric([25, 25, 25, 25], 'New rubric');
    await evaluate(judge, teamB, S[90]);
    const { body } = await judge.get('/api/judge/leaderboard?search=Falcons');
    expect(body.official.available).toBe(false);
    expect(body.official.teams).toEqual([]);
    expect(body.official.unavailableReason).toMatch(/different rubric versions/);
    expect(body.notRanked).toEqual([
      {
        teamId: teamA,
        teamCode: 'AHL-1',
        name: 'Falcons',
        projectName: 'Irrigation',
        status: 'version_conflict',
      },
    ]);
    expect(body).not.toHaveProperty('provisional');
    expect(body.notRanked[0]).not.toHaveProperty('score');
    expect(body.notRanked[0]).not.toHaveProperty('rank');
  });

  it('preserves exact ties and global ranks when judges search or sort scores', async () => {
    await publishRubric();
    await assign([teamA, teamB, teamC], [judgeId]);
    await evaluate(judge, teamA, S[80]);
    await evaluate(judge, teamB, S[80]);
    await evaluate(judge, teamC, S[90]);
    const response = await judge.get('/api/judge/leaderboard?sort=score&dir=asc');
    expect(
      response.body.official.teams.map((t: { rank: number; score: number }) => [t.rank, t.score]),
    ).toEqual([
      [2, 80],
      [2, 80],
      [1, 90],
    ]);
    const search = await judge.get('/api/judge/leaderboard?search=solar');
    expect(search.body.official.teams.map((t: { rank: number }) => t.rank)).toEqual([2]);
    const byName = await judge.get('/api/judge/leaderboard?sort=name&dir=asc');
    expect(byName.body.official.teams.map((t: { name: string }) => t.name)).toEqual([
      'Eagles',
      'Falcons',
      'Lions',
    ]);
  });

  it('blocks expired and disabled sessions from judge leaderboard access', async () => {
    const shortApp = makeTestApp(pool, { idleTimeoutMs: 300 });
    const agent = await signIn(shortApp, 'judge@example.com', PASSWORD);
    await new Promise((r) => setTimeout(r, 700));
    expect((await agent.get('/api/judge/leaderboard')).status).toBe(401);
    await admin.patch(`/api/admin/users/${judgeId}`).send({ status: 'disabled' });
    expect((await judge.get('/api/judge/leaderboard')).status).toBe(401);
  });

  it('serves results and the dashboard to administrators only', async () => {
    for (const path of ['/api/admin/results', '/api/admin/dashboard']) {
      expect((await request(app).get(path)).status, path).toBe(401);
      expect((await judge.get(path)).status, path).toBe(403);
      expect((await admin.get(path)).status, path).toBe(200);
    }
  });

  it('rejects unknown filters, sort fields and oversized searches', async () => {
    for (const q of [
      '?sort=score;DROP TABLE teams',
      '?sort=total',
      '?dir=sideways',
      '?unknown=1',
      `?search=${'x'.repeat(101)}`,
    ]) {
      const res = await admin.get(`/api/admin/results${q}`);
      expect(res.status, q).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('offers no way to write scores through the results API', async () => {
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      expect((await admin[method]('/api/admin/results').send({ score: 100 })).status).toBe(404);
    }
  });

  it('refuses an expired session', async () => {
    const shortApp = makeTestApp(pool, { idleTimeoutMs: 300 });
    const agent = await signIn(shortApp, 'youmna54@gmail.com', PASSWORD);
    expect((await agent.get('/api/admin/results')).status).toBe(200);
    await new Promise((r) => setTimeout(r, 700));
    expect((await agent.get('/api/admin/results')).status).toBe(401);
    expect((await agent.get('/api/admin/dashboard')).status).toBe(401);
  });
});

describe('scoring and ranking', () => {
  it('averages the assigned judges equally and uses competition ranking for exact ties', async () => {
    await publishRubric();
    await assign([teamA, teamB], [judgeId, judge2Id]);
    await assign([teamC], [adminId]);
    await evaluate(judge, teamA, S[80]);
    await evaluate(judge2, teamA, S[90]); // 85
    await evaluate(judge, teamB, S[100]);
    await evaluate(judge2, teamB, S[70]); // 85
    await evaluate(admin, teamC, S[60]); // admin as judge, 60

    const r = await results();
    expect(r.official.available).toBe(true);
    expect(r.official.rubricVersionNo).toBe(1);
    expect(ranking(r)).toEqual([
      ['AHL-1', 1, 85],
      ['AHL-2', 1, 85],
      ['AHL-3', 3, 60],
    ]);
    expect(r.notRanked).toEqual([]);
    expect(r.official.teams[2]!.judges[0]!.role).toBe('admin');
  });

  it('keeps full precision: averages that round alike are not tied', async () => {
    await publishRubric();
    await pool.query(
      "INSERT INTO teams (team_code, name, project_name) VALUES ('AHL-4', 'Hawks', 'Water')",
    );
    const teamD = teamC + 1;
    await assign([teamA], [judgeId, judge2Id, judge3Id]);
    await assign([teamB], [judgeId, judge2Id]);
    // A: (80 + 80 + 81) / 3 = 80.333…   B: (80 + 81) / 2 = 80.5
    await evaluate(judge, teamA, S[80]);
    await evaluate(judge2, teamA, S[80]);
    await evaluate(judge3, teamA, S[81]);
    await evaluate(judge, teamB, S[80]);
    await evaluate(judge2, teamB, S[81]);
    // D: 3 judges, (81 + 80 + 80) / 3 — exactly equal to A, in a different order.
    await assign([teamD], [judgeId, judge2Id, judge3Id]);
    await evaluate(judge, teamD, S[81]);
    await evaluate(judge2, teamD, S[80]);
    await evaluate(judge3, teamD, S[80]);

    const r = await results();
    expect(r.official.teams.map((t) => [t.teamCode, t.rank])).toEqual([
      ['AHL-2', 1],
      ['AHL-1', 2],
      ['AHL-4', 2],
    ]);
    expect(r.official.teams[1]!.score).toBeCloseTo(80.3333333, 6);
    expect(r.official.teams[1]!.score).toBe(r.official.teams[2]!.score);
  });

  it('recomputes from the stored ratings and blocks a team whose stored total disagrees', async () => {
    await publishRubric();
    await assign([teamA], [judgeId]);
    const e = await evaluate(judge, teamA, S[80]);
    // The database refuses to change a submitted evaluation…
    await expect(
      pool.query('UPDATE evaluations SET total_score = 99 WHERE id = ?', [e.id]),
    ).rejects.toThrow();
    // …so simulate corruption written behind its back (trigger briefly removed).
    const [[trigger]] = (await pool.query(
      'SHOW CREATE TRIGGER trg_eval_before_update',
    )) as unknown as [RowDataPacket[]];
    const definition = String(trigger!['SQL Original Statement']);
    await pool.query('DROP TRIGGER trg_eval_before_update');
    try {
      await pool.query('UPDATE evaluations SET total_score = 99 WHERE id = ?', [e.id]);
    } finally {
      await pool.query(definition);
    }
    const r = await results();
    expect(r.official.teams).toEqual([]);
    const team = notRanked(r, 'AHL-1');
    expect(team.status).toBe('blocked');
    expect(team.reasons.join(' ')).toMatch(/does not match the ratings/);
  });

  it('never writes to the database while computing results', async () => {
    await publishRubric();
    await assign([teamA], [judgeId]);
    await evaluate(judge, teamA, S[80]);
    const checksum = async () =>
      JSON.stringify(
        (
          await pool.query<RowDataPacket[]>(
            'CHECKSUM TABLE evaluations, evaluation_scores, evaluation_events, team_judges, teams, audit_log',
          )
        )[0],
      );
    const before = await checksum();
    await results();
    await dashboard();
    expect(await checksum()).toBe(before);
  });
});

describe('eligibility and statuses', () => {
  it('lists incomplete teams separately with a provisional average and the reason', async () => {
    await publishRubric();
    await pool.query(
      "INSERT INTO teams (team_code, name, project_name) VALUES ('AHL-4', 'Hawks', 'Water')",
    );
    await assign([teamA], [judgeId, judge2Id]);
    await assign([teamB], [judgeId]);
    await evaluate(judge, teamA, S[80]);
    await save(judge2, await start(judge2, teamA), [5, 5]); // draft
    // teamB: assigned, not started. teamC: no judges. AHL-4: no judges.

    const r = await results();
    expect(r.official.available).toBe(false);
    expect(r.official.unavailableReason).toMatch(/No team is ready/);
    const a = notRanked(r, 'AHL-1');
    expect(a.status).toBe('in_progress');
    expect(a.provisionalAverage).toBe(80);
    expect(a.reasons).toEqual(['1 of 2 judges submitted.', 'Waiting for Judge Two.']);
    expect(notRanked(r, 'AHL-2').status).toBe('not_started');
    expect(notRanked(r, 'AHL-2').provisionalAverage).toBeNull();
    expect(notRanked(r, 'AHL-3').status).toBe('unassigned');
    expect(r.totals).toEqual({
      activeTeams: 4,
      ready: 0,
      blocked: 0,
      inProgress: 1,
      notStarted: 1,
      unassigned: 2,
    });
  });

  it('follows reopen and resubmission', async () => {
    await publishRubric();
    await assign([teamA], [judgeId, judge2Id]);
    const e1 = await evaluate(judge, teamA, S[80]);
    await evaluate(judge2, teamA, S[90]);
    expect(ranking(await results())).toEqual([['AHL-1', 1, 85]]);

    expect((await reopen(e1.id)).status).toBe(200);
    let r = await results();
    expect(r.official.teams).toEqual([]);
    const team = notRanked(r, 'AHL-1');
    expect(team.status).toBe('in_progress');
    expect(team.provisionalAverage).toBe(90);
    expect(team.reasons).toContain('Reopened for Judge One: waiting for resubmission.');
    expect(team.judges.find((j) => j.judgeId === judgeId)!.reopened).toBe(true);

    const reopened = (await judge.get(`/api/judge/teams/${teamA}/evaluation`)).body
      .evaluation as EvaluationDetail;
    await submit(judge, await save(judge, reopened, S[100]));
    r = await results();
    expect(ranking(r)).toEqual([['AHL-1', 1, 95]]);
  });

  it('follows judges being added to and removed from a completed team', async () => {
    await publishRubric();
    await assign([teamA], [judgeId, judge2Id]);
    await evaluate(judge, teamA, S[80]);
    await evaluate(judge2, teamA, S[90]);

    await assign([teamA], [judge3Id]);
    let r = await results();
    expect(notRanked(r, 'AHL-1').status).toBe('in_progress');
    expect(notRanked(r, 'AHL-1').reasons).toContain('Waiting for Judge Three.');

    await evaluate(judge3, teamA, S[60]);
    expect(ranking(await results())).toEqual([['AHL-1', 1, 76.667]]);

    // Removing a judge excludes their evaluation; it stays in the database as history.
    expect((await admin.delete(`/api/admin/teams/${teamA}/judges/${judge3Id}`)).status).toBe(204);
    r = await results();
    expect(ranking(r)).toEqual([['AHL-1', 1, 85]]);
    const [[kept]] = (await pool.query(
      "SELECT COUNT(*) AS n FROM evaluations WHERE judge_id = ? AND status = 'submitted'",
      [judge3Id],
    )) as unknown as [RowDataPacket[]];
    expect(Number(kept!.n)).toBe(1);
  });

  it('drops archived teams and restores them when reactivated', async () => {
    await publishRubric();
    await assign([teamA, teamB], [judgeId]);
    await evaluate(judge, teamA, S[80]);
    await evaluate(judge, teamB, S[90]);
    expect(ranking(await results())).toEqual([
      ['AHL-2', 1, 90],
      ['AHL-1', 2, 80],
    ]);
    expect(
      (await admin.post(`/api/admin/teams/${teamB}/archive`).send({ reason: 'Withdrew' })).status,
    ).toBe(200);
    let r = await results();
    expect(ranking(r)).toEqual([['AHL-1', 1, 80]]);
    expect(r.notRanked.map((t) => t.teamCode)).not.toContain('AHL-2');
    expect((await dashboard()).teams).toEqual({ active: 2, archived: 1 });

    expect((await admin.post(`/api/admin/teams/${teamB}/reactivate`).send({})).status).toBe(200);
    r = await results();
    expect(ranking(r)).toEqual([
      ['AHL-2', 1, 90],
      ['AHL-1', 2, 80],
    ]);
  });

  it('blocks a team with a disabled assigned judge instead of silently excluding them', async () => {
    await publishRubric();
    await assign([teamA], [judgeId, judge2Id]);
    await evaluate(judge, teamA, S[80]);
    await evaluate(judge2, teamA, S[90]);
    expect(
      (await admin.patch(`/api/admin/users/${judge2Id}`).send({ status: 'disabled' })).status,
    ).toBe(200);
    let r = await results();
    expect(r.official.teams).toEqual([]);
    const team = notRanked(r, 'AHL-1');
    expect(team.status).toBe('blocked');
    expect(team.reasons.join(' ')).toMatch(/Judge Two is assigned but disabled/);
    expect(r.totals.blocked).toBe(1);

    expect(
      (await admin.patch(`/api/admin/users/${judge2Id}`).send({ status: 'active' })).status,
    ).toBe(200);
    r = await results();
    expect(ranking(r)).toEqual([['AHL-1', 1, 85]]);
  });
});

describe('rubric versions', () => {
  it('keeps the ranking on one version and warns when a new version is published', async () => {
    await publishRubric();
    await assign([teamA, teamB], [judgeId]);
    await evaluate(judge, teamA, S[80]);
    await publishRubric([25, 25, 25, 25], 'Second rubric');
    let r = await results();
    expect(ranking(r)).toEqual([['AHL-1', 1, 80]]);
    expect(r.versionWarnings.join(' ')).toMatch(/uses rubric v1, but v2 is now published/);

    // A team then scored entirely on v2 cannot be compared with v1 teams.
    await evaluate(judge, teamB, S[80]);
    r = await results();
    expect(r.official.available).toBe(false);
    expect(r.official.teams).toEqual([]);
    expect(r.official.unavailableReason).toMatch(
      /different rubric versions \(v1: AHL-1; v2: AHL-2\)/,
    );
    expect(r.provisional.map((g) => [g.rubricVersionNo, g.teams.map((t) => t.teamCode)])).toEqual([
      [1, ['AHL-1']],
      [2, ['AHL-2']],
    ]);
    const d = await dashboard();
    expect(d.officialAvailable).toBe(false);
    expect(d.topTeams).toEqual([]);
  });

  it('blocks a team whose judges submitted on different versions', async () => {
    await publishRubric();
    await assign([teamA], [judgeId, judge2Id]);
    await evaluate(judge, teamA, S[80]);
    await publishRubric([25, 25, 25, 25], 'Second rubric');
    await evaluate(judge2, teamA, S[80]);
    const r = await results();
    const team = notRanked(r, 'AHL-1');
    expect(team.status).toBe('blocked');
    expect(team.versions).toEqual([1, 2]);
    expect(team.reasons.join(' ')).toMatch(/different rubric versions \(v1, v2\)/);
    // The original submitted scores are untouched.
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT total_score FROM evaluations WHERE team_id = ? AND status = 'submitted' ORDER BY id",
      [teamA],
    );
    expect(rows.map((x) => Number(x.total_score))).toEqual([80, 80]);
  });
});

describe('search and sort', () => {
  it('filters by team, project or judge and sorts deterministically', async () => {
    await publishRubric();
    await assign([teamA, teamB, teamC], [judgeId]);
    await evaluate(judge, teamA, S[80]);
    await evaluate(judge, teamB, S[80]);
    await evaluate(judge, teamC, S[90]);
    let r = await results('?search=solar');
    expect(r.official.teams.map((t) => [t.teamCode, t.rank])).toEqual([['AHL-2', 2]]);
    r = await results('?sort=name&dir=asc');
    expect(r.official.teams.map((t) => t.name)).toEqual(['Eagles', 'Falcons', 'Lions']);
    r = await results('?sort=rank&dir=desc');
    expect(r.official.teams.map((t) => t.teamCode)).toEqual(['AHL-1', 'AHL-2', 'AHL-3']);
    r = await results('?search=judge%20one');
    expect(r.official.teams).toHaveLength(3);
  });
});

describe('dashboard', () => {
  it('reports real progress figures', async () => {
    await publishRubric();
    await assign([teamA], [judgeId, judge2Id]);
    await assign([teamB], [judgeId, adminId]);
    await evaluate(judge, teamA, S[80]);
    await evaluate(judge2, teamA, S[90]);
    await evaluate(judge, teamB, S[60]);
    await save(admin, await start(admin, teamB), [4]);
    const [old] = await pool.query(
      "INSERT INTO teams (team_code, name, project_name) VALUES ('AHL-9', 'Old', 'Old')",
    );
    const oldId = (old as { insertId: number }).insertId;
    expect(
      (await admin.post(`/api/admin/teams/${oldId}/archive`).send({ reason: 'Duplicate' })).status,
    ).toBe(200);

    const d = await dashboard();
    expect(d.teams).toEqual({ active: 3, archived: 1 });
    expect(d.accounts).toEqual({ judges: 3, administrators: 2, participatingJudges: 3 });
    expect(d.evaluations).toMatchObject({
      required: 4,
      submitted: 3,
      draft: 1,
      notStarted: 0,
      pending: 1,
      completionPercent: 75,
      judgesWithPending: 1,
      teamsWaiting: 1,
    });
    expect(d.evaluations.averageSubmittedScore).toBeCloseTo(76.6667, 3);
    expect(d.teamStatus).toEqual({
      unassigned: 1,
      not_started: 0,
      in_progress: 1,
      ready: 1,
      blocked: 0,
    });
    expect(d.judges[0]).toMatchObject({ fullName: 'Youmna Admin', pending: 1, draft: 1 });
    expect(d.officialAvailable).toBe(true);
    expect(d.topTeams.map((t) => [t.teamCode, t.rank, t.score])).toEqual([['AHL-1', 1, 85]]);
  });

  it('shows zeros, not errors, on an empty competition', async () => {
    const d = await dashboard();
    expect(d.evaluations.completionPercent).toBeNull();
    expect(d.evaluations.averageSubmittedScore).toBeNull();
    expect(d.topTeams).toEqual([]);
    expect(d.teamStatus.unassigned).toBe(3);
  });
});

describe('concurrency', () => {
  it('stays consistent while judges submit at the same time as results are read', async () => {
    await publishRubric();
    await assign([teamA, teamB, teamC], [judgeId, judge2Id, judge3Id]);
    const drafts = await Promise.all(
      [judge, judge2, judge3].flatMap((agent) =>
        [teamA, teamB, teamC].map(async (t) => ({
          agent,
          e: await save(agent, await start(agent, t), S[80]),
        })),
      ),
    );
    const reads: Promise<ResultsResponse>[] = [];
    await Promise.all(
      drafts.map(async ({ agent, e }, i) => {
        if (i % 2 === 0) reads.push(results());
        await submit(agent, e);
      }),
    );
    for (const r of await Promise.all(reads)) {
      // Every snapshot is internally consistent: ranked teams are complete.
      for (const t of r.official.teams) expect(t.submitted).toBe(t.assignedJudges);
      for (const t of r.notRanked) expect(t.status === 'ready').toBe(false);
    }
    expect(ranking(await results())).toEqual([
      ['AHL-1', 1, 80],
      ['AHL-2', 1, 80],
      ['AHL-3', 1, 80],
    ]);
  });
});

describe('administrator submission corrections', () => {
  const body = (e: EvaluationDetail, stars = S[100]) => ({
    rowVersion: e.rowVersion,
    ratings: e.ratings.map((r, i) => ({ ...r, rating: stars[i], note: 'Corrected criterion' })),
    sectionNotes: e.sectionNotes.map((n) => ({ ...n, note: 'Corrected section' })),
    overallNotes: 'Corrected overall',
    reason: 'Correcting a scoring mistake',
    confirmed: true,
  });
  it('corrects another judge without assignment, retains snapshots, locks judges and recalculates ranks and dashboard', async () => {
    await publishRubric();
    await assign([teamA, teamB], [judgeId]);
    const e = await evaluate(judge, teamA, S[80], 'Original notes');
    await evaluate(judge, teamB, S[90]);
    const original = (await admin.get(`/api/admin/evaluations/${e.id}/history`)).body.events;
    const res = await admin.put(`/api/admin/evaluations/${e.id}/submission`).send(body(e));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.evaluation).toMatchObject({
      status: 'submitted',
      submittedAt: e.submittedAt,
      totalScore: 100,
      judgeId,
      teamId: teamA,
      rubricVersionId: e.rubricVersionId,
      rowVersion: e.rowVersion + 1,
      overallNotes: 'Corrected overall',
    });
    expect(res.body.lastAdminCorrection.byEmail).toBe('youmna54@gmail.com');
    const history = (await admin.get(`/api/admin/evaluations/${e.id}/history`)).body.events;
    expect(history.slice(0, original.length)).toEqual(original);
    const change = history.at(-1);
    expect(change).toMatchObject({
      event: 'admin_corrected',
      previousScore: 80,
      totalScore: 100,
      reason: 'Correcting a scoring mistake',
    });
    expect(change.previousSnapshot.overallNotes).toBe('overall Original notes');
    expect(change.previousSnapshot.ratings[0].note).toBe('Original notes');
    expect(change.snapshot.ratings[0]).toMatchObject({ rating: 5, note: 'Corrected criterion' });
    expect(change.snapshot.sections[0].note).toBe('Corrected section');
    expect(ranking(await results())).toEqual([
      ['AHL-1', 1, 100],
      ['AHL-2', 2, 90],
    ]);
    expect((await dashboard()).evaluations.averageSubmittedScore).toBe(95);
    expect(
      (
        await judge
          .put(`/api/judge/evaluations/${e.id}`)
          .send({ ...body(res.body.evaluation), reason: undefined, confirmed: undefined })
      ).status,
    ).toBe(409);
    await expect(
      pool.query('UPDATE evaluation_events SET reason=? WHERE id=?', ['tamper', change.id]),
    ).rejects.toThrow();
    await expect(
      pool.query('UPDATE evaluations SET total_score=1 WHERE id=?', [e.id]),
    ).rejects.toThrow();
  });
  it('allows own submissions and keeps the original retired rubric weights', async () => {
    await publishRubric();
    await assign([teamA], [adminId]);
    const e = await evaluate(admin, teamA, S[80]);
    await publishRubric([25, 25, 25, 25]);
    const res = await admin.put(`/api/admin/evaluations/${e.id}/submission`).send(body(e, S[90]));
    expect(res.status).toBe(200);
    expect(res.body.evaluation.totalScore).toBe(90);
    expect(res.body.evaluation.rubricVersionId).toBe(e.rubricVersionId);
  });
  it('refuses nonadmins, invalid reasons, missing confirmation, invalid ratings and identity changes without altering history', async () => {
    await publishRubric();
    await assign([teamA], [judgeId]);
    const e = await evaluate(judge, teamA, S[80]);
    const url = `/api/admin/evaluations/${e.id}/submission`;
    expect((await judge.put(url).send(body(e))).status).toBe(403);
    expect((await request(app).put(url).send(body(e))).status).toBe(401);
    for (const patch of [
      { reason: '' },
      { confirmed: false },
      { teamId: teamB },
      { judgeId: adminId },
      { rubricVersionId: 999 },
      { ratings: body(e).ratings.slice(1) },
      { ratings: body(e).ratings.map((r) => ({ ...r, rating: 6 })) },
      { ratings: body(e).ratings.map((r) => ({ ...r, rating: 1.5 })) },
      { ratings: body(e).ratings.map((r) => ({ ...r, rating: null })) },
      { ratings: body(e).ratings.map((r) => ({ ...r, criterionId: 999 })) },
    ])
      expect((await admin.put(url).send({ ...body(e), ...patch })).status).toBe(400);
    expect((await admin.get(`/api/admin/evaluations/${e.id}`)).body.evaluation.totalScore).toBe(80);
    expect(
      (await admin.get(`/api/admin/evaluations/${e.id}/history`)).body.events.filter(
        (x: { event: string }) => x.event === 'admin_corrected',
      ),
    ).toHaveLength(0);
  });
  it('rejects stale concurrent edits rather than silently overwriting', async () => {
    await publishRubric();
    await assign([teamA], [judgeId]);
    const e = await evaluate(judge, teamA, S[80]);
    const responses = await Promise.all(
      [S[90], S[100]].map((stars) =>
        admin.put(`/api/admin/evaluations/${e.id}/submission`).send(body(e, stars)),
      ),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(
      (await admin.get(`/api/admin/evaluations/${e.id}/history`)).body.events.filter(
        (x: { event: string }) => x.event === 'admin_corrected',
      ),
    ).toHaveLength(1);
  });
  it('corrects archived and unassigned historical submissions without restoring ranking eligibility', async () => {
    await publishRubric();
    await assign([teamA, teamB], [judgeId]);
    const a = await evaluate(judge, teamA, S[80]);
    const b = await evaluate(judge, teamB, S[90]);
    await admin.post(`/api/admin/teams/${teamA}/archive`).send({ reason: 'Historical team' });
    await admin.delete(`/api/admin/teams/${teamB}/judges/${judgeId}`);
    for (const e of [a, b])
      expect(
        (await admin.put(`/api/admin/evaluations/${e.id}/submission`).send(body(e))).status,
      ).toBe(200);
    expect((await results()).official.teams).toHaveLength(0);
    const historical = await admin.get('/api/admin/evaluations/historical');
    expect(historical.status).toBe(200);
    expect(historical.body.evaluations.map((e: { id: number }) => e.id).sort()).toEqual(
      [a.id, b.id].sort(),
    );
    expect((await judge.get('/api/admin/evaluations/historical')).status).toBe(403);
    expect((await admin.get(`/api/admin/evaluations/${a.id}`)).body.team.status).toBe('archived');
    expect((await admin.get(`/api/admin/evaluations/${b.id}`)).body.judgeAssigned).toBe(false);
  });
});
