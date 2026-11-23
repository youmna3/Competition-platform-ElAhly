import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  COMPETITION_LABELS,
  RESET_ADMIN_EMAIL,
  RESET_PHRASE,
  type CompetitionStatus,
  type ResetPreview,
} from '@judging/shared';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Alert, Button, Card, PasswordField, TextField } from '../../components/ui';
import { Modal } from '../../components/Modal';

export function CompetitionSettings() {
  const { user } = useAuth();
  const cache = useQueryClient();
  const query = useQuery({
    queryKey: ['admin', 'competition'],
    queryFn: () =>
      api<CompetitionStatus & { resetExecutionEnabled: boolean }>('/api/admin/competition'),
    refetchInterval: 15000,
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [password, setPassword] = useState(''),
    [phrase, setPhrase] = useState('');
  const [preview, setPreview] = useState<ResetPreview | null>(null),
    [final, setFinal] = useState(false);
  const [transition, setTransition] = useState<{
    target: 'judging_open' | 'closed';
    rowVersion: number;
  } | null>(null);
  const c = query.data;
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
  async function prepare() {
    await run(async () => {
      setPreview(null);
      setPhrase('');
      const data = await api<ResetPreview>('/api/admin/competition/reset/preview', {
        method: 'POST',
        body: { password },
      });
      setPassword('');
      setPreview(data);
    });
  }
  async function execute() {
    if (!preview) return;
    await run(async () => {
      await api('/api/admin/competition/reset/execute', {
        method: 'POST',
        body: { token: preview.token, password, phrase, confirmed: true },
      });
      setPassword('');
      cache.clear();
      window.location.assign('/login');
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
                ? 'Publish a valid rubric, finish any draft and assign active judges to every active team before starting. Existing teams may have fewer than three judges.'
                : c.state === 'judging_open'
                  ? `Rubric v${c.lockedRubricVersionNo} is locked for judging. Close the competition when results are final.`
                  : 'Final leaderboard and reports remain available. All competition edits are disabled.'}
            </p>
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
        <Card className="border-ahly-red/40">
          <h2 className="text-lg font-semibold text-ahly-red-dark">Danger Zone</h2>
          <h3 className="mt-3 font-semibold">Reset Competition</h3>
          <p className="mt-2 text-sm text-muted">
            Deletes all teams, projects, assignments, evaluations, history, corrections, audit
            events, rubrics and other users. Only {RESET_ADMIN_EMAIL} and their existing password
            remain. A complete verified backup is required.
          </p>
          {!c?.resetExecutionEnabled && (
            <div className="mt-3">
              <Alert tone="warning">
                Reset execution is disabled pending operator approval. You can create a backup and
                deletion preview without deleting data.
              </Alert>
            </div>
          )}
          {!preview ? (
            <div className="mt-4 space-y-3">
              <PasswordField
                label="Current password for backup and preview"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <Button
                variant="secondary"
                disabled={busy || !password}
                onClick={() => void prepare()}
              >
                {busy ? 'Creating verified backup…' : 'Create backup and deletion preview'}
              </Button>
            </div>
          ) : (
            <div className="mt-4 space-y-4">
              <Alert tone="warning" title="Review deletion preview">
                No records have been deleted. This preview expires{' '}
                {new Date(preview.expiresAt).toLocaleTimeString()}. Any data change requires a new
                preview.
              </Alert>
              <dl className="grid grid-cols-2 gap-2 text-sm">
                {Object.entries(preview.counts).map(([name, n]) => (
                  <div key={name} className="flex justify-between gap-2">
                    <dt>{name.replaceAll('_', ' ')}</dt>
                    <dd className="font-semibold">{n}</dd>
                  </div>
                ))}
              </dl>
              <p className="break-all text-xs">
                Verified backup: {preview.backup.name}
                <br />
                SHA-256: {preview.backup.sha256}
                <br />
                {preview.backup.bytes.toLocaleString()} bytes
              </p>
              <p className="text-sm font-semibold">Preserve: {preview.preservedEmail}</p>
              <PasswordField
                label="Verify current password again"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <TextField
                label={`Type ${RESET_PHRASE}`}
                autoComplete="off"
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
              />
              <div className="flex flex-wrap gap-3">
                <Button
                  variant="danger"
                  disabled={
                    busy || !c?.resetExecutionEnabled || phrase !== RESET_PHRASE || !password
                  }
                  onClick={() => setFinal(true)}
                >
                  Reset Competition…
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    setPreview(null);
                    setPassword('');
                    setPhrase('');
                  }}
                >
                  Discard preview
                </Button>
              </div>
            </div>
          )}
        </Card>
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
      {final && (
        <Modal
          title="Final confirmation — delete competition data?"
          onClose={() => setFinal(false)}
          canClose={!busy}
          footer={
            <>
              <Button variant="secondary" disabled={busy} onClick={() => setFinal(false)}>
                Cancel
              </Button>
              <Button variant="danger" disabled={busy} onClick={() => void execute()}>
                {busy ? 'Resetting…' : 'Confirm permanent reset'}
              </Button>
            </>
          }
        >
          <p>
            Delete the records in the preview and retain only {RESET_ADMIN_EMAIL}? Everyone will be
            signed out. Recovery requires the verified backup.
          </p>
          {error && <Alert tone="error">{error}</Alert>}
        </Modal>
      )}
    </div>
  );
}
