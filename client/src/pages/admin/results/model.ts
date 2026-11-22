import type { TeamResultStatus } from '@judging/shared';

export const RESULT_STATUS_TONES: Record<
  TeamResultStatus,
  'neutral' | 'gray' | 'gold' | 'green' | 'red'
> = {
  unassigned: 'neutral',
  not_started: 'gray',
  in_progress: 'gold',
  ready: 'green',
  blocked: 'red',
};

/** How often open results pages refresh themselves (a manual refresh is always available). */
export const RESULTS_POLL_MS = 30_000;

export const formatTime = (iso: string) =>
  new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' }).format(new Date(iso));
