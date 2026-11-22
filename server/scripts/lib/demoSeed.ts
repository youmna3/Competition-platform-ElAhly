/**
 * Phase 8 demonstration data. Used ONLY by `npm run db:demo` (a separate demo
 * database) and by the automated tests (a scratch database). It never runs
 * against the real competition database.
 *
 * Everything goes through the application's own services, so the data is
 * exactly what real judges and administrators would produce: the same
 * validation, scoring, history and audit entries.
 */
import bcrypt from 'bcryptjs';
import type { Pool } from 'mysql2/promise';
import type { RubricContent, TeamResultStatus } from '@judging/shared';
import {
  saveEvaluation,
  startEvaluation,
  submitEvaluation,
} from '../../src/evaluations/service.js';
import { reopenEvaluation } from '../../src/review/service.js';
import { createDraft, publishDraft, saveDraft } from '../../src/rubric/service.js';
import {
  bulkAssign,
  removeAssignment,
  setTeamStatus,
  type Actor,
} from '../../src/teams/service.js';
import { updateUser } from '../../src/users/service.js';

/** Star sets and their totals with the v1 weights 30 / 30 / 20 / 20. */
export const STARS = {
  100: [5, 5, 5, 5, 5, 5, 5, 5],
  92: [5, 5, 5, 5, 5, 4, 4, 3],
  90: [5, 5, 4, 4, 5, 5, 4, 4],
  81: [5, 4, 4, 4, 4, 4, 4, 3],
  80: [4, 4, 4, 4, 4, 4, 4, 4],
  70: [4, 4, 3, 3, 4, 4, 3, 3],
  60: [3, 3, 3, 3, 3, 3, 3, 3],
} as const;

export const DEMO_ACCOUNTS = [
  { key: 'admin', email: 'demo.admin@demo.local', name: 'Demo Admin', role: 'admin' },
  { key: 'amina', email: 'amina@demo.local', name: 'Amina Judge', role: 'judge' },
  { key: 'bassem', email: 'bassem@demo.local', name: 'Bassem Judge', role: 'judge' },
  { key: 'carla', email: 'carla@demo.local', name: 'Carla Judge', role: 'judge' },
  { key: 'dina', email: 'dina@demo.local', name: 'Dina Judge', role: 'judge' },
  { key: 'emad', email: 'emad@demo.local', name: 'Emad Judge', role: 'judge' },
] as const;
type AccountKey = (typeof DEMO_ACCOUNTS)[number]['key'];

export const DEMO_TEAMS = [
  ['D-01', 'Falcons', 'Smart Irrigation'],
  ['D-02', 'Eagles', 'Solar Benches'],
  ['D-03', 'Lions', 'Recycling Robot'],
  ['D-04', 'Hawks', 'Water Quality Sensor'],
  ['D-05', 'Sharks', 'Stadium Navigator'],
  ['D-06', 'Tigers', 'Food Waste Tracker'],
  ['D-07', 'Wolves', 'Bike Sharing'],
  ['D-08', 'Bears', 'Air Monitor'],
  ['D-09', 'Owls', 'Library Finder'],
  ['D-10', 'Foxes', 'Ticket Scanner'],
  ['D-11', 'Cobras', 'Energy Dashboard'],
  ['D-12', 'Ravens', 'Fan Translator'],
  ['D-13', 'Pandas', 'Withdrawn Project'],
] as const;
type TeamCode = (typeof DEMO_TEAMS)[number][0];

function rubric(weights: number[], title: string): RubricContent {
  return {
    title,
    description: 'Demonstration rubric for the Phase 8 results checks.',
    instructions: 'Rate each criterion from 1 to 5 stars.',
    sections: ['Idea', 'Execution', 'Presentation', 'Teamwork'].map((name, i) => ({
      title: name,
      description: '',
      weightPercent: weights[i]!,
      criteria: [
        { title: `${name}: quality`, description: '', guidelines: '' },
        { title: `${name}: impact`, description: '', guidelines: '' },
      ],
    })),
  };
}

/** The expected outcome after seeding, used by the tests and printed by db:demo. */
export const DEMO_EXPECTED = {
  official: [
    // [team, rank, exact average, judges]
    ['D-03', 1, 92, 'Demo Admin (admin as judge) 92'],
    ['D-04', 2, 241 / 3, 'Amina 80 + Bassem 81 + Carla 80 = 80.333… (shown 80.33)'],
    ['D-01', 3, 80, 'Amina 90 + Bassem 80 + Carla 70'],
    ['D-02', 3, 80, 'Amina 100 + Bassem 60 (tied with D-01)'],
    ['D-05', 5, 70, 'Bassem 70 (Emad’s 100 is excluded: he was unassigned)'],
  ] as [TeamCode, number, number, string][],
  notRanked: [
    ['D-06', 'in_progress', 80, 'Amina submitted 80; Carla has a draft'],
    ['D-07', 'in_progress', 70, 'Amina’s 90 was reopened; Bassem 70 remains'],
    ['D-08', 'not_started', null, 'Carla assigned, not started'],
    ['D-09', 'unassigned', null, 'No judges'],
    ['D-10', 'blocked', 85, 'Dina (submitted 90) is disabled; Amina 80'],
    ['D-11', 'blocked', 80, 'Amina 80 on v1, Bassem 80 on v2: mixed versions'],
    ['D-12', 'in_progress', 90, 'Amina 90; Carla added afterwards'],
  ] as [TeamCode, TeamResultStatus, number | null, string][],
  archived: ['D-13'] as TeamCode[],
};

export interface DemoSeedResult {
  accounts: { email: string; name: string; role: string }[];
}

export async function seedPhase8Demo(pool: Pool, password: string): Promise<DemoSeedResult> {
  const hash = await bcrypt.hash(password, 10);
  const ids = {} as Record<AccountKey, number>;
  for (const a of DEMO_ACCOUNTS) {
    const [r] = await pool.query(
      'INSERT INTO users (email, full_name, password_hash, role, must_change_password) VALUES (?, ?, ?, ?, FALSE)',
      [a.email, a.name, hash, a.role],
    );
    ids[a.key] = (r as { insertId: number }).insertId;
  }
  const actor = (key: AccountKey): Actor => ({
    id: ids[key],
    email: DEMO_ACCOUNTS.find((a) => a.key === key)!.email,
    ip: 'demo-seed',
  });
  const admin = actor('admin');

  const team = {} as Record<TeamCode, number>;
  for (const [code, name, project] of DEMO_TEAMS) {
    const [r] = await pool.query(
      'INSERT INTO teams (team_code, name, project_name, created_by) VALUES (?, ?, ?, ?)',
      [code, name, project, ids.admin],
    );
    team[code] = (r as { insertId: number }).insertId;
  }

  async function publish(weights: number[], title: string) {
    const state = await createDraft(pool, admin);
    const saved = await saveDraft(pool, admin, state.draft!.revision, rubric(weights, title));
    await publishDraft(pool, admin, saved.revision, true);
  }
  const assign = (codes: TeamCode[], judges: AccountKey[]) =>
    bulkAssign(
      pool,
      admin,
      codes.map((c) => team[c]),
      judges.map((j) => ids[j]),
    );

  async function draft(judge: AccountKey, code: TeamCode, stars: readonly (number | null)[]) {
    const e = await startEvaluation(pool, actor(judge), team[code]);
    return saveEvaluation(pool, actor(judge), e.id, e.rowVersion, {
      ratings: e.ratings.map((r, i) => ({
        criterionId: r.criterionId,
        rating: stars[i] ?? null,
        note: '',
      })),
      sectionNotes: e.sectionNotes.map((n) => ({ sectionId: n.sectionId, note: '' })),
      overallNotes: 'Demo evaluation',
    });
  }
  async function evaluate(judge: AccountKey, code: TeamCode, stars: readonly number[]) {
    const e = await draft(judge, code, stars);
    return (await submitEvaluation(pool, actor(judge), e.id, e.rowVersion)).evaluation;
  }

  // Rubric v1: 30 / 30 / 20 / 20.
  await publish([30, 30, 20, 20], 'Demo rubric v1');

  await assign(['D-01', 'D-04'], ['amina', 'bassem', 'carla']);
  await assign(['D-02', 'D-07'], ['amina', 'bassem']);
  await assign(['D-03'], ['admin']);
  await assign(['D-05'], ['bassem', 'emad']);
  await assign(['D-06'], ['amina', 'carla']);
  await assign(['D-08'], ['carla']);
  await assign(['D-10'], ['amina', 'dina']);
  await assign(['D-11', 'D-12', 'D-13'], ['amina']);
  await assign(['D-11'], ['bassem']);

  // Complete teams.
  await evaluate('amina', 'D-01', STARS[90]);
  await evaluate('bassem', 'D-01', STARS[80]);
  await evaluate('carla', 'D-01', STARS[70]);
  await evaluate('amina', 'D-02', STARS[100]);
  await evaluate('bassem', 'D-02', STARS[60]);
  await evaluate('admin', 'D-03', STARS[92]);
  await evaluate('amina', 'D-04', STARS[80]);
  await evaluate('bassem', 'D-04', STARS[81]);
  await evaluate('carla', 'D-04', STARS[80]);
  await evaluate('bassem', 'D-05', STARS[70]);
  await evaluate('emad', 'D-05', STARS[100]);
  // Incomplete and blocked teams.
  await evaluate('amina', 'D-06', STARS[80]);
  await draft('carla', 'D-06', [4, 5, 3]);
  const reopenMe = await evaluate('amina', 'D-07', STARS[90]);
  await evaluate('bassem', 'D-07', STARS[70]);
  await evaluate('amina', 'D-10', STARS[80]);
  await evaluate('dina', 'D-10', STARS[90]);
  await evaluate('amina', 'D-11', STARS[80]);
  await evaluate('amina', 'D-12', STARS[90]);
  await evaluate('amina', 'D-13', STARS[100]);

  // Changes after submission.
  await reopenEvaluation(
    pool,
    admin,
    reopenMe.id,
    'Demo: please double-check the Execution scores',
  );
  await removeAssignment(pool, admin, team['D-05'], ids.emad); // his evaluation stays as history
  await assign(['D-12'], ['carla']); // a judge added to a completed team
  await updateUser(pool, admin, ids.dina, { status: 'disabled' });
  await setTeamStatus(pool, admin, team['D-13'], 'archived', 'Demo: team withdrew');

  // Rubric v2: 25 / 25 / 25 / 25. Bassem then scores D-11 on v2 (mixed within a team).
  await publish([25, 25, 25, 25], 'Demo rubric v2');
  await evaluate('bassem', 'D-11', STARS[80]);

  return {
    accounts: DEMO_ACCOUNTS.map((a) => ({ email: a.email, name: a.name, role: a.role })),
  };
}
