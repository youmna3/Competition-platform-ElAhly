import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  COMPETITION_LABELS,
  RESET_ADMIN_EMAIL,
  type CompetitionStatus,
  type ResultsResponse,
} from '@judging/shared';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Alert, Button, Card } from '../../components/ui';
import { Modal } from '../../components/Modal';
import { ResetCompetition } from './ResetCompetition';

const RECOMMENDED_JUDGES = 3;

export function CompetitionSettings() {
  const { user } = useAuth();
  const cache = useQueryClient();
  const query = useQuery({
    queryKey: ['admin', 'competition'],
    queryFn: () =>
      api<CompetitionStatus & { resetExecutionEnabled: boolean; maintenanceAvailable?: boolean }>(
        '/api/admin/competition',
      ),
    refetchInterval: 15000,
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [transition, setTransition] = useState<{
    target: 'judging_open' | 'closed';
    rowVersion: number;
  } | null>(null);
  const c = query.data;
  // Recommended panel size. A warning only: teams with fewer judges can still be judged.
  const results = useQuery({
    queryKey: ['admin', 'results', 'judge-count-check'],
    queryFn: () => api<ResultsResponse>('/api/admin/results'),
    enabled: !!c && c.state !== 'closed',
  });
  const shortTeams = results.data?.official
    ? [
        ...results.data.official.teams,
        ...results.data.provisional.flatMap((g) => g.teams),
        ...results.data.notRanked,
      ]
        .filter((t) => t.assignedJudges < RECOMMENDED_JUDGES)
        .sort((a, b) => a.teamCode.localeCompare(b.teamCode))
    : [];
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed.');
    } finally {
      setBusy(false);
    }
  }
  async function change() {
    if (!transition) return;
    await run(async () => {
      await api('/api/admin/competition/transition', {
        method: 'POST',
        body: { ...transition, confirmed: true },
      });
      setTransition(null);
      await cache.invalidateQueries();
    });
  }
  return (
    <div className="space-y-6">
      {(error || query.isError) && <Alert tone="error">{error || query.error?.message}</Alert>}
      <Card>
        <h2 className="text-lg font-semibold">Competition lifecycle</h2>
        {c ? (
          <div className="mt-3 space-y-3">
            <p className="font-semibold text-ischool-blue-dark">{COMPETITION_LABELS[c.state]}</p>
            <p className="text-sm text-muted">
              {c.state === 'preparation'
                ? 'Publish a valid rubric, finish any draft and assign active judges to every active team before starting.'
                : c.state === 'judging_open'
                  ? `Rubric v${c.lockedRubricVersionNo} is locked for judging. Close the competition when results are final.`
                  : 'Final leaderboard and reports remain available. All competition edits are disabled.'}
            </p>
            {shortTeams.length > 0 && (
              <Alert
                tone="warning"
                title={`${shortTeams.length} active team${shortTeams.length === 1 ? ' has' : 's have'} fewer than ${RECOMMENDED_JUDGES} judges`}
              >
                Each team should have {RECOMMENDED_JUDGES} judges. This is a recommendation only;
                these teams can still be judged and ranked:{' '}
                {shortTeams
                  .slice(0, 12)
                  .map((t) => `${t.teamCode} (${t.assignedJudges})`)
                  .join(', ')}
                {shortTeams.length > 12 ? ` and ${shortTeams.length - 12} more` : ''}.
              </Alert>
            )}
            {c.state !== 'closed' && (
              <Button
                disabled={busy}
                onClick={() =>
                  setTransition({
                    target: c.state === 'preparation' ? 'judging_open' : 'closed',
                    rowVersion: c.rowVersion,
                  })
                }
              >
                {c.state === 'preparation' ? 'Start competition' : 'Close competition'}
              </Button>
            )}
          </div>
        ) : (
          <p role="status">Loading competition settings…</p>
        )}
      </Card>
      {user?.email.toLowerCase() === RESET_ADMIN_EMAIL && (
        <ResetCompetition
          maintenanceAvailable={c?.maintenanceAvailable !== false}
          executionEnabled={!!c?.resetExecutionEnabled}
        />
      )}
      {transition && (
        <Modal
          title={transition.target === 'closed' ? 'Close competition?' : 'Start competition?'}
          onClose={() => setTransition(null)}
          canClose={!busy}
          footer={
            <>
              <Button variant="secondary" disabled={busy} onClick={() => setTransition(null)}>
                Cancel
              </Button>
              <Button disabled={busy} onClick={() => void change()}>
                Confirm {transition.target === 'closed' ? 'close' : 'start'}
              </Button>
            </>
          }
        >
          <p>
            {transition.target === 'closed'
              ? 'Closing makes results read-only and disables judging, administrative corrections and reopening. It cannot be reversed through the application.'
              : 'Starting freezes the selected published rubric for every new evaluation. Rubric changes are disabled until the next competition reset.'}
          </p>
          {error && <Alert tone="error">{error}</Alert>}
        </Modal>
      )}
    </div>
  );
}
