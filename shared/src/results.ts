/**
 * Official results (Phase 8): team eligibility, the single competition ranking,
 * and the administrator dashboard. Everything is computed on the server from
 * stored ratings; the browser only displays it.
 *
 * Official team score = average of the submitted final scores of the judges
 * currently assigned to the team (every judge, admin or not, has equal weight).
 */
import type { UserRole } from './auth.js';
import type { AccountStatus } from './users.js';
import type { EvaluationProgress } from './teams.js';

/** Builds on the Phase 7 team completion states (no_judges → unassigned, complete → ready or blocked). */
export type TeamResultStatus = 'unassigned' | 'not_started' | 'in_progress' | 'ready' | 'blocked';

export const TEAM_RESULT_STATUS_LABELS: Record<TeamResultStatus, string> = {
  unassigned: 'Unassigned',
  not_started: 'Not started',
  in_progress: 'In progress',
  ready: 'Ready for results',
  blocked: 'Blocked',
};

export interface JudgeResult {
  judgeId: number;
  fullName: string;
  role: UserRole;
  accountStatus: AccountStatus;
  evaluationId: number | null;
  status: EvaluationProgress;
  /** Reopened by an administrator and not yet resubmitted. */
  reopened: boolean;
  /** Recomputed from the stored ratings; only for submitted evaluations. */
  score: number | null;
  baseScore?: number | null;
  bonusScore?: number | null;
  maximumScore?: number;
  rubricVersionNo: number | null;
}

export interface TeamResult {
  teamId: number;
  teamCode: string;
  name: string;
  projectName: string;
  status: TeamResultStatus;
  assignedJudges: number;
  submitted: number;
  pending: number;
  /** Rubric versions used by the assigned judges' evaluations, ascending. */
  versions: number[];
  /** Average of submitted scores so far: provisional, never an official score. */
  provisionalAverage: number | null;
  baseAverage?: number | null;
  bonusAverage?: number | null;
  maximumScore?: number | null;
  /** Why the team is not (yet) officially ranked. Empty for ranked teams. */
  reasons: string[];
  judges: JudgeResult[];
}

export interface RankedTeam extends TeamResult {
  /** Competition ranking: equal scores share a rank (1, 1, 3). */
  rank: number;
  /** Full-precision average; round only for display. */
  score: number;
  rubricVersionNo: number;
}

export interface ProvisionalGroup {
  rubricVersionNo: number;
  /** Ranked among teams of this version only. Not official. */
  teams: RankedTeam[];
}

export interface ResultsResponse {
  computedAt: string;
  publishedVersionNo: number | null;
  official: {
    /** True when an official, comparable ranking exists. */
    available: boolean;
    /** Why there is no official ranking (no ready teams, or versions differ). */
    unavailableReason: string | null;
    rubricVersionNo: number | null;
    teams: RankedTeam[];
  };
  /** When ready teams span several rubric versions: per-version provisional rankings. */
  provisional: ProvisionalGroup[];
  /** Active teams that are not officially ranked, with reasons. */
  notRanked: TeamResult[];
  /** Other evaluations using a different version than the ranked teams. */
  versionWarnings: string[];
  totals: {
    activeTeams: number;
    ready: number;
    blocked: number;
    inProgress: number;
    notStarted: number;
    unassigned: number;
  };
}

export const RESULTS_SORTS = [
  'rank',
  'teamCode',
  'name',
  'projectName',
  'judges',
  'submitted',
] as const;
export type ResultsSort = (typeof RESULTS_SORTS)[number];

/** Explicit allowlist for authenticated, read-only competition results. */
export const LEADERBOARD_SORTS = ['rank', 'teamCode', 'name', 'projectName', 'score'] as const;
export type LeaderboardSort = (typeof LEADERBOARD_SORTS)[number];
export type LeaderboardTeam = Pick<
  RankedTeam,
  | 'teamId'
  | 'teamCode'
  | 'name'
  | 'projectName'
  | 'rank'
  | 'score'
  | 'rubricVersionNo'
  | 'baseAverage'
  | 'bonusAverage'
  | 'maximumScore'
>;
export interface JudgeLeaderboardResponse {
  computedAt: string;
  official: {
    available: boolean;
    unavailableReason: string | null;
    rubricVersionNo: number | null;
    teams: LeaderboardTeam[];
  };
  notRanked: (Pick<TeamResult, 'teamId' | 'teamCode' | 'name' | 'projectName'> & {
    status: TeamResultStatus | 'version_conflict';
  })[];
  versionWarnings: string[];
  totalTeams: number;
}

export interface DashboardResponse {
  computedAt: string;
  teams: { active: number; archived: number };
  accounts: { judges: number; administrators: number; participatingJudges: number };
  evaluations: {
    /** One per current assignment to an active team. */
    required: number;
    submitted: number;
    draft: number;
    notStarted: number;
    pending: number;
    completionPercent: number | null;
    /** Mean of submitted scores: a descriptive figure, not a result. */
    averageSubmittedScore: number | null;
    judgesWithPending: number;
    /** Active teams with judges whose evaluations are not all submitted. */
    teamsWaiting: number;
  };
  teamStatus: Record<TeamResultStatus, number>;
  judges: {
    judgeId: number;
    fullName: string;
    role: UserRole;
    accountStatus: AccountStatus;
    assigned: number;
    submitted: number;
    draft: number;
    pending: number;
  }[];
  /** Top three officially ranked teams; empty when no comparable ranking exists. */
  topTeams: RankedTeam[];
  officialAvailable: boolean;
  officialUnavailableReason: string | null;
}

// ---------------------------------------------------------------------------
// Ranking (pure, exact)
// ---------------------------------------------------------------------------

/**
 * Rank input uses integer point units. Legacy callers default to thousandths;
 * official results use 63,000 units per point, an exact common denominator for
 * 1-10 equally weighted questions and legacy thousandths. Integer cross-products
 * compare judge averages without rounding or floating-point tie errors.
 */
export interface RankInput {
  scale?: number;
  /** Sum of judges' scores in integer units defined by scale. */
  sumThousandths: number;
  judges: number;
  /** Deterministic display order among exact ties (does not affect the rank). */
  tieOrder: string;
}

export const toThousandths = (score: number) => Math.round(score * 1000);

export function compareAverages(a: RankInput, b: RankInput): number {
  // Positive when b's average is higher (so sort puts the highest first).
  const difference =
    BigInt(b.sumThousandths) * BigInt(a.judges) * BigInt(a.scale ?? 1000) -
    BigInt(a.sumThousandths) * BigInt(b.judges) * BigInt(b.scale ?? 1000);
  return difference > 0n ? 1 : difference < 0n ? -1 : 0;
}

/** Sorts highest first and assigns competition ranks (1, 1, 3). */
export function rankTeams<T extends RankInput>(
  items: T[],
): (T & { rank: number; average: number })[] {
  const sorted = [...items].sort(
    (a, b) => compareAverages(a, b) || a.tieOrder.localeCompare(b.tieOrder),
  );
  const out: (T & { rank: number; average: number })[] = [];
  sorted.forEach((item, i) => {
    const prev = out[i - 1];
    const tied = prev != null && compareAverages(prev, item) === 0;
    out.push({
      ...item,
      rank: tied ? prev.rank : i + 1,
      average: item.sumThousandths / (item.scale ?? 1000) / item.judges,
    });
  });
  return out;
}
