import type { TeamResources } from './teams.js';
/** Authentication types shared by the API and the web client. */

export type UserRole = 'admin' | 'judge';

export const ROLE_LABELS: Record<UserRole, string> = {
  admin: 'Administrator',
  judge: 'Judge',
};

/** The signed-in user as returned by GET /api/auth/me. Never contains secrets. */
export interface AuthUser {
  id: number;
  email: string;
  fullName: string;
  role: UserRole;
  mustChangePassword: boolean;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

/** Error codes the client reacts to. */
export const AUTH_ERRORS = {
  NOT_AUTHENTICATED: 'NOT_AUTHENTICATED',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  ACCOUNT_DISABLED: 'ACCOUNT_DISABLED',
  PASSWORD_CHANGE_REQUIRED: 'PASSWORD_CHANGE_REQUIRED',
  FORBIDDEN: 'FORBIDDEN',
  TOO_MANY_ATTEMPTS: 'TOO_MANY_ATTEMPTS',
  CURRENT_PASSWORD_INCORRECT: 'CURRENT_PASSWORD_INCORRECT',
  WEAK_PASSWORD: 'WEAK_PASSWORD',
  ORIGIN_MISMATCH: 'ORIGIN_MISMATCH',
} as const;

/** Where each role lands after signing in. */
export function homePathForRole(role: UserRole): string {
  return role === 'admin' ? '/admin' : '/judge';
}

/** GET /api/admin/overview */
export interface AdminOverview {
  rubricState: import('./rubric.js').RubricState;
  publishedRubricVersion: number | null;
  activeJudges: number;
  activeAdmins: number;
  activeTeams: number;
  archivedTeams: number;
  submittedEvaluations: number;
}

/** GET /api/judge/assignments */
export interface JudgeAssignment extends TeamResources {
  teamId: number;
  teamCode: string;
  teamName: string;
  projectName: string;
  assignedAt: string;
  evaluationStatus: 'not_started' | 'draft' | 'submitted';
  /** Criteria rated so far (of requiredCount, 8). */
  ratedCount: number;
  requiredCount: number;
  /** Final score once submitted. */
  totalScore: number | null;
  submittedAt: string | null;
  /** Rubric version the evaluation uses, and whether it is older than the published one. */
  rubricVersionNo: number | null;
  outdatedVersion: boolean;
  /** An administrator reopened this evaluation and the judge hasn't opened it since. */
  reopenNotice: boolean;
  reopenReason: string | null;
}
