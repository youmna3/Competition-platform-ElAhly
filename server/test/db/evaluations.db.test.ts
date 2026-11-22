import type { Connection, RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addCriterion,
  addSection,
  connectTest,
  createDraft,
  createTeam,
  createUser,
  dropDatabase,
  expectRefused,
  freshTestDatabase,
  publish,
  scalar,
  TEST_DB,
} from './helpers.js';

let conn: Connection | undefined;
const c = () => conn as Connection;

let team: number;
let judge: number;

beforeEach(async () => {
  await conn?.end();
  await freshTestDatabase();
  conn = await connectTest();
  team = await createTeam(c(), 'AHL-100');
  judge = await createUser(c(), { email: 'judge@example.com' });
});

afterAll(async () => {
  await conn?.end();
  await dropDatabase(TEST_DB);
});

async function publishedVersion(versionNo: number) {
  const version = await createDraft(c(), { versionNo });
  const section = await addSection(c(), version, { position: 1 });
  const criterion = await addCriterion(c(), version, section, { position: 1, min: 1, max: 5 });
  await publish(c(), version);
  return { version, section, criterion };
}

async function startEvaluation(version: number, teamId = team, judgeId = judge) {
  const [r] = await c().query<RowDataPacket[] & { insertId: number }>(
    'INSERT INTO evaluations (team_id, judge_id, rubric_version_id, required_count) VALUES (?, ?, ?, 1)',
    [teamId, judgeId, version],
  );
  return (r as unknown as { insertId: number }).insertId;
}

async function setScore(
  evaluation: number,
  version: number,
  criterion: number,
  score: number | null,
) {
  await c().query(
    `INSERT INTO evaluation_scores (evaluation_id, rubric_version_id, criterion_id, score) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE score = VALUES(score)`,
    [evaluation, version, criterion, score],
  );
}

async function submit(evaluation: number) {
  await c().query(
    "UPDATE evaluations SET status = 'submitted', submitted_at = NOW(), required_scored = required_count WHERE id = ?",
    [evaluation],
  );
}

describe('starting an evaluation', () => {
  it('is impossible while the rubric is not configured or only a draft', async () => {
    await expectRefused(
      c().query('INSERT INTO evaluations (team_id, judge_id, rubric_version_id) VALUES (?, ?, 1)', [
        team,
        judge,
      ]),
      /ER_NO_REFERENCED_ROW|published rubric/,
    );
    const draft = await createDraft(c(), { versionNo: 1 });
    await expectRefused(startEvaluation(draft), /currently published rubric/);
  });

  it('is pinned to the published version and only one per team and judge', async () => {
    const { version } = await publishedVersion(1);
    const evaluation = await startEvaluation(version);
    expect(
      await scalar(c(), 'SELECT rubric_version_id FROM evaluations WHERE id = ?', [evaluation]),
    ).toBe(version);
    await expectRefused(startEvaluation(version), /ER_DUP_ENTRY/);
    await expectRefused(
      c().query('UPDATE evaluations SET rubric_version_id = 999 WHERE id = ?', [evaluation]),
      /cannot change/,
    );
  });
});

describe('scores', () => {
  it('must lie inside the range configured for the criterion', async () => {
    const { version, criterion } = await publishedVersion(1);
    const evaluation = await startEvaluation(version);
    await setScore(evaluation, version, criterion, null);
    await setScore(evaluation, version, criterion, 1);
    await setScore(evaluation, version, criterion, 5);
    await expectRefused(setScore(evaluation, version, criterion, 6), /outside the range/);
    await expectRefused(setScore(evaluation, version, criterion, 0), /outside the range/);
  });

  it('can never point at a criterion from another rubric version', async () => {
    const v1 = await publishedVersion(1);
    const evaluation = await startEvaluation(v1.version);
    const v2 = await publishedVersion(2);
    await expectRefused(setScore(evaluation, v1.version, v2.criterion, 3), /ER_NO_REFERENCED_ROW/);
    await expectRefused(setScore(evaluation, v2.version, v2.criterion, 3), /ER_NO_REFERENCED_ROW/);
  });

  it('are never deleted', async () => {
    const { version, criterion } = await publishedVersion(1);
    const evaluation = await startEvaluation(version);
    await setScore(evaluation, version, criterion, 3);
    await expectRefused(c().query('DELETE FROM evaluation_scores'), /never deleted/);
    await expectRefused(c().query('DELETE FROM evaluations'), /never deleted/);
  });
});

describe('submission lock', () => {
  it('requires every required row to be scored', async () => {
    const { version } = await publishedVersion(1);
    const evaluation = await startEvaluation(version);
    await expectRefused(
      c().query("UPDATE evaluations SET status = 'submitted', submitted_at = NOW() WHERE id = ?", [
        evaluation,
      ]),
      /chk_evaluations_submitted|CONSTRAINT/i,
    );
  });

  it('locks scores, notes and the evaluation after submission until an admin reopens it', async () => {
    const { version, section, criterion } = await publishedVersion(1);
    const evaluation = await startEvaluation(version);
    await setScore(evaluation, version, criterion, 4);
    await submit(evaluation);

    await expectRefused(setScore(evaluation, version, criterion, 2), /locked/);
    await expectRefused(
      c().query(
        'INSERT INTO evaluation_section_notes (evaluation_id, rubric_version_id, section_id, note) VALUES (?, ?, ?, ?)',
        [evaluation, version, section, 'late note'],
      ),
      /locked/,
    );
    await expectRefused(
      c().query("UPDATE evaluations SET overall_notes = 'changed' WHERE id = ?", [evaluation]),
      /locked/,
    );

    // Admin reopen.
    await c().query(
      "UPDATE evaluations SET status = 'draft', submitted_at = NULL, reopened_count = reopened_count + 1 WHERE id = ?",
      [evaluation],
    );
    await setScore(evaluation, version, criterion, 2);
    expect(
      await scalar(c(), 'SELECT score FROM evaluation_scores WHERE evaluation_id = ?', [
        evaluation,
      ]),
    ).toBe(2);
  });
});

describe('history is preserved when the rubric changes', () => {
  it('keeps submitted scores and their rubric version intact after a new version is published', async () => {
    const v1 = await publishedVersion(1);
    const evaluation = await startEvaluation(v1.version);
    await setScore(evaluation, v1.version, v1.criterion, 5);
    await c().query('UPDATE evaluations SET core_score = 5, total_score = 5 WHERE id = ?', [
      evaluation,
    ]);
    await submit(evaluation);

    const snapshot = async () => {
      const [rows] = await c().query<RowDataPacket[]>(
        `SELECT e.rubric_version_id, e.total_score, s.score, cr.title, cr.max_score, cr.weight
         FROM evaluations e
         JOIN evaluation_scores s ON s.evaluation_id = e.id
         JOIN rubric_criteria cr ON cr.id = s.criterion_id
         WHERE e.id = ?`,
        [evaluation],
      );
      return rows;
    };
    const before = await snapshot();

    // The admin edits the rubric (new draft with different scoring) and publishes it.
    const v2 = await createDraft(c(), { versionNo: 2, title: 'Revised rubric' });
    const s2 = await addSection(c(), v2, { position: 1 });
    await addCriterion(c(), v2, s2, { position: 1, min: 0, max: 100, weight: 3 });
    await publish(c(), v2);

    expect(await snapshot()).toEqual(before);
    expect(await scalar(c(), 'SELECT status FROM rubric_versions WHERE id = ?', [v1.version])).toBe(
      'retired',
    );
    // The old version can no longer be edited or used for new evaluations.
    await expectRefused(
      c().query('UPDATE rubric_criteria SET max_score = 50 WHERE id = ?', [v1.criterion]),
      /read-only/,
    );
    const otherTeam = await createTeam(c(), 'AHL-200');
    await expectRefused(startEvaluation(v1.version, otherTeam), /currently published rubric/);
    // New evaluations use the new version.
    const fresh = await startEvaluation(v2, otherTeam);
    expect(
      await scalar(c(), 'SELECT rubric_version_id FROM evaluations WHERE id = ?', [fresh]),
    ).toBe(v2);
  });

  it('lets a draft evaluation started on the old version continue on that version', async () => {
    const v1 = await publishedVersion(1);
    const evaluation = await startEvaluation(v1.version);
    await publishedVersion(2);
    await setScore(evaluation, v1.version, v1.criterion, 3);
    expect(
      await scalar(c(), 'SELECT score FROM evaluation_scores WHERE evaluation_id = ?', [
        evaluation,
      ]),
    ).toBe(3);
  });
});
