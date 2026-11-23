/**
 * Phase 8 — official results. Read-only: nothing here writes to the database.
 *
 * Every figure is recomputed from the stored star ratings and the weights of
 * the rubric version each evaluation was scored with. The stored total is only
 * used as a cross-check; a mismatch blocks the team instead of being trusted.
 */
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import {
  rankTeams,
  scoreEvaluation,
  toThousandths,
  type DashboardResponse,
  type EvaluationProgress,
  type JudgeResult,
  type JudgeLeaderboardResponse,
  type LeaderboardSort,
  type ProvisionalGroup,
  type RankedTeam,
  type ResultsResponse,
  type ResultsSort,
  type TeamResult,
  type TeamResultStatus,
} from '@judging/shared';

type Db = Pool | PoolConnection;

interface TeamRow {
  id: number;
  teamCode: string;
  name: string;
  projectName: string;
}

interface Snapshot {
  computedAt: string;
  publishedVersionNo: number | null;
  teams: TeamResult[];
  /** Exact per-team sums (thousandths) for ranking. */
  sums: Map<number, number>;
  archivedTeams: number;
  accounts: { judges: number; administrators: number };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const names = (list: JudgeResult[]) => list.map((j) => j.fullName).join(', ');

/** Reads everything in one consistent snapshot, so concurrent submits can't half-apply. */
async function readSnapshot(pool: Pool): Promise<Snapshot> {
  const conn = await pool.getConnection();
  try {
    await conn.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await conn.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    try {
      return await buildSnapshot(conn);
    } finally {
      await conn.query('COMMIT');
    }
  } finally {
    conn.release();
  }
}

async function buildSnapshot(db: Db): Promise<Snapshot> {
  const [[meta]] = (await db.query(
    `SELECT NOW(3) AS now_at,
       (SELECT v.version_no FROM rubric r JOIN rubric_versions v ON v.id = r.published_version_id WHERE r.id = 1) AS published_no,
       (SELECT COUNT(*) FROM teams WHERE status = 'archived') AS archived,
       (SELECT COUNT(*) FROM users WHERE role = 'judge' AND status = 'active') AS judges,
       (SELECT COUNT(*) FROM users WHERE role = 'admin' AND status = 'active') AS admins`,
  )) as unknown as [RowDataPacket[]];

  const [teamRows] = await db.query<RowDataPacket[]>(
    `SELECT id, team_code, name, project_name FROM teams WHERE status = 'active' ORDER BY team_code, id`,
  );
  // Only current assignments count. Evaluations by judges who were unassigned
  // stay in the database as history but never reach this query.
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT tj.team_id, u.id AS judge_id, u.full_name, u.role, u.status AS account_status,
            e.id AS evaluation_id, e.status, e.total_score, e.core_score, e.bonus_score, e.reopened_count,
            e.rubric_version_id, v.version_no
     FROM team_judges tj
     JOIN teams t ON t.id = tj.team_id AND t.status = 'active'
     JOIN users u ON u.id = tj.judge_id
     LEFT JOIN evaluations e ON e.team_id = tj.team_id AND e.judge_id = tj.judge_id
     LEFT JOIN rubric_versions v ON v.id = e.rubric_version_id
     ORDER BY u.full_name, u.id`,
  );

  // Ratings of the submitted evaluations above, in rubric order, with weights.
  const [ratingRows] = await db.query<RowDataPacket[]>(
    `SELECT es.evaluation_id, s.position AS section_pos, s.weight_percent, s.is_bonus, s.max_bonus_points, c.position AS criterion_pos, es.score
     FROM team_judges tj
     JOIN teams t ON t.id = tj.team_id AND t.status = 'active'
     JOIN evaluations e ON e.team_id = tj.team_id AND e.judge_id = tj.judge_id AND e.status = 'submitted'
     JOIN rubric_sections s ON s.rubric_version_id = e.rubric_version_id
     JOIN rubric_criteria c ON c.section_id = s.id
     LEFT JOIN evaluation_scores es ON es.evaluation_id = e.id AND es.criterion_id = c.id
     ORDER BY e.id, s.position, c.position`,
  );
  const bySection = new Map<
    number,
    Map<
      number,
      {
        weight: number;
        type: 'actual' | 'bonus';
        maxBonusPoints: number | null;
        scores: (number | null)[];
      }
    >
  >();
  for (const r of ratingRows) {
    if (r.evaluation_id == null) continue;
    const evaluationId = Number(r.evaluation_id);
    const sections = bySection.get(evaluationId) ?? new Map();
    const pos = Number(r.section_pos);
    const section = sections.get(pos) ?? {
      weight: Number(r.weight_percent ?? 0),
      type: r.is_bonus ? 'bonus' : 'actual',
      maxBonusPoints: r.max_bonus_points == null ? null : Number(r.max_bonus_points),
      scores: [],
    };
    section.scores.push(r.score == null ? null : Number(r.score));
    sections.set(pos, section);
    bySection.set(evaluationId, sections);
  }
  const recomputed = new Map<number, number | null>();
  const parts = new Map<number, ReturnType<typeof scoreEvaluation>>();
  for (const [evaluationId, sections] of bySection) {
    const ordered = [...sections.entries()].sort((a, b) => a[0] - b[0]).map(([, s]) => s);
    const breakdown = scoreEvaluation(
      ordered.map((s) => ({
        weightPercent: s.weight,
        type: s.type,
        maxBonusPoints: s.maxBonusPoints,
      })),
      ordered.map((s) => s.scores),
    );
    recomputed.set(evaluationId, breakdown.total);
    parts.set(evaluationId, breakdown);
  }

  const judgesByTeam = new Map<number, (JudgeResult & { storedScore: number | null })[]>();
  for (const r of rows) {
    const status = (r.status ?? 'not_started') as EvaluationProgress;
    const evaluationId = r.evaluation_id == null ? null : Number(r.evaluation_id);
    const list = judgesByTeam.get(Number(r.team_id)) ?? [];
    list.push({
      judgeId: Number(r.judge_id),
      fullName: String(r.full_name),
      role: r.role,
      accountStatus: r.account_status,
      evaluationId,
      status,
      reopened: status === 'draft' && Number(r.reopened_count ?? 0) > 0,
      score:
        status === 'submitted' && evaluationId != null
          ? (recomputed.get(evaluationId) ?? null)
          : null,
      baseScore: status === 'submitted' ? (parts.get(evaluationId!)?.base ?? null) : null,
      bonusScore: status === 'submitted' ? (parts.get(evaluationId!)?.bonus ?? null) : null,
      maximumScore: parts.get(evaluationId!)?.maximum ?? 100,
      storedScore: status === 'submitted' ? Number(r.total_score) : null,
      rubricVersionNo: r.version_no == null ? null : Number(r.version_no),
    });
    judgesByTeam.set(Number(r.team_id), list);
  }

  const sums = new Map<number, number>();
  const teams = teamRows.map((t) => {
    const team: TeamRow = {
      id: Number(t.id),
      teamCode: String(t.team_code),
      name: String(t.name),
      projectName: String(t.project_name),
    };
    const judges = judgesByTeam.get(team.id) ?? [];
    const result = assess(team, judges);
    if (result.status === 'ready') {
      sums.set(
        team.id,
        judges.reduce((sum, j) => sum + toThousandths(j.score!), 0),
      );
    }
    return result;
  });

  return {
    computedAt: new Date(meta!.now_at).toISOString(),
    publishedVersionNo: meta!.published_no == null ? null : Number(meta!.published_no),
    teams,
    sums,
    archivedTeams: Number(meta!.archived),
    accounts: { judges: Number(meta!.judges), administrators: Number(meta!.admins) },
  };
}

/** Decides a team's status and explains, in plain words, anything that stops it being ranked. */
function assess(
  team: TeamRow,
  judges: (JudgeResult & { storedScore: number | null })[],
): TeamResult {
  const submitted = judges.filter((j) => j.status === 'submitted');
  const versions = [
    ...new Set(judges.map((j) => j.rubricVersionNo).filter((v): v is number => v != null)),
  ].sort((a, b) => a - b);
  const submittedVersions = new Set(submitted.map((j) => j.rubricVersionNo));
  const reasons: string[] = [];
  const blockers: string[] = [];

  const disabled = judges.filter((j) => j.accountStatus !== 'active');
  if (disabled.length) {
    blockers.push(
      `${names(disabled)} ${disabled.length === 1 ? 'is' : 'are'} assigned but disabled. Reactivate the account or remove the assignment.`,
    );
  }
  const mismatched = submitted.filter(
    (j) => j.score == null || j.storedScore == null || Math.abs(j.score - j.storedScore) > 0.0005,
  );
  if (mismatched.length) {
    blockers.push(
      `The stored score of ${names(mismatched)} does not match the ratings. Check the evaluation before publishing results.`,
    );
  }
  const allSubmitted = judges.length > 0 && submitted.length === judges.length;
  if (allSubmitted && submittedVersions.size > 1) {
    blockers.push(
      `Judges used different rubric versions (${[...submittedVersions].map((v) => `v${v}`).join(', ')}). Historical evaluations remain on their original versions; resolve competition version policy before ranking.`,
    );
  }

  let status: TeamResultStatus;
  if (judges.length === 0) {
    status = 'unassigned';
    reasons.push('No judges are assigned to this team.');
  } else if (blockers.length) {
    status = 'blocked';
  } else if (allSubmitted) {
    status = 'ready';
  } else {
    status = judges.every((j) => j.status === 'not_started') ? 'not_started' : 'in_progress';
    const waiting = judges.filter((j) => j.status !== 'submitted' && !j.reopened);
    const reopened = judges.filter((j) => j.reopened);
    reasons.push(`${submitted.length} of ${plural(judges.length, 'judge')} submitted.`);
    if (waiting.length) reasons.push(`Waiting for ${names(waiting)}.`);
    if (reopened.length) {
      reasons.push(`Reopened for ${names(reopened)}: waiting for resubmission.`);
    }
    if (versions.length > 1) {
      reasons.push(
        `Evaluations use different rubric versions (${versions.map((v) => `v${v}`).join(', ')}).`,
      );
    }
  }
  reasons.push(...blockers);

  const scored = submitted.filter((j) => j.score != null);
  return {
    teamId: team.id,
    teamCode: team.teamCode,
    name: team.name,
    projectName: team.projectName,
    status,
    assignedJudges: judges.length,
    submitted: submitted.length,
    pending: judges.length - submitted.length,
    versions,
    provisionalAverage: scored.length
      ? scored.reduce((sum, j) => sum + toThousandths(j.score!), 0) / 1000 / scored.length
      : null,
    baseAverage: scored.length
      ? scored.reduce((n, j) => n + (j.baseScore ?? 0), 0) / scored.length
      : null,
    bonusAverage: scored.length
      ? scored.reduce((n, j) => n + (j.bonusScore ?? 0), 0) / scored.length
      : null,
    maximumScore: versions.length === 1 && scored.length ? (scored[0]!.maximumScore ?? 100) : null,
    reasons: status === 'ready' ? [] : reasons,
    judges: judges.map(({ storedScore: _stored, ...j }) => j),
  };
}

function rank(teams: TeamResult[], sums: Map<number, number>): RankedTeam[] {
  return rankTeams(
    teams.map((team) => ({
      sumThousandths: sums.get(team.teamId)!,
      judges: team.assignedJudges,
      tieOrder: team.teamCode,
      team,
    })),
  ).map(({ team, rank: r, average }) => ({
    ...team,
    rank: r,
    score: average,
    rubricVersionNo: team.versions[0]!,
  }));
}

interface Official {
  available: boolean;
  unavailableReason: string | null;
  rubricVersionNo: number | null;
  teams: RankedTeam[];
  provisional: ProvisionalGroup[];
  versionWarnings: string[];
}

function official(snapshot: Snapshot): Official {
  const ready = snapshot.teams.filter((t) => t.status === 'ready');
  const versions = [...new Set(ready.map((t) => t.versions[0]!))].sort((a, b) => a - b);
  const warnings: string[] = [];

  if (ready.length === 0) {
    return {
      available: false,
      unavailableReason:
        'No team is ready for results yet. A team is ranked once every assigned judge has submitted.',
      rubricVersionNo: null,
      teams: [],
      provisional: [],
      versionWarnings: warnings,
    };
  }
  if (versions.length > 1) {
    const groups = versions.map((v) => ({
      rubricVersionNo: v,
      teams: rank(
        ready.filter((t) => t.versions[0] === v),
        snapshot.sums,
      ),
    }));
    const detail = groups
      .map((g) => `v${g.rubricVersionNo}: ${g.teams.map((t) => t.teamCode).join(', ')}`)
      .join('; ');
    return {
      available: false,
      unavailableReason: `Ready teams were scored with different rubric versions (${detail}). Scores from different versions are not comparable, so there is no official ranking until those teams are rescored on one version.`,
      rubricVersionNo: null,
      teams: [],
      provisional: groups,
      versionWarnings: warnings,
    };
  }

  const version = versions[0]!;
  const others = snapshot.teams.filter(
    (t) => t.status !== 'ready' && t.versions.some((v) => v !== version),
  );
  if (others.length) {
    warnings.push(
      `${plural(others.length, 'team')} not yet ranked ${others.length === 1 ? 'has' : 'have'} evaluations on another rubric version (${others.map((t) => t.teamCode).join(', ')}). ${others.length === 1 ? 'It' : 'They'} will block the official ranking if completed on that version.`,
    );
  }
  if (snapshot.publishedVersionNo != null && snapshot.publishedVersionNo !== version) {
    warnings.push(
      `The ranking uses rubric v${version}, but v${snapshot.publishedVersionNo} is now published. New evaluations will use v${snapshot.publishedVersionNo} and cannot be compared with this ranking.`,
    );
  }
  return {
    available: true,
    unavailableReason: null,
    rubricVersionNo: version,
    teams: rank(ready, snapshot.sums),
    provisional: [],
    versionWarnings: warnings,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ResultsQuery {
  search?: string;
  sort: ResultsSort;
  dir: 'asc' | 'desc';
}

function matches(t: TeamResult, search: string | undefined) {
  if (!search) return true;
  return [t.teamCode, t.name, t.projectName, ...t.judges.map((j) => j.fullName)]
    .join('\n')
    .toLowerCase()
    .includes(search);
}

function sortTeams<T extends TeamResult & { rank?: number; score?: number }>(
  list: T[],
  q: ResultsQuery,
): T[] {
  const value = (t: T): string | number => {
    switch (q.sort) {
      case 'name':
        return t.name.toLowerCase();
      case 'projectName':
        return t.projectName.toLowerCase();
      case 'judges':
        return t.assignedJudges;
      case 'submitted':
        return t.submitted;
      case 'teamCode':
        return t.teamCode.toLowerCase();
      default:
        return t.rank ?? 0;
    }
  };
  const sign = q.dir === 'desc' ? -1 : 1;
  return [...list].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    if (x < y) return -sign;
    if (x > y) return sign;
    return a.teamCode.localeCompare(b.teamCode) || a.teamId - b.teamId;
  });
}

export async function getResults(pool: Db, q: ResultsQuery): Promise<ResultsResponse> {
  const snapshot = 'getConnection' in pool ? await readSnapshot(pool) : await buildSnapshot(pool);
  const off = official(snapshot);
  const search = q.search?.trim().toLowerCase() || undefined;
  const ranked = new Set(off.teams.map((t) => t.teamId));
  const inProvisional = new Set(off.provisional.flatMap((g) => g.teams.map((t) => t.teamId)));
  const count = (s: TeamResultStatus) => snapshot.teams.filter((t) => t.status === s).length;

  return {
    computedAt: snapshot.computedAt,
    publishedVersionNo: snapshot.publishedVersionNo,
    official: {
      available: off.available,
      unavailableReason: off.unavailableReason,
      rubricVersionNo: off.rubricVersionNo,
      teams: sortTeams(
        off.teams.filter((t) => matches(t, search)),
        q,
      ),
    },
    provisional: off.provisional.map((g) => ({
      rubricVersionNo: g.rubricVersionNo,
      teams: sortTeams(
        g.teams.filter((t) => matches(t, search)),
        q,
      ),
    })),
    notRanked: sortTeams(
      snapshot.teams
        .filter((t) => !ranked.has(t.teamId) && !inProvisional.has(t.teamId))
        .filter((t) => matches(t, search)),
      // Unranked teams have no rank: "rank" order lists them by Team ID.
      q.sort === 'rank' ? { ...q, sort: 'teamCode' } : q,
    ),
    versionWarnings: off.versionWarnings,
    totals: {
      activeTeams: snapshot.teams.length,
      ready: count('ready'),
      blocked: count('blocked'),
      inProgress: count('in_progress'),
      notStarted: count('not_started'),
      unassigned: count('unassigned'),
    },
  };
}

/** Reuses eligibility and exact ranking, then projects only judge-visible fields.
 * Search happens AFTER projection: private judge names cannot influence matches.
 * Provisional groups never expose scores or ranks through this endpoint.
 */
export async function getJudgeLeaderboard(
  pool: Pool,
  q: { search?: string; sort: LeaderboardSort; dir: 'asc' | 'desc' },
): Promise<JudgeLeaderboardResponse> {
  const results = await getResults(pool, { sort: 'rank', dir: 'asc' });
  const identity = (t: TeamResult) => ({
    teamId: t.teamId,
    teamCode: t.teamCode,
    name: t.name,
    projectName: t.projectName,
  });
  const search = q.search?.trim().toLowerCase();
  const matches = (t: { teamCode: string; name: string; projectName: string }) =>
    !search || [t.teamCode, t.name, t.projectName].some((s) => s.toLowerCase().includes(search));
  const teams = results.official.teams
    .map((t) => ({
      ...identity(t),
      rank: t.rank,
      score: t.score,
      baseAverage: t.baseAverage,
      bonusAverage: t.bonusAverage,
      maximumScore: t.maximumScore,
      rubricVersionNo: t.rubricVersionNo,
    }))
    .filter(matches);
  const sign = q.dir === 'desc' ? -1 : 1;
  teams.sort((a, b) => {
    const x = a[q.sort];
    const y = b[q.sort];
    const comparison =
      typeof x === 'string' && typeof y === 'string'
        ? x.toLowerCase().localeCompare(y.toLowerCase())
        : Number(x) - Number(y);
    return sign * comparison || a.teamCode.localeCompare(b.teamCode) || a.teamId - b.teamId;
  });
  return {
    computedAt: results.computedAt,
    official: {
      available: results.official.available,
      unavailableReason: results.official.unavailableReason,
      rubricVersionNo: results.official.rubricVersionNo,
      teams,
    },
    notRanked: [
      ...results.notRanked.map((t) => ({ ...identity(t), status: t.status })),
      ...results.provisional.flatMap((g) =>
        g.teams.map((t) => ({ ...identity(t), status: 'version_conflict' as const })),
      ),
    ]
      .filter(matches)
      .sort((a, b) => a.teamCode.localeCompare(b.teamCode)),
    versionWarnings: results.versionWarnings,
    totalTeams: results.totals.activeTeams,
  };
}

export async function getDashboard(pool: Pool): Promise<DashboardResponse> {
  const snapshot = await readSnapshot(pool);
  const off = official(snapshot);
  const all = snapshot.teams.flatMap((t) => t.judges);
  const submitted = all.filter((j) => j.status === 'submitted');
  const draft = all.filter((j) => j.status === 'draft');
  const scored = submitted.filter((j) => j.score != null);

  const judges = new Map<number, DashboardResponse['judges'][number]>();
  for (const j of all) {
    const row = judges.get(j.judgeId) ?? {
      judgeId: j.judgeId,
      fullName: j.fullName,
      role: j.role,
      accountStatus: j.accountStatus,
      assigned: 0,
      submitted: 0,
      draft: 0,
      pending: 0,
    };
    row.assigned += 1;
    if (j.status === 'submitted') row.submitted += 1;
    else row.pending += 1;
    if (j.status === 'draft') row.draft += 1;
    judges.set(j.judgeId, row);
  }
  const judgeList = [...judges.values()].sort(
    (a, b) =>
      b.pending - a.pending || a.fullName.localeCompare(b.fullName) || a.judgeId - b.judgeId,
  );
  const teamStatus: Record<TeamResultStatus, number> = {
    unassigned: 0,
    not_started: 0,
    in_progress: 0,
    ready: 0,
    blocked: 0,
  };
  for (const t of snapshot.teams) teamStatus[t.status] += 1;

  return {
    computedAt: snapshot.computedAt,
    teams: { active: snapshot.teams.length, archived: snapshot.archivedTeams },
    accounts: { ...snapshot.accounts, participatingJudges: judges.size },
    evaluations: {
      required: all.length,
      submitted: submitted.length,
      draft: draft.length,
      notStarted: all.length - submitted.length - draft.length,
      pending: all.length - submitted.length,
      completionPercent: all.length ? (submitted.length / all.length) * 100 : null,
      averageSubmittedScore: scored.length
        ? scored.reduce((sum, j) => sum + toThousandths(j.score!), 0) / 1000 / scored.length
        : null,
      judgesWithPending: judgeList.filter((j) => j.pending > 0).length,
      teamsWaiting: teamStatus.not_started + teamStatus.in_progress,
    },
    teamStatus,
    judges: judgeList,
    topTeams: off.available ? off.teams.filter((t) => t.rank <= 3) : [],
    officialAvailable: off.available,
    officialUnavailableReason: off.unavailableReason,
  };
}
