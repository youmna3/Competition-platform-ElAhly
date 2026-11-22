/**
 * Phase 8 demo dataset: seeds the scratch test database exactly like
 * `npm run db:demo` seeds the demo database, then checks every expected rank,
 * score and status that the Windows checklist relies on.
 */
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatScore } from '@judging/shared';
import { DEMO_EXPECTED, seedPhase8Demo } from '../../scripts/lib/demoSeed.js';
import { getDashboard, getResults } from '../../src/results/service.js';
import {
  saveEvaluation,
  startEvaluation,
  submitEvaluation,
} from '../../src/evaluations/service.js';
import { bulkAssign, removeAssignment } from '../../src/teams/service.js';
import { updateUser } from '../../src/users/service.js';
import { dropDatabase, freshTestDatabase, TEST_DB, testTarget } from './helpers.js';

let pool: Pool;

beforeAll(async () => {
  await freshTestDatabase();
  pool = mysql.createPool({ ...testTarget, connectionLimit: 8 });
  await seedPhase8Demo(pool, 'Demo-Password-2026!');
}, 60_000);

afterAll(async () => {
  await pool.end();
  await dropDatabase(TEST_DB);
});

describe('phase 8 demo dataset', () => {
  it('produces the documented official ranking', async () => {
    const r = await getResults(pool, { sort: 'rank', dir: 'asc' });
    expect(r.official.available).toBe(true);
    expect(r.official.rubricVersionNo).toBe(1);
    expect(r.official.teams.map((t) => [t.teamCode, t.rank])).toEqual(
      DEMO_EXPECTED.official.map(([code, rank]) => [code, rank]),
    );
    r.official.teams.forEach((t, i) => {
      expect(t.score).toBeCloseTo(DEMO_EXPECTED.official[i]![2], 9);
    });
    expect(formatScore(r.official.teams[1]!.score)).toBe('80.33');
    expect(r.versionWarnings).toHaveLength(2);
    expect(r.versionWarnings.join(' ')).toMatch(/D-11/);
    expect(r.versionWarnings.join(' ')).toMatch(/v2 is now published/);
  });

  it('produces the documented unranked teams and statuses', async () => {
    const r = await getResults(pool, { sort: 'teamCode', dir: 'asc' });
    expect(r.notRanked.map((t) => [t.teamCode, t.status, t.provisionalAverage])).toEqual(
      DEMO_EXPECTED.notRanked.map(([code, status, avg]) => [code, status, avg]),
    );
    const codes = [...r.official.teams, ...r.notRanked].map((t) => t.teamCode);
    for (const archived of DEMO_EXPECTED.archived) expect(codes).not.toContain(archived);
    expect(r.notRanked.find((t) => t.teamCode === 'D-07')!.reasons).toContain(
      'Reopened for Amina Judge: waiting for resubmission.',
    );
  });

  it('produces the documented dashboard figures', async () => {
    const d = await getDashboard(pool);
    expect(d.teams).toEqual({ active: 12, archived: 1 });
    expect(d.accounts).toEqual({ judges: 4, administrators: 1, participatingJudges: 5 });
    expect(d.evaluations).toMatchObject({
      required: 21,
      submitted: 17,
      draft: 2,
      notStarted: 2,
      pending: 4,
      judgesWithPending: 2,
      teamsWaiting: 4,
    });
    expect(d.teamStatus).toEqual({
      unassigned: 1,
      not_started: 1,
      in_progress: 3,
      ready: 5,
      blocked: 2,
    });
    expect(d.topTeams.map((t) => t.teamCode)).toEqual(['D-03', 'D-04', 'D-01', 'D-02']);
  });

  it('matches the Windows checklist steps 8 to 10', async () => {
    const idOf = async (table: string, col: string, value: string) => {
      const [rows] = await pool.query<RowDataPacket[]>(`SELECT id FROM ${table} WHERE ${col} = ?`, [
        value,
      ]);
      return Number(rows[0]!.id);
    };
    const actor = async (email: string) => ({ id: await idOf('users', 'email', email), email });
    const admin = await actor('demo.admin@demo.local');
    const amina = await actor('amina@demo.local');
    const ranks = async () =>
      (await getResults(pool, { sort: 'rank', dir: 'asc' })).official.teams.map(
        (t) => `${t.teamCode}:${t.rank}`,
      );

    // Step 8: Amina resubmits D-07 with all 5 stars.
    const e = await startEvaluation(pool, amina, await idOf('teams', 'team_code', 'D-07'));
    const saved = await saveEvaluation(pool, amina, e.id, e.rowVersion, {
      ratings: e.ratings.map((r) => ({ criterionId: r.criterionId, rating: 5, note: '' })),
      sectionNotes: e.sectionNotes,
      overallNotes: '',
    });
    await submitEvaluation(pool, amina, saved.id, saved.rowVersion);
    const step8 = ['D-03:1', 'D-07:2', 'D-04:3', 'D-01:4', 'D-02:4', 'D-05:6'];
    expect(await ranks()).toEqual(step8);

    // Step 9: reactivate Dina, then disable her again.
    const dina = await idOf('users', 'email', 'dina@demo.local');
    await updateUser(pool, admin, dina, { status: 'active' });
    expect(await ranks()).toEqual([
      'D-03:1',
      'D-07:2',
      'D-10:2',
      'D-04:4',
      'D-01:5',
      'D-02:5',
      'D-05:7',
    ]);
    await updateUser(pool, admin, dina, { status: 'disabled' });
    expect(await ranks()).toEqual(step8);

    // Step 10: remove Carla from D-12, then assign her again.
    const d12 = await idOf('teams', 'team_code', 'D-12');
    const carla = await idOf('users', 'email', 'carla@demo.local');
    await removeAssignment(pool, admin, d12, carla);
    expect(await ranks()).toEqual([
      'D-03:1',
      'D-12:2',
      'D-07:3',
      'D-04:4',
      'D-01:5',
      'D-02:5',
      'D-05:7',
    ]);
    await bulkAssign(pool, admin, [d12], [carla]);
    expect(await ranks()).toEqual(step8);
  });
});
