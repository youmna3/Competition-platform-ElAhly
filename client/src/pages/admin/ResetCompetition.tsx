import { useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  RESET_ADMIN_EMAIL,
  RESET_PHRASE,
  RESET_PRESERVED_EMAILS,
  type ResetPreview,
} from '@judging/shared';
import { api } from '../../api/client';
import { Alert, Badge, Button, Card, PasswordField, TextField } from '../../components/ui';
import { Modal } from '../../components/Modal';

const DELETED = [
  'All teams and their projects',
  'All judge assignments',
  'All evaluations, draft and submitted, and every individual judge score',
  'All notes and comments',
  'All submission, reopening and evaluation history',
  'All administrator corrections and their snapshots',
  'All competition audit events',
  'All rubric drafts and published rubric versions',
  'All results, leaderboard positions and report data (calculated from the records above)',
  'Every user account except the three preserved accounts below',
];

/** Preview counts in display order. `projects` mirrors `teams` and is not added to the total. */
const COUNT_LABELS: Record<string, string> = {
  teams: 'Teams',
  projects: 'Projects (stored with teams)',
  team_judges: 'Judge assignments',
  evaluations: 'Evaluations (draft + submitted)',
  evaluation_scores: 'Individual judge scores',
  evaluation_section_notes: 'Notes and comments',
  evaluation_events: 'Submission and correction history',
  audit_log: 'Audit events',
  rubric_versions: 'Rubric versions (drafts + published)',
  rubric_sections: 'Rubric sections',
  rubric_criteria: 'Rubric questions',
  rubric_scale_levels: 'Rubric scale levels',
  users: 'User accounts (not preserved)',
};

function Check({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <span
        aria-hidden
        className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold ${ok ? 'bg-emerald-600 text-white' : 'bg-ahly-red-dark text-white'}`}
      >
        {ok ? '✓' : '✕'}
      </span>
      <span className="min-w-0">{children}</span>
    </li>
  );
}

export function ResetCompetition({
  maintenanceAvailable,
  executionEnabled,
}: {
  maintenanceAvailable: boolean;
  executionEnabled: boolean;
}) {
  const cache = useQueryClient();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [password, setPassword] = useState(''),
    [phrase, setPhrase] = useState('');
  const [preview, setPreview] = useState<ResetPreview | null>(null),
    [final, setFinal] = useState(false);

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
  function discard() {
    setPreview(null);
    setPassword('');
    setPhrase('');
    setError('');
  }

  const rows = preview
    ? [
        ...Object.keys(COUNT_LABELS).filter((k) => k in preview.counts),
        ...Object.keys(preview.counts).filter((k) => !(k in COUNT_LABELS)),
      ].map((k) => [k, COUNT_LABELS[k] ?? k.replaceAll('_', ' '), preview.counts[k] ?? 0] as const)
    : [];
  const total = rows.filter(([k]) => k !== 'projects').reduce((n, [, , v]) => n + v, 0);
  const accounts = RESET_PRESERVED_EMAILS.map(
    (email) =>
      [email, preview?.preservedAccounts.find((a) => a.email.toLowerCase() === email)] as const,
  );

  return (
    <Card className="border-ahly-red/40">
      <h2 className="text-lg font-semibold text-ahly-red-dark">Danger Zone</h2>
      <h3 className="mt-3 font-semibold">Reset Competition</h3>
      <div className="mt-3">
        <Alert tone="error" title="This permanently deletes competition data">
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {DELETED.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
          <p className="mt-2">
            Afterwards the competition returns to <strong>Preparation</strong> with no rubric and no
            evaluations, and everyone is signed out. Database tables, protections and migrations are
            kept. Recovery is only possible from the verified backup.
          </p>
        </Alert>
      </div>

      <div className="mt-3 space-y-3">
        {!maintenanceAvailable ? (
          <Alert tone="warning" title="Maintenance is turned off on this server">
            Backup, deletion preview and reset are disabled. The platform operator must open a
            maintenance window on the server before they can be used.
          </Alert>
        ) : !executionEnabled ? (
          <Alert tone="info" title="Preview-only maintenance window">
            You can create a verified backup and a deletion preview. Reset execution stays disabled
            until the operator explicitly enables it.
          </Alert>
        ) : (
          <Alert tone="warning" title="Reset execution is enabled on this server">
            The operator opened a time-limited maintenance window. It is turned off again right
            after use.
          </Alert>
        )}
      </div>

      <section className="mt-5" aria-labelledby="preserved-heading">
        <h4 id="preserved-heading" className="font-semibold text-ischool-blue-dark">
          Preserved Accounts
        </h4>
        <p className="mt-1 text-sm text-muted">
          These three accounts are kept with their existing ID, e-mail, password, role and status.
          Being preserved does not give reset permission: only {RESET_ADMIN_EMAIL} can run it. The
          reset is refused if any of them is missing.
        </p>
        <div className="mt-2 overflow-x-auto rounded-xl border border-line">
          <table className="w-full text-left text-sm">
            <thead className="bg-ischool-blue-soft text-ischool-blue-dark">
              <tr>
                <th className="px-3 py-2 font-semibold">E-mail</th>
                <th className="px-3 py-2 font-semibold">ID</th>
                <th className="px-3 py-2 font-semibold">Role</th>
                <th className="px-3 py-2 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map(([email, a]) => (
                <tr key={email} className="border-t border-line">
                  <td className="px-3 py-2 break-all">{email}</td>
                  <td className="px-3 py-2">{a ? a.id : '—'}</td>
                  <td className="px-3 py-2">{a ? a.role : '—'}</td>
                  <td className="px-3 py-2">
                    {a ? (
                      <Badge tone="green">Verified · kept unchanged</Badge>
                    ) : (
                      <Badge tone="gray">Checked at preview</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {error && !final && (
        <div className="mt-4">
          <Alert tone="error">{error}</Alert>
        </div>
      )}

      {!preview ? (
        <div className="mt-5 space-y-3">
          <p className="text-sm text-muted">
            Step 1: confirm your password. The server checks the preserved accounts, takes a full
            backup, verifies its checksum, test-restores it into an isolated database and counts
            what would be deleted. Nothing is deleted in this step.
          </p>
          <PasswordField
            label="Current password for backup and preview"
            disabled={busy || !maintenanceAvailable}
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Button
            variant="secondary"
            disabled={busy || !password || !maintenanceAvailable}
            onClick={() => void prepare()}
          >
            {busy ? 'Creating and verifying backup…' : 'Create backup and deletion preview'}
          </Button>
        </div>
      ) : (
        <div className="mt-5 space-y-5">
          <Alert tone="warning" title="Review deletion preview">
            No records have been deleted. This preview expires{' '}
            {new Date(preview.expiresAt).toLocaleTimeString()}. Any data change requires a new
            preview.
          </Alert>

          <section aria-labelledby="backup-heading">
            <h4 id="backup-heading" className="font-semibold text-ischool-blue-dark">
              Backup verification
            </h4>
            <ul className="mt-2 space-y-1.5 text-sm">
              <Check ok>
                Full backup of database <strong>{preview.database}</strong>:{' '}
                <span className="break-all">{preview.backup.name}</span> (
                {preview.backup.bytes.toLocaleString()} bytes)
              </Check>
              <Check ok={preview.backup.checksumVerified}>
                Complete and checksum verified ·{' '}
                <span className="font-mono text-xs break-all">SHA-256 {preview.backup.sha256}</span>
              </Check>
              <Check ok={preview.backup.restoreVerified}>
                Restored into an isolated database and matched the live data (
                {preview.backup.restored.tables} tables,{' '}
                {preview.backup.restored.rows.toLocaleString()} rows,{' '}
                {preview.backup.restored.triggers} protective triggers,{' '}
                {preview.backup.restored.routines} stored{' '}
                {preview.backup.restored.routines === 1 ? 'procedure' : 'procedures'})
              </Check>
            </ul>
          </section>

          <section aria-labelledby="preview-heading">
            <h4 id="preview-heading" className="font-semibold text-ischool-blue-dark">
              Records that will be deleted
            </h4>
            <div className="mt-2 overflow-x-auto rounded-xl border border-line">
              <table className="w-full text-sm">
                <tbody>
                  {rows.map(([key, label, n]) => (
                    <tr key={key} className="border-t border-line first:border-t-0">
                      <td className="px-3 py-1.5">{label}</td>
                      <td
                        className={`px-3 py-1.5 text-right font-semibold tabular-nums ${n ? 'text-ahly-red-dark' : 'text-muted'}`}
                      >
                        {n.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                  <tr className="border-t-2 border-line bg-red-50">
                    <td className="px-3 py-2 font-semibold">Total records</td>
                    <td className="px-3 py-2 text-right font-bold text-ahly-red-dark tabular-nums">
                      {total.toLocaleString()}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <div className="space-y-3">
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
                disabled={busy || !executionEnabled || phrase !== RESET_PHRASE || !password}
                onClick={() => setFinal(true)}
              >
                Reset Competition…
              </Button>
              <Button variant="secondary" disabled={busy} onClick={discard}>
                Discard preview
              </Button>
            </div>
            {!executionEnabled && (
              <p className="text-sm text-muted">
                Reset execution is disabled on this server, so this preview cannot be executed.
              </p>
            )}
          </div>
        </div>
      )}

      {final && preview && (
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
            Permanently delete {total.toLocaleString()} records from{' '}
            <strong>{preview.database}</strong> and keep only these accounts?
          </p>
          <ul className="mt-2 list-disc pl-5 text-sm">
            {preview.preservedAccounts.map((a) => (
              <li key={a.id} className="break-all">
                {a.email} (ID {a.id}, {a.role})
              </li>
            ))}
          </ul>
          <p className="mt-2 text-sm">
            Everyone will be signed out. Recovery requires backup {preview.backup.name}.
          </p>
          {error && (
            <div className="mt-3">
              <Alert tone="error">{error}</Alert>
            </div>
          )}
        </Modal>
      )}
    </Card>
  );
}
