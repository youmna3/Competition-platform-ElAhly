import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { contentOf, defaultRubricContent } from '@judging/shared';
import { freshTestDatabase, dropDatabase, TEST_DB, testTarget, testMysql } from './helpers.js';
import { createDraft, saveDraft, publishDraft, getAdminRubric } from '../../src/rubric/service.js';
import {
  startEvaluation,
  saveEvaluation,
  submitEvaluation,
} from '../../src/evaluations/service.js';
import { correctSubmission } from '../../src/review/service.js';
import { getResults } from '../../src/results/service.js';
import { buildReport } from '../../src/reports/service.js';
import { encodeXlsx, encodeCsv } from '../../src/reports/format.js';
import { makeTestApp, signIn } from './appHelpers.js';
import { getAdminEvaluation } from '../../src/review/service.js';
import request from 'supertest';
import bcrypt from 'bcryptjs';

let pool: Pool;
beforeAll(async () => {
  await freshTestDatabase();
  pool = testMysql.createPool(testTarget);
});

afterAll(async () => {
  await pool?.end();
  await dropDatabase(TEST_DB);
});

it('restores old versions, retains stable draft IDs and scores three independent bonus submissions with immutable corrections', async () => {
  const [u] = await pool.query<ResultSetHeader>(
    "INSERT INTO users(email,full_name,password_hash,role) VALUES ('dynamic-admin@example.com','Admin','$2b$04$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','admin')",
  );
  const actor = { id: u.insertId, email: 'dynamic-admin@example.com' };
  const legacy = defaultRubricContent();
  legacy.title = 'Legacy';
  legacy.sections.forEach((s) => (s.weightPercent = 25));
  let state = await createDraft(pool, actor);
  let draft = await saveDraft(pool, actor, state.draft!.revision, legacy);
  const v1 = (await publishDraft(pool, actor, draft.revision, false)).published;
  const [t] = await pool.query<ResultSetHeader>(
    "INSERT INTO teams(team_code,name,project_name) VALUES ('DYNAMIC','Dynamic team','Project')",
  );
  await pool.query('INSERT INTO team_judges(team_id,judge_id) VALUES (?,?)', [
    t.insertId,
    actor.id,
  ]);
  await pool.query(
    "UPDATE competition c JOIN rubric r ON r.id=c.id SET c.state='judging_open',c.locked_rubric_version_id=r.published_version_id WHERE c.id=1",
  );
  let old = await startEvaluation(pool, actor, t.insertId);
  old = await saveEvaluation(pool, actor, old.id, old.rowVersion, {
    ratings: old.ratings.map((r) => ({ ...r, rating: 4 })),
    sectionNotes: old.sectionNotes,
    overallNotes: 'original',
  });
  old = (await submitEvaluation(pool, actor, old.id, old.rowVersion)).evaluation;
  expect(old.totalScore).toBe(80);
  const [originalRows] = await pool.query<RowDataPacket[]>(
    'SELECT * FROM evaluation_events WHERE evaluation_id=?',
    [old.id],
  );

  await pool.query(
    "UPDATE competition SET state='preparation',locked_rubric_version_id=NULL WHERE id=1",
  );
  state = await createDraft(pool, actor);
  const newer = contentOf(state.draft!);
  newer.sections.forEach((s) => (s.weightPercent = 20));
  newer.sections.push({
    title: 'Fifth Actual',
    description: '',
    weightPercent: 20,
    criteria: [1, 2].map((n) => ({
      title: `Fifth ${n}`,
      description: '',
      guidelines: 'Preserved guidance',
    })),
  });
  newer.sections.push({
    title: 'Bonus',
    description: 'Optional',
    type: 'bonus',
    weightPercent: null,
    maxBonusPoints: 10,
    criteria: [1, 2].map((n) => ({ title: `Bonus ${n}`, description: '', guidelines: '' })),
  });
  draft = await saveDraft(pool, actor, state.draft!.revision, newer);
  const ids = draft.sections.map((s) => [s.id, ...s.criteria.map((c) => c.id)]);
  draft = await saveDraft(pool, actor, draft.revision, contentOf(draft));
  expect(draft.sections.map((s) => [s.id, ...s.criteria.map((c) => c.id)])).toEqual(ids);
  const v2 = (await publishDraft(pool, actor, draft.revision, true)).published;
  state = await createDraft(pool, actor, v1.id);
  expect(state.published!.id).toBe(v2.id);
  expect(state.versions!.map((v) => v.id)).toContain(v2.id);
  expect(state.draft!.sections[0]!.weightPercent).toBe(25);
  expect(state.draft!.sections[0]!.id).not.toBe(v1.sections[0]!.id);
  // Legacy fixture import: keep the restored draft unpublished while evaluating v2.
  await pool.query(
    "UPDATE competition c JOIN rubric r ON r.id=c.id SET c.state='judging_open',c.locked_rubric_version_id=r.published_version_id WHERE c.id=1",
  );
  // Keep restored draft unpublished. New evaluations still use version 2.
  const [team] = await pool.query<ResultSetHeader>(
    "INSERT INTO teams(team_code,name,project_name) VALUES ('BONUS','Bonus team','Bonus Project')",
  );
  const judges = [actor];
  for (let n = 1; n <= 2; n++) {
    const email = `dynamic-judge${n}@example.com`;
    const [j] = await pool.query<ResultSetHeader>(
      "INSERT INTO users(email,full_name,password_hash,role) VALUES (?,?, '$2b$04$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','judge')",
      [email, `Judge ${n}`],
    );
    judges.push({ id: j.insertId, email });
  }
  const evaluations = [];
  for (const judge of judges) {
    await pool.query('INSERT INTO team_judges(team_id,judge_id) VALUES (?,?)', [
      team.insertId,
      judge.id,
    ]);
    let e = await startEvaluation(pool, judge, team.insertId);
    const input = {
      ratings: e.ratings.map((r, i) => ({ ...r, rating: i >= 10 ? null : 5 })),
      sectionNotes: e.sectionNotes,
      overallNotes: 'bonus omitted',
    };
    e = await saveEvaluation(pool, judge, e.id, e.rowVersion, input);
    e = (await submitEvaluation(pool, judge, e.id, e.rowVersion)).evaluation;
    expect(e).toMatchObject({
      baseScore: 100,
      bonusScore: 0,
      totalScore: 100,
      maximumScore: 110,
      requiredCount: 10,
    });
    evaluations.push(e);
  }
  const e = evaluations[1]!;
  const correction = {
    ratings: e.ratings.map((r, i) => ({ ...r, rating: i >= 10 ? 5 : 5, note: 'Corrected' })),
    sectionNotes: e.sectionNotes,
    overallNotes: 'Awarded bonus',
  };
  const corrected = await correctSubmission(
    pool,
    actor,
    e.id,
    e.rowVersion,
    correction,
    'Bonus evidence verified',
  );
  expect(corrected.evaluation).toMatchObject({
    baseScore: 100,
    bonusScore: 10,
    totalScore: 110,
    status: 'submitted',
  });
  await expect(
    correctSubmission(pool, actor, e.id, e.rowVersion, correction, 'Stale correction attempt'),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    saveEvaluation(pool, judges[1]!, e.id, corrected.evaluation.rowVersion, correction),
  ).rejects.toBeTruthy();
  const result = await getResults(pool, { sort: 'rank', dir: 'asc' });
  const bonusTeam = [
    ...result.notRanked,
    ...result.provisional.flatMap((g) => g.teams),
    ...result.official.teams,
  ].find((t) => t.teamId === team.insertId)!;
  expect(bonusTeam.provisionalAverage).toBeCloseTo(310 / 3, 8);
  expect(bonusTeam.bonusAverage).toBeCloseTo(10 / 3, 8);
  expect(result.official.available).toBe(false); // Legacy and new versions cannot rank together.
  const [stillOriginal] = await pool.query<RowDataPacket[]>(
    'SELECT * FROM evaluation_events WHERE evaluation_id=?',
    [old.id],
  );
  expect(stillOriginal).toEqual(originalRows);
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT total_score FROM evaluations WHERE id=?',
    [old.id],
  );
  expect(Number(rows[0]!.total_score)).toBe(80);
  expect((await getAdminRubric(pool)).published!.id).toBe(v2.id);
});

it('exports authoritative scores, normalized dynamic criteria, progress, complete correction snapshots and version history; authorizes all downloads', async () => {
  const results = await buildReport(pool, 'results', {});
  const bonus = results.sheets[0]!.rows.find((r) => r[2] === 'BONUS')!;
  expect(bonus[0]).toBeNull();
  expect(bonus[11]).toBeCloseTo(310 / 3, 8);
  expect(bonus[12]).toBe(110);
  const evaluations = await buildReport(pool, 'evaluations', { version: 2 });
  expect(evaluations.sheets[0]!.rows).toHaveLength(3);
  expect(evaluations.sheets.find((s) => s.name === 'Criteria')!.rows).toHaveLength(36);
  expect(evaluations.sheets.find((s) => s.name === 'Sections')!.rows).toHaveLength(18);
  const corrections = await buildReport(pool, 'corrections', {});
  expect(corrections.sheets[0]!.rows).toHaveLength(1);
  expect(corrections.sheets[0]!.rows[0]!.slice(10, 14)).toEqual([
    'Bonus evidence verified',
    100,
    110,
    2,
  ]);
  const chunks = corrections.sheets.find((s) => s.name === 'Immutable Snapshots')!;
  const previous = JSON.parse(
    chunks.rows
      .filter((r) => r[2] === 'Before')
      .map((r) => r[4])
      .join(''),
  );
  const updated = JSON.parse(
    chunks.rows
      .filter((r) => r[2] === 'After')
      .map((r) => r[4])
      .join(''),
  );
  expect(previous).toMatchObject({ totalScore: 100, bonusScore: 0, overallNotes: 'bonus omitted' });
  expect(updated).toMatchObject({ totalScore: 110, bonusScore: 10, overallNotes: 'Awarded bonus' });
  expect(updated.ratings).toHaveLength(12);
  const progress = await buildReport(pool, 'progress', {});
  const team = progress.sheets[0]!.rows.find((r) => r[2] === 'BONUS')!;
  expect(team.slice(6, 9)).toEqual([3, 0, 100]);
  expect(progress.sheets.find((s) => s.name === 'Judge Workload')!.rows).toHaveLength(3);
  const history = await buildReport(pool, 'rubrics', {});
  expect(history.sheets.find((s) => s.name === 'Versions')!.rows).toHaveLength(3);
  expect((await buildReport(pool, 'evaluations', { version: 999 })).sheets[0]!.rows).toHaveLength(
    0,
  );
  for (const report of [results, evaluations, corrections, progress, history]) {
    expect(encodeXlsx(report).readUInt32LE(0)).toBe(0x04034b50);
    for (const s of report.sheets)
      expect(encodeCsv(report, s.name).toString()).toContain('Generated at (UTC)');
  }
  const password = 'Isolated-Report-Password-2026!';
  for (const role of ['admin', 'judge'])
    await pool.query(
      'INSERT INTO users(email,full_name,password_hash,role,must_change_password) VALUES (?,?,?,?,FALSE)',
      [`report-${role}@example.com`, `Report ${role}`, bcrypt.hashSync(password, 4), role],
    );
  const app = makeTestApp(pool),
    admin = await signIn(app, 'report-admin@example.com', password),
    judge = await signIn(app, 'report-judge@example.com', password);
  for (const kind of ['results', 'evaluations', 'progress', 'corrections', 'rubrics']) {
    expect((await request(app).get(`/api/admin/reports/${kind}`)).status).toBe(401);
    expect((await judge.get(`/api/admin/reports/${kind}`)).status).toBe(403);
    const response = await admin.get(`/api/admin/reports/${kind}?format=xlsx`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.headers['content-type']).toContain('spreadsheetml.sheet');
    expect(response.headers['cache-control']).toBe('no-store');
    expect((await admin.get(`/api/admin/reports/${kind}?format=csv`)).status).toBe(200);
  }
  for (const query of [
    '?teamId=-1',
    '?format=html',
    '?unknown=1',
    '?from=bad',
    '?format=csv&sheet=Missing',
  ])
    expect((await admin.get('/api/admin/reports/evaluations' + query)).status).toBe(400);
  expect((await admin.get('/api/admin/reports/rubrics?judgeId=1')).status).toBe(400);
});

it('preserves large before/after snapshots and permits historical bonus corrections without restoring ranking eligibility', async () => {
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT e.id,e.judge_id,t.id AS team_id FROM evaluations e JOIN teams t ON t.id=e.team_id WHERE t.team_code='BONUS' ORDER BY e.id",
  );
  const id = Number(rows[1]!.id),
    teamId = Number(rows[1]!.team_id),
    judgeId = Number(rows[1]!.judge_id);
  const [[admin]] = await pool.query<RowDataPacket[]>(
    "SELECT id,email FROM users WHERE email='dynamic-admin@example.com'",
  );
  const actor = { id: Number(admin!.id), email: admin!.email };
  const before = await getAdminEvaluation(pool, id);
  await pool.query('DELETE FROM team_judges WHERE team_id=? AND judge_id=?', [teamId, judgeId]);
  const input = {
    ratings: before.evaluation.ratings.map((r) => ({
      ...r,
      note: 'Criterion evidence '.repeat(100).slice(0, 1800),
    })),
    sectionNotes: before.evaluation.sectionNotes.map((n) => ({
      ...n,
      note: 'Section evidence '.repeat(230).slice(0, 3800),
    })),
    overallNotes: 'Overall evidence '.repeat(290).slice(0, 4800),
  };
  const after = await correctSubmission(
    pool,
    actor,
    id,
    before.evaluation.rowVersion,
    input,
    'Historical evidence correction',
  );
  expect(after.judgeAssigned).toBe(false);
  const report = await buildReport(pool, 'corrections', { teamId, judgeId });
  expect(report.sheets[0]!.rows).toHaveLength(2);
  const lastId = Math.max(...report.sheets[0]!.rows.map((r) => Number(r[0])));
  const chunks = report.sheets
    .find((s) => s.name === 'Immutable Snapshots')!
    .rows.filter((r) => r[0] === lastId && r[2] === 'After');
  expect(chunks.length).toBeGreaterThan(1);
  expect(JSON.parse(chunks.map((r) => r[4]).join('')).overallNotes).toBe(input.overallNotes);
  expect(encodeXlsx(report).length).toBeGreaterThan(1000);
  const [stored] = await pool.query<RowDataPacket[]>(
    'SELECT snapshot,previous_snapshot FROM evaluation_events WHERE id=?',
    [lastId],
  );
  expect(chunks.map((r) => r[4]).join('')).toBe(stored[0]!.snapshot);
  const results = await buildReport(pool, 'results', { teamId });
  expect(results.sheets[0]!.rows[0]![11]).toBe(100); // Unassigned judge's 110 is excluded.
  await pool.query("UPDATE teams SET status='archived',archived_at=NOW() WHERE id=?", [teamId]);
  const archived = await correctSubmission(
    pool,
    actor,
    id,
    after.evaluation.rowVersion,
    input,
    'Archived historical evidence correction',
  );
  expect(archived.team.status).toBe('archived');
  const progress = await buildReport(pool, 'progress', { teamId });
  expect(progress.sheets[0]!.rows).toHaveLength(0);
  const archivedRows = progress.sheets.find((s) => s.name === 'Archived Team Progress')!.rows;
  expect(archivedRows).toHaveLength(2);
  expect(
    archivedRows.every((r) => JSON.stringify(r.slice(9, 13)) === JSON.stringify([2, 2, 0, 100])),
  ).toBe(true);
});

it('rejects partial or invalid bonus submissions and invalid restored draft weights on the backend', async () => {
  const [[admin]] = await pool.query<RowDataPacket[]>(
    "SELECT id,email FROM users WHERE email='dynamic-admin@example.com'",
  );
  const actor = { id: Number(admin!.id), email: admin!.email };
  const [team] = await pool.query<ResultSetHeader>(
    "INSERT INTO teams(team_code,name,project_name) VALUES ('PARTIAL','Partial bonus','Project')",
  );
  await pool.query('INSERT INTO team_judges(team_id,judge_id) VALUES (?,?)', [
    team.insertId,
    actor.id,
  ]);
  let e = await startEvaluation(pool, actor, team.insertId);
  const input = {
    ratings: e.ratings.map((r, i) => ({ ...r, rating: i === 11 ? null : 5 })),
    sectionNotes: e.sectionNotes,
    overallNotes: '',
  };
  e = await saveEvaluation(pool, actor, e.id, e.rowVersion, input);
  await expect(submitEvaluation(pool, actor, e.id, e.rowVersion)).rejects.toMatchObject({
    status: 400,
  });
  input.ratings[11]!.rating = 6;
  await expect(saveEvaluation(pool, actor, e.id, e.rowVersion, input)).rejects.toMatchObject({
    status: 400,
  });
  await pool.query(
    "UPDATE competition SET state='preparation',locked_rubric_version_id=NULL WHERE id=1",
  );
  const state = await getAdminRubric(pool),
    content = contentOf(state.draft!);
  content.sections[0]!.weightPercent = 24;
  const draft = await saveDraft(pool, actor, state.draft!.revision, content);
  await expect(publishDraft(pool, actor, draft.revision, true)).rejects.toMatchObject({
    status: 400,
  });
  content.sections[0]!.id = 999999;
  await expect(saveDraft(pool, actor, draft.revision, content)).rejects.toMatchObject({
    status: 400,
  });
  expect((await getAdminRubric(pool)).published!.versionNo).toBe(2);
});
