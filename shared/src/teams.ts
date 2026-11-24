import type { UserRole } from './auth.js';
import type { AccountStatus } from './users.js';

export type TeamStatus = 'active' | 'archived';
export type EvaluationProgress = 'not_started' | 'draft' | 'submitted';

export const TEAM_STATUS_LABELS: Record<TeamStatus, string> = {
  active: 'Active',
  archived: 'Archived',
};
export const EVALUATION_PROGRESS_LABELS: Record<EvaluationProgress, string> = {
  not_started: 'Not started',
  draft: 'In progress',
  submitted: 'Submitted',
};

/** Limits shared by the forms, the import file and the server. */
export const TEAM_LIMITS = {
  code: 40,
  name: 200,
  project: 200,
  reason: 500,
  importRows: 2000,
  studentName: 200,
  link: 2048,
} as const;
/** Letters (any language), digits, spaces and - _ . / # */
export const TEAM_CODE_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} _\-./#]*$/u;

export interface TeamResources {
  studentNames?: string[];
  presentationLink?: string | null;
  projectWebsiteLink?: string | null;
}

export interface TeamSummary extends TeamResources {
  id: number;
  teamCode: string;
  name: string;
  projectName: string;
  status: TeamStatus;
  createdAt: string;
  archivedAt: string | null;
  /** Judges currently assigned. */
  assignedJudges: number;
  /** Submitted / in-progress evaluations by currently assigned judges. */
  submittedEvaluations: number;
  draftEvaluations: number;
  /** Evaluations of this team use more than one rubric version: needs administrator review. */
  mixedVersions: boolean;
}

export type TeamSortField =
  'teamCode' | 'name' | 'projectName' | 'createdAt' | 'assignedJudges' | 'progress';

export interface TeamsListResponse {
  teams: TeamSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export interface TeamAssignment {
  judgeId: number;
  fullName: string;
  email: string;
  role: UserRole;
  accountStatus: AccountStatus;
  assignedAt: string;
  assignedByEmail: string | null;
  evaluationStatus: EvaluationProgress;
  submittedAt: string | null;
  ratedCount: number;
  /** Final score once submitted. */
  totalScore: number | null;
  rubricVersionNo: number | null;
  /** The evaluation uses an older rubric version than the published one. */
  outdatedVersion: boolean;
  evaluationId: number | null;
  /** Section weights of the rubric version this evaluation uses. */
  weights: number[] | null;
  updatedAt: string | null;
}

/** An evaluation kept from a judge who is no longer assigned (history is never deleted). */
export interface PastEvaluation {
  judgeId: number;
  fullName: string;
  email: string;
  evaluationStatus: Exclude<EvaluationProgress, 'not_started'>;
  submittedAt: string | null;
  totalScore: number | null;
  rubricVersionNo: number;
  evaluationId: number;
}

export interface TeamDetails extends TeamSummary {
  archiveReason: string | null;
  createdByEmail: string | null;
  assignments: TeamAssignment[];
  pastEvaluations: PastEvaluation[];
  /** Average of assigned judges' submitted scores; provisional, not an official result. */
  provisionalAverage: number | null;
  /** Every assigned judge has submitted on the same rubric version. */
  readyForResults: boolean;
  lastUpdatedAt: string | null;
}

export interface TeamInput extends TeamResources {
  teamCode: string;
  name: string;
  projectName: string;
}

/** An account that can receive assignments (active judges and administrators). */
export interface AssignableUser {
  id: number;
  fullName: string;
  email: string;
  role: UserRole;
  /** Active teams this person is assigned to. */
  assignedTeams: number;
}

export interface BulkAssignRequest {
  teamIds: number[];
  judgeIds: number[];
}

export interface BulkAssignResponse {
  added: number;
  alreadyAssigned: number;
}

// ---------- import ----------

export interface ImportRowInput extends TeamResources {
  /** 1-based line number in the uploaded file (header is line 1). */
  rowNumber: number;
  teamCode: string;
  name: string;
  projectName: string;
}

export type ImportAction = 'create' | 'update' | 'unchanged' | 'error';

export interface ImportRowResult {
  rowNumber: number;
  teamCode: string;
  action: ImportAction;
  errors: string[];
  /** For updates: field -> old and new value. */
  changes: Record<string, { from: string; to: string }>;
  warnings: string[];
}

export interface ImportPreview {
  rows: ImportRowResult[];
  summary: { create: number; update: number; unchanged: number; error: number };
}

export interface ImportCommitResponse {
  created: number;
  updated: number;
  unchanged: number;
}

export const TEAM_ERRORS = {
  TEAM_CODE_TAKEN: 'TEAM_CODE_TAKEN',
  TEAM_NOT_FOUND: 'TEAM_NOT_FOUND',
  TEAM_ARCHIVED: 'TEAM_ARCHIVED',
  ACCOUNT_DISABLED: 'ACCOUNT_DISABLED',
  ACCOUNT_NOT_FOUND: 'ACCOUNT_NOT_FOUND',
  IMPORT_INVALID: 'IMPORT_INVALID',
  UPDATE_CONFIRMATION_REQUIRED: 'UPDATE_CONFIRMATION_REQUIRED',
} as const;
