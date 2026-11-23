import { testMysql as mysql } from './helpers.js';
/**
 * The read-only rubric-version check (npm run db:rubric-check): it reports
 * mixed and off-version evaluations correctly and never changes any data.
 */
import { type Pool, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedPhase8Demo } from '../../scripts/lib/demoSeed.js';
import { rubricCheck } from '../../scripts/lib/rubricCheck.js';
import { dropDatabase, freshTestDatabase, TEST_DB, testTarget } from './helpers.js';

let pool: Pool;

beforeAll(async () => {
  await freshTestDatabase();
  pool = mysql.createPool({ ...testTarget, connectionLimit: 4 });
}, 60_000);

afterAll(async () => {
  await pool.end();
  await dropDatabase(TEST_DB);
});

const checksum = async () =>
  JSON.stringify(
    (
      await pool.query<RowDataPacket[]>(
        'CHECKSUM TABLE rubric, rubric_versions, evaluations, evaluation_scores, evaluation_events, competition, audit_log',
      )
    )[0],
  );

describe('read-only rubric check', () => {
  it('reports an empty database without problems', async () => {
    const r = await rubricCheck(pool);
    expect(r.versions).toEqual([]);
    expect(r.problems).toEqual([]);
  });

  it('finds the mixed team in the demo dataset and changes nothing', async () => {
    await seedPhase8Demo(pool, 'Demo-Password-2026!');
    const before = await checksum();
    const r = await rubricCheck(pool);
    expect(await checksum()).toBe(before);
    expect(r.versions.map((v) => [v.versionNo, v.status])).toEqual([
      [1, 'retired'],
      [2, 'published'],
    ]);
    expect(r.mixedTeams.map((t) => [t.teamCode, t.versions])).toContainEqual(['D-11', [1, 2]]);
    expect(r.problems.join(' ')).toMatch(/more than one rubric version/);
    expect(r.evaluationsByVersion.find((v) => v.versionNo === 2)?.submitted).toBeGreaterThan(0);
  });
});
