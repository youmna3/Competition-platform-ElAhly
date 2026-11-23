import { useState } from 'react';
import { REPORT_KINDS, REPORT_LABELS, type ReportKind } from '@judging/shared';
import { Alert, Button, Card, SelectField, TextField } from '../../../components/ui';
const SHEETS: Record<ReportKind, string[]> = {
  results: ['Competition Results'],
  evaluations: ['Evaluations', 'Sections', 'Criteria'],
  progress: ['Team Progress', 'Judge Workload', 'Archived Team Progress'],
  corrections: ['Corrections', 'Before After Details', 'Immutable Snapshots'],
  rubrics: ['Rubric History', 'Versions'],
};
export function ReportsPage() {
  const [kind, setKind] = useState<ReportKind>('results'),
    [filters, setFilters] = useState<Record<string, string>>({}),
    [sheet, setSheet] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const set = (key: string, value: string) =>
    setFilters((current) => ({ ...current, [key]: value }));
  async function download(format: 'xlsx' | 'csv') {
    setBusy(true);
    setError(null);
    try {
      const query = new URLSearchParams({ format });
      for (const [key, value] of Object.entries(filters))
        if (value)
          query.set(key, key === 'from' || key === 'to' ? new Date(value).toISOString() : value);
      if (format === 'csv') query.set('sheet', sheet || SHEETS[kind][0]!);
      const response = await fetch(`/api/admin/reports/${kind}?${query}`, {
        credentials: 'same-origin',
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error?.message ?? `Export failed (${response.status}).`);
      }
      const url = URL.createObjectURL(await response.blob()),
        link = document.createElement('a');
      link.href = url;
      link.download = `ischool-${kind}-${new Date().toISOString().slice(0, 10)}.${format}`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-6">
      <div>
        <p className="eyebrow">Administrator</p>
        <h1 className="text-2xl font-bold sm:text-3xl">Reports &amp; Exports</h1>
        <p className="mt-1 text-sm text-muted">
          Download server-calculated results and complete evaluation history. Exports include
          generation time and applied filters.
        </p>
      </div>
      {error && (
        <Alert tone="error" title="Could not export report">
          {error}
        </Alert>
      )}
      <Card className="space-y-5">
        <SelectField
          label="Report"
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as ReportKind);
            setFilters({});
            setSheet('');
            setError(null);
          }}
        >
          {REPORT_KINDS.map((k) => (
            <option key={k} value={k}>
              {REPORT_LABELS[k]}
            </option>
          ))}
        </SelectField>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {kind !== 'rubrics' && (
            <>
              <TextField
                label="Team database ID (optional)"
                type="number"
                min="1"
                value={filters.teamId ?? ''}
                onChange={(e) => set('teamId', e.target.value)}
                hint="Numeric record ID from the team page URL."
              />
              <TextField
                label="Judge ID (optional)"
                type="number"
                min="1"
                value={filters.judgeId ?? ''}
                onChange={(e) => set('judgeId', e.target.value)}
              />
            </>
          )}
          {kind !== 'progress' && (
            <TextField
              label="Rubric version (optional)"
              type="number"
              min="1"
              value={filters.version ?? ''}
              onChange={(e) => set('version', e.target.value)}
            />
          )}
          {kind === 'evaluations' && (
            <SelectField
              label="Evaluation status"
              value={filters.status ?? ''}
              onChange={(e) => set('status', e.target.value)}
            >
              <option value="">All</option>
              <option value="draft">Draft / reopened</option>
              <option value="submitted">Submitted</option>
            </SelectField>
          )}
          {(kind === 'evaluations' || kind === 'corrections') && (
            <>
              <TextField
                label={
                  kind === 'corrections'
                    ? 'Corrected from (local time)'
                    : 'Submitted from (local time)'
                }
                type="datetime-local"
                value={filters.from ?? ''}
                onChange={(e) => set('from', e.target.value)}
              />
              <TextField
                label="To (local time)"
                type="datetime-local"
                value={filters.to ?? ''}
                onChange={(e) => set('to', e.target.value)}
              />
            </>
          )}
        </div>
        <p className="text-sm text-muted">
          Blank filters include all matching records. Results filters select teams after official
          rankings are calculated and keep every assigned judge in the team average. Historical and
          unassigned evaluations appear in evaluation/correction reports and never gain ranking
          eligibility.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <Button disabled={busy} onClick={() => void download('xlsx')}>
            {busy ? 'Generating…' : 'Download Excel (.xlsx)'}
          </Button>
          <SelectField
            label="CSV sheet"
            value={sheet || SHEETS[kind][0]}
            onChange={(e) => setSheet(e.target.value)}
          >
            {SHEETS[kind].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </SelectField>
          <Button variant="secondary" disabled={busy} onClick={() => void download('csv')}>
            Download CSV
          </Button>
        </div>
      </Card>
      <Card className="space-y-2">
        <h2 className="text-lg font-bold">Included in {REPORT_LABELS[kind]}</h2>
        <p className="text-sm text-muted">
          Excel sheets: {SHEETS[kind].join(', ')} and Export Metadata. CSV exports one selected
          sheet. Correction snapshots are split into numbered chunks when needed so the full
          original and corrected JSON can be reconstructed.
        </p>
        <p className="text-sm text-muted">
          Large exports ask for narrower filters instead of omitting records. One export is
          generated at a time.
        </p>
      </Card>
    </div>
  );
}
