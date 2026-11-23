/**
 * Judge evaluations (Phase 6). The browser shows live scores with the shared
 * scoring functions in rubric.ts; the server recomputes and stores them, and
 * never trusts totals sent by the browser.
 */
import type { RubricVersion } from './rubric.js';
import type { TeamStatus } from './teams.js';

export type EvaluationStatus = 'draft' | 'submitted';

export const EVALUATION_LIMITS = {
  criterionNote: 2000,
  sectionNote: 4000,
  overallNotes: 5000,
} as const;

export interface CriterionRating {
  criterionId: number;
  /** Whole stars 1–5, or null while not rated. */
  rating: number | null;
  note: string;
}

export interface SectionNote {
  sectionId: number;
  note: string;
}

/** Everything a judge edits; what a save sends. */
export interface EvaluationInput {
  ratings: CriterionRating[];
  sectionNotes: SectionNote[];
  overallNotes: string;
}

export interface EvaluationDetail extends EvaluationInput {
  adminModifiedAt?: string | null;
  id: number;
  teamId: number;
  judgeId: number;
  rubricVersionId: number;
  rubricVersionNo: number;
  status: EvaluationStatus;
  /** Increases on every save; a save or submit must name the one it started from. */
  rowVersion: number;
  /** Computed by the server: sum of the sections that are fully rated (all 4 once complete). */
  totalScore: number;
  baseScore?: number;
  bonusScore?: number;
  maximumScore?: number;
  ratedCount: number;
  requiredCount: number;
  submittedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Times an administrator reopened it, and the latest reopening. */
  reopenedCount: number;
  reopenedAt: string | null;
  reopenReason: string | null;
  /** The judge hasn't seen the latest reopening yet. */
  reopenNoticePending: boolean;
}

export interface EvaluationTeam {
  id: number;
  teamCode: string;
  name: string;
  projectName: string;
  status: TeamStatus;
}

/** GET /api/judge/teams/:teamId/evaluation */
export interface JudgeEvaluationResponse {
  team: EvaluationTeam;
  /** The evaluation's own rubric version, or the published one if not started. */
  rubric: RubricVersion | null;
  publishedVersionNo: number | null;
  evaluation: EvaluationDetail | null;
  /** True when this judge may start or edit right now. */
  canEdit: boolean;
  /** Why editing isn't possible, shown to the judge. */
  readOnlyReason: string | null;
}

export interface SaveEvaluationRequest extends EvaluationInput {
  rowVersion: number;
}

export interface SubmitEvaluationRequest {
  rowVersion: number;
}

export interface SubmitEvaluationResponse {
  evaluation: EvaluationDetail;
  /** True when it was already submitted (a repeated click or request). */
  alreadySubmitted: boolean;
}

export const EVALUATION_ERRORS = {
  NOT_ASSIGNED: 'NOT_ASSIGNED',
  TEAM_ARCHIVED: 'TEAM_ARCHIVED',
  NO_RUBRIC: 'NO_RUBRIC',
  EVALUATION_CONFLICT: 'EVALUATION_CONFLICT',
  EVALUATION_LOCKED: 'EVALUATION_LOCKED',
  EVALUATION_INCOMPLETE: 'EVALUATION_INCOMPLETE',
  EVALUATION_INVALID: 'EVALUATION_INVALID',
} as const;

/** Scores are always shown with two decimals, e.g. 27.00. */
export function formatScore(value: number): string {
  return (Math.round(value * 100) / 100).toFixed(2);
}
