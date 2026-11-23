import { beforeAll, afterAll, it, expect } from 'vitest';
import type { Pool, ResultSetHeader } from 'mysql2/promise';
import { defaultRubricContent, contentOf } from '@judging/shared';
import { freshTestDatabase, dropDatabase, TEST_DB, testTarget, testMysql } from './helpers.js';
import { createDraft, saveDraft, publishDraft, getAdminRubric } from '../../src/rubric/service.js';
import {
  startEvaluation,
  saveEvaluation,
  submitEvaluation,
} from '../../src/evaluations/service.js';
import { correctSubmission, getEvaluationHistory } from '../../src/review/service.js';
import { getResults } from '../../src/results/service.js';
import { buildReport } from '../../src/reports/service.js';
import { encodeXlsx, encodeCsv } from '../../src/reports/format.js';
let pool: Pool;
beforeAll(async () => {
  await freshTestDatabase();
  pool = testMysql.createPool(testTarget);
});
afterAll(async () => {
  await pool?.end();
  await dropDatabase(TEST_DB);
});
it('keeps historical scores, stable reordered IDs, independent submissions, precise corrections and normalized exports', async () => {
  const actors = [];
  for (let n = 0; n < 3; n++) {
    const email = `flexible-${n}@example.com`;
    const [r] = await pool.query<ResultSetHeader>(
      'INSERT INTO users(email,full_name,password_hash,role) VALUES (?,?,?,?)',
      [email, `Fixture ${n}`, '$2b$04$' + 'a'.repeat(53), n === 0 ? 'admin' : 'judge'],
    );
    actors.push({ id: r.insertId, email });
  }
  const admin = actors[0]!;
  const [oldTeam] = await pool.query<ResultSetHeader>(
    "INSERT INTO teams(team_code,name,project_name) VALUES ('OLD','Old team','Old project')",
  );
  const legacy = defaultRubricContent();
  legacy.title = 'Legacy';
  legacy.sections.forEach((s) => (s.weightPercent = 25));
  let state = await createDraft(pool, admin);
  let draft = await saveDraft(pool, admin, state.draft!.revision, legacy);
  const v1 = (await publishDraft(pool, admin, draft.revision, false)).published;
  await pool.query('INSERT INTO team_judges(team_id,judge_id) VALUES (?,?)', [
    oldTeam.insertId,
    admin.id,
  ]);
  await pool.query(
    "UPDATE competition c JOIN rubric r ON r.id=c.id SET c.state='judging_open',c.locked_rubric_version_id=r.published_version_id WHERE c.id=1",
  );
  let old = await startEvaluation(pool, admin, oldTeam.insertId);
  old = await saveEvaluation(pool, admin, old.id, old.rowVersion, {
    ratings: old.ratings.map((r) => ({ ...r, rating: 4 })),
    sectionNotes: old.sectionNotes,
    overallNotes: 'Original immutable notes',
  });
  old = (await submitEvaluation(pool, admin, old.id, old.rowVersion)).evaluation;
  const oldHistory = await getEvaluationHistory(pool, old.id);
  await pool.query(
    "UPDATE competition SET state='preparation',locked_rubric_version_id=NULL WHERE id=1",
  );
  state = await createDraft(pool, admin);
  const flexible = defaultRubricContent();
  flexible.scoringFormat = 3;
  flexible.title = 'Flexible';
  flexible.sections = [1, 2, 3, 4, 5, 10].map((count, i) => ({
    title: `Section ${i}`,
    description: 'Description',
    type: i === 5 ? 'bonus' : 'actual',
    weightPercent: i === 5 ? null : 20,
    maxBonusPoints: i === 5 ? 10 : null,
    criteria: Array.from({ length: count }, (_, j) => ({
      title: `Question ${i}.${j}`,
      description: 'Meaning',
      guidelines: 'Guidance',
    })),
  }));
  draft = await saveDraft(pool, admin, state.draft!.revision, flexible);
  const ids = draft.sections[2]!.criteria.map((c) => c.id);
  const reordered = contentOf(draft);
  reordered.sections[2]!.criteria.reverse();
  draft = await saveDraft(pool, admin, draft.revision, reordered);
  expect(draft.sections[2]!.criteria.map((c) => c.id)).toEqual([...ids].reverse());
  const v2 = (await publishDraft(pool, admin, draft.revision, true)).published;
  await pool.query(
    "UPDATE competition c JOIN rubric r ON r.id=c.id SET c.state='judging_open',c.locked_rubric_version_id=r.published_version_id WHERE c.id=1",
  );
  const [team] = await pool.query<ResultSetHeader>(
    "INSERT INTO teams(team_code,name,project_name) VALUES ('FLEX','Flexible team','Project')",
  );
  const submissions = [];
  for (const actor of actors) {
    await pool.query('INSERT INTO team_judges(team_id,judge_id) VALUES (?,?)', [
      team.insertId,
      actor.id,
    ]);
    let e = await startEvaluation(pool, actor, team.insertId);
    const ratings = e.ratings.map((r) => ({
      ...r,
      rating: v2.sections[5]!.criteria.some((c) => c.id === r.criterionId) ? null : 5,
    }));
    if (actor.id === admin.id)
      v2.sections[2]!.criteria.forEach(
        (c, i) => (ratings.find((r) => r.criterionId === c.id)!.rating = [1, 1, 2][i]!),
      );
    const input = { ratings, sectionNotes: e.sectionNotes, overallNotes: 'All questions retained' };
    if (actor.id === admin.id) {
      e = await saveEvaluation(pool, actor, e.id, e.rowVersion, {
        ...input,
        ratings: ratings.map((r, i) => (i === 0 ? { ...r, rating: null } : r)),
      });
      expect(e.ratedCount).toBe(14);
      expect(e.requiredCount).toBe(15);
      await expect(submitEvaluation(pool, actor, e.id, e.rowVersion)).rejects.toMatchObject({
        status: 400,
      });
    }
    e = await saveEvaluation(pool, actor, e.id, e.rowVersion, input);
    expect(e.requiredCount).toBe(15);
    if (actor.id === admin.id) {
      expect(e.totalScore).toBeCloseTo(80 + 16 / 3, 11);
      input.ratings.find((r) => r.criterionId === v2.sections[5]!.criteria[0]!.id)!.rating = 5;
      e = await saveEvaluation(pool, actor, e.id, e.rowVersion, input);
      await expect(submitEvaluation(pool, actor, e.id, e.rowVersion)).rejects.toMatchObject({
        status: 400,
      });
      input.ratings
        .filter((r) => v2.sections[5]!.criteria.some((c) => c.id === r.criterionId))
        .forEach((r) => (r.rating = null));
      e = await saveEvaluation(pool, actor, e.id, e.rowVersion, input);
    }
    e = (await submitEvaluation(pool, actor, e.id, e.rowVersion)).evaluation;
    submissions.push(e);
  }
  const before = submissions[1]!;
  const input = {
    ratings: before.ratings.map((r) => ({ ...r, rating: 5, note: 'Correction note' })),
    sectionNotes: before.sectionNotes,
    overallNotes: 'Corrected',
  };
  const corrected = await correctSubmission(
    pool,
    admin,
    before.id,
    before.rowVersion,
    input,
    'Evidence checked for all questions',
  );
  expect(corrected.evaluation.totalScore).toBe(110);
  await expect(
    correctSubmission(pool, admin, before.id, before.rowVersion, input, 'Stale edit attempt'),
  ).rejects.toMatchObject({ status: 409 });
  expect(await getEvaluationHistory(pool, old.id)).toEqual(oldHistory);
  const results = await getResults(pool, { sort: 'rank', dir: 'asc' });
  expect(results.official.available).toBe(false);
  const ranked = results.provisional
    .flatMap((g) => g.teams)
    .find((t) => t.teamId === team.insertId)!;
  expect(ranked.score).toBeCloseTo((80 + 16 / 3 + 110 + 100) / 3, 11);
  const evaluations = await buildReport(pool, 'evaluations', { version: v2.versionNo });
  expect(evaluations.sheets.find((s) => s.name === 'Criteria')!.rows).toHaveLength(75);
  const corrections = await buildReport(pool, 'corrections', {});
  expect(
    corrections.sheets
      .find((s) => s.name === 'Before After Details')!
      .rows.filter((r) => r[3] === 'criterion'),
  ).toHaveLength(50);
  expect(encodeXlsx(evaluations).length).toBeGreaterThan(1000);
  expect(encodeCsv(evaluations, 'Criteria').toString()).toContain('Question 5.9');
  await pool.query(
    "UPDATE competition SET state='preparation',locked_rubric_version_id=NULL WHERE id=1",
  );
  state = await createDraft(pool, admin, v1.id);
  expect(state.draft!.sections.every((s) => s.criteria.length === 2)).toBe(true);
  expect(state.published!.id).toBe(v2.id);
  expect((await getAdminRubric(pool)).versions!.find((v) => v.id === v1.id)!.scoringFormat).toBe(1);
});
