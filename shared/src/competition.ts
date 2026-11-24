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
/** The only account allowed to request or execute a competition reset. */
export const RESET_ADMIN_EMAIL = 'youmna54@gmail.com';
/**
 * Accounts kept, unchanged, by a competition reset. Every other user is deleted.
 * Must match the list in migration 015's reset_competition procedure.
 * Being listed here does NOT grant reset permission (see RESET_ADMIN_EMAIL).
 */
export const RESET_PRESERVED_EMAILS: readonly string[] = [
  'youmna54@gmail.com',
  'nada.hussien@ischooltech.com',
  'abdelrhman.elagan@ischooltech.com',
];
export const RESET_PHRASE = 'RESET JUDGING PLATFORM';
export interface PreservedAccount {
  id: number;
  email: string;
  fullName: string;
  role: 'admin' | 'judge';
  status: 'active' | 'disabled';
}
export interface ResetPreview {
  token: string;
  expiresAt: string;
  database: string;
  counts: Record<string, number>;
  preservedAccounts: PreservedAccount[];
  backup: {
    name: string;
    sha256: string;
    bytes: number;
    /** The dump is complete and matches its SHA-256 sidecar. */
    checksumVerified: boolean;
    /** The dump was restored into an isolated scratch database and matched the live data. */
    restoreVerified: boolean;
    restored: { tables: number; rows: number; triggers: number; routines: number };
  };
}
