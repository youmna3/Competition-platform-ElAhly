/** Rubric states shown to admins. Mirrors the database view v_rubric_status. */
export type RubricState =
  /** Nothing configured yet: no published version and no draft. */
  | 'not_configured'
  /** The admin has started a draft but nothing is published yet. */
  | 'draft_only'
  /** A version is published and no changes are pending. */
  | 'published'
  /** A version is published and the admin is editing a new draft. */
  | 'published_with_draft';

export const RUBRIC_STATE_LABELS: Record<RubricState, string> = {
  not_configured: 'Not configured',
  draft_only: 'Draft (not published)',
  published: 'Published',
  published_with_draft: 'Published, with unpublished changes',
};

export type BonusPolicy = 'separate' | 'add_to_total';
