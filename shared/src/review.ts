/**
 * Administrator review of evaluations (Phase 7): the team-by-team list, the
 * read-only review of one evaluation, its history, reopening, and judge progress.
 */
import type { UserRole } from './auth.js';
import type { AccountStatus } from './users.js';
import type { EvaluationDetail, EvaluationTeam } from './evaluations.js';
import type { RubricVersion } from './rubric.js';
import type { EvaluationProgress, TeamStatus } from './teams.js';

export const REOPEN_REASON = { min: 5, max: 500 } as const;

export type TeamCompletion = 'no_judges' | 'not_started' | 'in_progress' | 'complete';

export const TEAM_COMPLETION_LABELS: Record<TeamCompletion, string> = {
  no_judges: 'No judges',
  not_started: 'Not started',
  in_progress: 'In progress',
  complete: 'All submitted',
};

export interface AdminEvaluationJudge {
  judgeId: number;
  fullName: string;
  email: string;
  role: UserRole;
  accountStatus: AccountStatus;
  evaluationId: number | null;
  status: EvaluationProgress;
  ratedCount: number;
  /** Score of a submitted evaluation; null otherwise. */
  totalScore: number | null;
  rubricVersionNo: number | null;
  submittedAt: string | null;
  updatedAt: string | null;
  reopenedCount: number;
}

export interface AdminTeamEvaluations {
  teamId: number;
  teamCode: string;
  name: string;
  projectName: string;
  teamStatus: TeamStatus;
  /** Currently assigned judges and their evaluations. */
  judges: AdminEvaluationJudge[];
  assignedJudges: number;
  submitted: number;
  pending: number;
  completion: TeamCompletion;
  /** Average of the submitted scores of currently assigned judges (not an official result). */
  provisionalAverage: number | null;
  /** Rubric versions used by these evaluations, ascending. */
  versions: number[];
  mixedVersions: boolean;
  /** Every assigned judge has submitted, all on the same rubric version. */
  readyForResults: boolean;
  lastSubmittedAt: string | null;
}

export type EvaluationListSort =
  'teamCode' | 'name' | 'submitted' | 'pending' | 'average' | 'lastSubmitted';
export type CompletionFilter =
  'complete' | 'incomplete' | 'not_started' | 'no_judges' | 'mixed_versions' | 'ready';

export interface AdminEvaluationsResponse {
  teams: AdminTeamEvaluations[];
  total: number;
  page: number;
  pageSize: number;
  /** For the filters. */
  versionsInUse: number[];
  judges: { id: number; fullName: string; role: UserRole }[];
}

export interface ReopenInfo {
  at: string;
  byEmail: string | null;
  reason: string;
  count: number;
}

export interface AdminEvaluationDetail {
  team: EvaluationTeam;
  judge: {
    id: number;
    fullName: string;
    email: string;
    role: UserRole;
    accountStatus: AccountStatus;
  };
  /** The judge is currently assigned to this team. */
  judgeAssigned: boolean;
  rubric: RubricVersion;
  publishedVersionNo: number | null;
  evaluation: EvaluationDetail;
  /** Recomputed from the stored ratings with this evaluation's own rubric version. */
  sectionScores: (number | null)[];
  lastSavedAt: string | null;
  saveCount: number;
  reopen: ReopenInfo | null;
  canReopen: boolean;
  reopenBlockedReason: string | null;
}

export interface SubmissionSnapshot {
  totalScore: number;
  sections: {
    sectionId: number;
    title: string;
    weightPercent: number;
    score: number;
    note: string;
  }[];
  ratings: {
    criterionId: number;
    sectionId: number;
    title: string;
    rating: number;
    note: string;
  }[];
  overallNotes: string;
}

export type EvaluationEventType =
  'started' | 'draft_saved' | 'submitted' | 'reopened' | 'resubmitted';

export interface EvaluationEvent {
  id: number;
  event: EvaluationEventType;
  actorEmail: string | null;
  actorName: string | null;
  createdAt: string;
  rubricVersionNo: number;
  ratedCount: number;
  totalScore: number | null;
  previousScore: number | null;
  reason: string | null;
  /** Present on submissions made since history was recorded. */
  snapshot: SubmissionSnapshot | null;
}

export interface EvaluationHistoryResponse {
  events: EvaluationEvent[];
}

export interface ReopenEvaluationRequest {
  reason: string;
}

export interface JudgeProgressRow {
  judgeId: number;
  fullName: string;
  email: string;
  role: UserRole;
  accountStatus: AccountStatus;
  /** Active teams currently assigned. */
  assignedTeams: number;
  notStarted: number;
  draft: number;
  submitted: number;
  /** submitted / assignedTeams, 0–100; null with no assignments. */
  completionPercent: number | null;
  lastSubmittedAt: string | null;
  /** Evaluations kept from teams the judge is no longer assigned to (or archived teams). */
  otherEvaluations: number;
}

export interface JudgeProgressResponse {
  judges: JudgeProgressRow[];
}

export const REVIEW_ERRORS = {
  EVALUATION_NOT_FOUND: 'EVALUATION_NOT_FOUND',
  NOT_SUBMITTED: 'NOT_SUBMITTED',
  JUDGE_NOT_ASSIGNED: 'JUDGE_NOT_ASSIGNED',
  ACCOUNT_DISABLED: 'ACCOUNT_DISABLED',
  TEAM_ARCHIVED: 'TEAM_ARCHIVED',
  INVALID_REASON: 'INVALID_REASON',
} as const;
