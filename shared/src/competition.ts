export type CompetitionState = 'preparation' | 'judging_open' | 'closed';
export interface CompetitionStatus {
  state: CompetitionState;
  rowVersion: number;
  lockedRubricVersionId: number | null;
  lockedRubricVersionNo: number | null;
  startedAt: string | null;
  closedAt: string | null;
}
export const COMPETITION_LABELS: Record<CompetitionState, string> = {
  preparation: 'Preparation',
  judging_open: 'Judging Open',
  closed: 'Closed — final results',
};
export const RESET_ADMIN_EMAIL = 'youmna54@gmail.com';
export const RESET_PHRASE = 'RESET JUDGING PLATFORM';
export interface ResetPreview {
  token: string;
  expiresAt: string;
  counts: Record<string, number>;
  preservedEmail: string;
  backup: { name: string; sha256: string; bytes: number };
}
