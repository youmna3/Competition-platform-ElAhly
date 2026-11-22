import { useRef, useState, type ChangeEvent } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type {
  ImportAction,
  ImportCommitResponse,
  ImportPreview,
  ImportRowInput,
} from '@judging/shared';
import { api, ApiError } from '../../../api/client';
import { Alert, Badge, Button, Card } from '../../../components/ui';
import { useToast } from '../../../components/Toast';
import { readImportFile } from '../../../lib/spreadsheet';

const ACTION_BADGES: Record<
  ImportAction,
  { label: string; tone: 'green' | 'blue' | 'gray' | 'red' }
> = {
  create: { label: 'New', tone: 'green' },
  update: { label: 'Update', tone: 'blue' },
  unchanged: { label: 'No change', tone: 'gray' },
  error: { label: 'Error', tone: 'red' },
};

type Stage =
  | { kind: 'choose' }
  | { kind: 'checking'; fileName: string }
  | { kind: 'file-error'; fileName: string; errors: string[] }
  | {
      kind: 'preview';
      fileName: string;
      rows: ImportRowInput[];
      preview: ImportPreview;
      ignoredColumns: string[];
    }
  | { kind: 'done'; fileName: string; result: ImportCommitResponse };

export function TeamImportPage() {
  const [stage, setStage] = useState<Stage>({ kind: 'choose' });
  const [confirmUpdates, setConfirmUpdates] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const toast = useToast();

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setConfirmUpdates(false);
    setImportError(null);
    setStage({ kind: 'checking', fileName: file.name });
    const parsed = await readImportFile(file);
    if (parsed.fileErrors.length) {
      setStage({ kind: 'file-error', fileName: file.name, errors: parsed.fileErrors });
      return;
    }
    try {
      const preview = await api<ImportPreview>('/api/admin/teams/import/preview', {
        method: 'POST',
        body: { rows: parsed.rows },
      });
      setStage({
        kind: 'preview',
        fileName: file.name,
        rows: parsed.rows,
        preview,
        ignoredColumns: parsed.ignoredColumns,
      });
    } catch (e) {
      setStage({
        kind: 'file-error',
        fileName: file.name,
        errors: [e instanceof Error ? e.message : 'The file could not be checked.'],
      });
    }
  }

  async function runImport() {
    if (stage.kind !== 'preview') return;
    setImporting(true);
    setImportError(null);
    try {
      const result = await api<ImportCommitResponse>('/api/admin/teams/import/commit', {
        method: 'POST',
        body: { rows: stage.rows, confirmUpdates },
      });
      await queryClient.invalidateQueries({ queryKey: ['admin'] });
      setStage({ kind: 'done', fileName: stage.fileName, result });
      toast(`Import complete: ${result.created} created, ${result.updated} updated.`);
    } catch (e) {
      // The data may have changed since the preview: show the server's fresh check.
      const fresh =
        e instanceof ApiError
          ? (e.details as { preview?: ImportPreview } | undefined)?.preview
          : undefined;
      if (fresh) setStage({ ...stage, preview: fresh });
      setImportError(e instanceof Error ? e.message : 'The import failed. Nothing was changed.');
    } finally {
      setImporting(false);
    }
  }

  const rowInput = (rowNumber: number) =>
    stage.kind === 'preview' ? stage.rows.find((r) => r.rowNumber === rowNumber) : undefined;

  return (
    <div className="space-y-6">
      <Link to="/admin/teams" className="text-sm font-semibold text-ischool-blue hover:underline">
        ← Teams
      </Link>
      <div>
        <p className="text-sm font-medium text-ahly-red">Administrator</p>
        <h1 className="text-2xl font-bold sm:text-3xl">Import teams</h1>
        <p className="mt-1 max-w-2xl text-sm text-black/60">
          Add many teams at once from Excel (.xlsx) or CSV. You see a preview first. Nothing is
          saved until you confirm, and the import is all-or-nothing.
        </p>
      </div>

      <Card className="space-y-4">
        <h2 className="font-semibold">1. Download the template</h2>
        <p className="text-sm text-black/65">
          Columns: <strong>Team ID</strong>, <strong>Team Name</strong> and{' '}
          <strong>Project Name</strong>, all required. One team per row. A row whose Team ID already
          exists updates that team, but only after you confirm. Other columns are ignored.
        </p>
        <div className="flex flex-wrap gap-2">
          <a
            href="/templates/teams-import-template.xlsx"
            download
            className="inline-flex items-center rounded-full border border-black/15 bg-white px-4 py-2 text-sm font-semibold hover:bg-black/5 focus-visible:outline-2 focus-visible:outline-ischool-blue"
          >
            Excel template (.xlsx)
          </a>
          <a
            href="/templates/teams-import-template.csv"
            download
            className="inline-flex items-center rounded-full border border-black/15 bg-white px-4 py-2 text-sm font-semibold hover:bg-black/5 focus-visible:outline-2 focus-visible:outline-ischool-blue"
          >
            CSV template
          </a>
        </div>
      </Card>

      <Card className="space-y-4">
        <h2 className="font-semibold">2. Choose your file</h2>
        <input
          ref={fileInput}
          id="import-file"
          type="file"
          accept=".xlsx,.csv"
          className="sr-only"
          onChange={onFile}
          aria-label="Choose a team file (.xlsx or .csv)"
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button
            onClick={() => fileInput.current?.click()}
            disabled={stage.kind === 'checking' || importing}
          >
            {stage.kind === 'choose' ? 'Choose file…' : 'Choose a different file…'}
          </Button>
          {stage.kind !== 'choose' && (
            <span className="text-sm text-black/60">{stage.fileName}</span>
          )}
        </div>
        {stage.kind === 'checking' && (
          <p className="text-sm text-black/60" role="status">
            Checking the file…
          </p>
        )}
        {stage.kind === 'file-error' && (
          <Alert tone="error" title="This file can’t be imported">
            <ul className="list-disc pl-5">
              {stage.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </Alert>
        )}
      </Card>

      {stage.kind === 'preview' && (
        <Card className="space-y-4">
          <h2 className="font-semibold">3. Review and import</h2>
          <div className="flex flex-wrap gap-2" aria-label="Summary">
            <Badge tone="green">{stage.preview.summary.create} new</Badge>
            <Badge tone="blue">{stage.preview.summary.update} to update</Badge>
            <Badge tone="gray">{stage.preview.summary.unchanged} unchanged</Badge>
            <Badge tone="red">{stage.preview.summary.error} with errors</Badge>
          </div>
          {stage.ignoredColumns.length > 0 && (
            <Alert tone="info">These columns are ignored: {stage.ignoredColumns.join(', ')}.</Alert>
          )}
          {stage.preview.summary.error > 0 && (
            <Alert tone="error" title="Fix the rows marked Error, then choose the file again">
              Nothing is imported while any row has an error.
            </Alert>
          )}
          {importError && <Alert tone="error">{importError}</Alert>}

          <div className="max-h-[28rem] overflow-auto rounded-xl border border-black/10">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-surface text-xs tracking-wide text-black/50 uppercase">
                <tr>
                  <th scope="col" className="px-3 py-2">
                    Row
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Team ID
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Team / project
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Result
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Details
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-black/5">
                {stage.preview.rows.map((r) => {
                  const input = rowInput(r.rowNumber);
                  return (
                    <tr key={r.rowNumber} className={r.action === 'error' ? 'bg-red-50/60' : ''}>
                      <td className="px-3 py-2 text-black/50">{r.rowNumber}</td>
                      <td className="px-3 py-2 font-medium">{r.teamCode || '—'}</td>
                      <td className="px-3 py-2">
                        <span className="block">{input?.name || '—'}</span>
                        <span className="block text-xs text-black/55">{input?.projectName}</span>
                      </td>
                      <td className="px-3 py-2">
                        <Badge tone={ACTION_BADGES[r.action].tone}>
                          {ACTION_BADGES[r.action].label}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {r.errors.map((e) => (
                          <p key={e} className="text-ahly-red-dark">
                            {e}
                          </p>
                        ))}
                        {Object.entries(r.changes).map(([field, change]) => (
                          <p key={field}>
                            <span className="font-semibold">{field.replace('_', ' ')}:</span>{' '}
                            {change.from} → {change.to}
                          </p>
                        ))}
                        {r.warnings.map((w) => (
                          <p key={w} className="text-amber-800">
                            {w}
                          </p>
                        ))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {stage.preview.summary.update > 0 && stage.preview.summary.error === 0 && (
            <label className="flex items-start gap-3 rounded-xl bg-blue-50 p-4 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 accent-ahly-red"
                checked={confirmUpdates}
                onChange={(e) => setConfirmUpdates(e.target.checked)}
              />
              <span>
                Update {stage.preview.summary.update} existing team
                {stage.preview.summary.update === 1 ? '' : 's'} with the changes shown above.
              </span>
            </label>
          )}

          <div className="flex justify-end">
            <Button
              onClick={runImport}
              disabled={
                importing ||
                stage.preview.summary.error > 0 ||
                (stage.preview.summary.update > 0 && !confirmUpdates) ||
                stage.preview.summary.create + stage.preview.summary.update === 0
              }
            >
              {importing
                ? 'Importing…'
                : `Import ${stage.preview.summary.create + stage.preview.summary.update} team${stage.preview.summary.create + stage.preview.summary.update === 1 ? '' : 's'}`}
            </Button>
          </div>
        </Card>
      )}

      {stage.kind === 'done' && (
        <Card className="space-y-3">
          <h2 className="text-lg font-semibold">Import complete</h2>
          <ul className="space-y-1 text-sm">
            <li>
              <strong>{stage.result.created}</strong> team{stage.result.created === 1 ? '' : 's'}{' '}
              created
            </li>
            <li>
              <strong>{stage.result.updated}</strong> team{stage.result.updated === 1 ? '' : 's'}{' '}
              updated
            </li>
            <li>
              <strong>{stage.result.unchanged}</strong> unchanged
            </li>
          </ul>
          <Link
            to="/admin/teams"
            className="inline-flex rounded-full bg-ahly-red px-5 py-2.5 text-sm font-semibold text-white hover:bg-ahly-red-dark"
          >
            Go to Teams
          </Link>
        </Card>
      )}
    </div>
  );
}
