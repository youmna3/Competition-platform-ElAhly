import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  TEAM_STATUS_LABELS,
  type BulkAssignResponse,
  type TeamDetails,
  type TeamInput,
  type TeamSortField,
  type TeamStatus,
  type TeamSummary,
  type TeamsListResponse,
} from '@judging/shared';
import { api } from '../../../api/client';
import { FullPageSpinner } from '../../../components/FullPageSpinner';
import { useToast } from '../../../components/Toast';
import { Alert, Badge, Button, Card, SelectField } from '../../../components/ui';
import { AssignJudgesDialog, ProgressBar, TeamFormDialog, TeamStatusDialog } from './dialogs';

const PAGE_SIZE = 25;

type DialogState =
  | { kind: 'create' }
  | { kind: 'edit'; team: TeamSummary }
  | { kind: 'status'; team: TeamSummary }
  | { kind: 'assign'; teams: TeamSummary[] }
  | null;

function useDebounced<T>(value: T, ms = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

const COLUMNS: { field: TeamSortField; label: string }[] = [
  { field: 'teamCode', label: 'Team ID' },
  { field: 'name', label: 'Team name' },
  { field: 'projectName', label: 'Project' },
];

export function TeamsPage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'' | TeamStatus>('active');
  const [sort, setSort] = useState<TeamSortField>('teamCode');
  const [dir, setDir] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Map<number, TeamSummary>>(new Map());
  const [dialog, setDialog] = useState<DialogState>(null);
  const debouncedSearch = useDebounced(search.trim());

  // Changing a filter or the sort order goes back to the first page.
  const filterKey = `${debouncedSearch}|${status}|${sort}|${dir}`;
  const [lastFilterKey, setLastFilterKey] = useState(filterKey);
  if (filterKey !== lastFilterKey) {
    setLastFilterKey(filterKey);
    if (page !== 1) setPage(1);
  }

  const params = new URLSearchParams({
    sort,
    dir,
    page: String(page),
    pageSize: String(PAGE_SIZE),
  });
  if (debouncedSearch) params.set('search', debouncedSearch);
  if (status) params.set('status', status);

  const query = useQuery({
    queryKey: ['admin', 'teams', params.toString()],
    queryFn: () => api<TeamsListResponse>(`/api/admin/teams?${params.toString()}`),
    placeholderData: keepPreviousData,
  });

  function sortBy(field: TeamSortField) {
    if (sort === field) setDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSort(field);
      setDir(
        field === 'createdAt' || field === 'assignedJudges' || field === 'progress'
          ? 'desc'
          : 'asc',
      );
    }
  }

  function sortHeader(field: TeamSortField, label: string) {
    const active = sort === field;
    return (
      <th
        key={field}
        scope="col"
        aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
        className="px-3 py-3 font-semibold"
      >
        <button
          type="button"
          onClick={() => sortBy(field)}
          className="inline-flex items-center gap-1 uppercase hover:text-ink focus-visible:outline-2 focus-visible:outline-ischool-blue"
        >
          {label}
          <span aria-hidden className={active ? 'text-ahly-red' : 'text-black/25'}>
            {active ? (dir === 'asc' ? '▲' : '▼') : '↕'}
          </span>
        </button>
      </th>
    );
  }

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ['admin'] });
  }

  async function create(values: TeamInput) {
    const { team } = await api<{ team: TeamDetails }>('/api/admin/teams', {
      method: 'POST',
      body: values,
    });
    setDialog(null);
    await refresh();
    toast(`Team ${team.teamCode} created.`);
  }

  async function edit(team: TeamSummary, values: TeamInput) {
    const body: Partial<TeamInput> = {};
    if (values.teamCode !== team.teamCode) body.teamCode = values.teamCode;
    if (values.name !== team.name) body.name = values.name;
    if (values.projectName !== team.projectName) body.projectName = values.projectName;
    if (Object.keys(body).length === 0) return setDialog(null);
    const { team: updated } = await api<{ team: TeamDetails }>(`/api/admin/teams/${team.id}`, {
      method: 'PATCH',
      body,
    });
    setDialog(null);
    await refresh();
    toast(`Saved changes to ${updated.teamCode}.`);
  }

  async function changeStatus(team: TeamSummary, reason?: string) {
    const archiving = team.status === 'active';
    await api(`/api/admin/teams/${team.id}/${archiving ? 'archive' : 'reactivate'}`, {
      method: 'POST',
      body: archiving ? { reason } : {},
    });
    setDialog(null);
    setSelected((s) => {
      const next = new Map(s);
      next.delete(team.id);
      return next;
    });
    await refresh();
    toast(
      archiving
        ? `Team ${team.teamCode} archived. Its evaluations are kept.`
        : `Team ${team.teamCode} reactivated.`,
    );
  }

  function assigned(result: BulkAssignResponse) {
    setDialog(null);
    setSelected(new Map());
    void refresh();
    toast(
      `Added ${result.added} assignment${result.added === 1 ? '' : 's'}${result.alreadyAssigned ? ` (${result.alreadyAssigned} already existed)` : ''}.`,
    );
  }

  const data = query.data;
  const teams = data?.teams ?? [];
  const selectable = teams.filter((t) => t.status === 'active');
  const allSelected = selectable.length > 0 && selectable.every((t) => selected.has(t.id));
  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  const filtered = Boolean(debouncedSearch || status !== 'active');

  function toggle(team: TeamSummary) {
    setSelected((current) => {
      const next = new Map(current);
      if (next.has(team.id)) next.delete(team.id);
      else next.set(team.id, team);
      return next;
    });
  }

  function toggleAll() {
    setSelected((current) => {
      const next = new Map(current);
      if (allSelected) selectable.forEach((t) => next.delete(t.id));
      else selectable.forEach((t) => next.set(t.id, t));
      return next;
    });
  }

  function RowActions({ team }: { team: TeamSummary }) {
    return (
      <div className="flex flex-wrap gap-1.5">
        <Link
          to={`/admin/teams/${team.id}`}
          className="inline-flex items-center rounded-full border border-black/15 bg-white px-3 py-1.5 text-xs font-semibold hover:bg-black/5 focus-visible:outline-2 focus-visible:outline-ischool-blue"
          aria-label={`View ${team.teamCode}`}
        >
          View
        </Link>
        <Button
          variant="secondary"
          className="!px-3 !py-1.5 text-xs"
          onClick={() => setDialog({ kind: 'edit', team })}
          aria-label={`Edit ${team.teamCode}`}
        >
          Edit
        </Button>
        <Button
          variant="ghost"
          className={`!px-3 !py-1.5 text-xs ${team.status === 'active' ? '!text-ahly-red-dark' : '!text-emerald-700'}`}
          onClick={() => setDialog({ kind: 'status', team })}
          aria-label={`${team.status === 'active' ? 'Archive' : 'Reactivate'} ${team.teamCode}`}
        >
          {team.status === 'active' ? 'Archive' : 'Reactivate'}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-ahly-red">Administrator</p>
          <h1 className="text-2xl font-bold sm:text-3xl">Teams</h1>
          <p className="mt-1 text-sm text-black/60">
            All teams in the iSchool × Al Ahly competition. Teams are archived, never deleted.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            to="/admin/teams/import"
            className="inline-flex items-center rounded-full border border-black/15 bg-white px-5 py-2.5 text-sm font-semibold hover:bg-black/5 focus-visible:outline-2 focus-visible:outline-ischool-blue"
          >
            Import teams
          </Link>
          <Button onClick={() => setDialog({ kind: 'create' })}>+ Add team</Button>
        </div>
      </div>

      <Card className="grid gap-3 !p-4 sm:grid-cols-[1fr_170px]">
        <div className="space-y-1.5">
          <label htmlFor="team-search" className="block text-sm font-medium">
            Search
          </label>
          <input
            id="team-search"
            type="search"
            placeholder="Team ID, team or project name"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            maxLength={100}
            className="block w-full rounded-xl border border-black/15 bg-white px-3.5 py-2.5 text-base shadow-sm outline-none focus:border-ischool-blue focus:ring-4 focus:ring-ischool-blue/15 sm:text-sm"
          />
        </div>
        <SelectField
          label="Status"
          value={status}
          onChange={(e) => setStatus(e.target.value as '' | TeamStatus)}
        >
          <option value="active">Active</option>
          <option value="archived">Archived</option>
          <option value="">All statuses</option>
        </SelectField>
      </Card>

      {selected.size > 0 && (
        <div
          className="sticky top-28 z-20 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-ink px-5 py-3 text-white shadow-lg"
          role="region"
          aria-label="Bulk actions"
        >
          <span className="text-sm font-medium">
            {selected.size} team{selected.size === 1 ? '' : 's'} selected
          </span>
          <div className="flex gap-2">
            <Button
              className="!py-2"
              onClick={() => setDialog({ kind: 'assign', teams: [...selected.values()] })}
            >
              Assign judges
            </Button>
            <Button
              variant="ghost"
              className="!py-2 !text-white hover:!bg-white/10"
              onClick={() => setSelected(new Map())}
            >
              Clear
            </Button>
          </div>
        </div>
      )}

      {query.isPending ? (
        <FullPageSpinner label="Loading teams…" />
      ) : query.isError ? (
        <Alert tone="error" title="Could not load teams">
          {query.error.message}
        </Alert>
      ) : teams.length === 0 ? (
        <Card className="py-12 text-center">
          <p className="text-lg font-semibold">
            {filtered ? 'No teams match these filters' : 'No teams yet'}
          </p>
          <p className="mt-1 text-sm text-black/60">
            {filtered
              ? 'Try another search or change the filters.'
              : 'Add a team, or import them all at once from Excel or CSV.'}
          </p>
        </Card>
      ) : (
        <>
          <p className="text-sm text-black/60" aria-live="polite">
            {data?.total} team{data?.total === 1 ? '' : 's'}
          </p>
          <Card className="hidden overflow-x-auto !p-0 lg:block">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-black/5 text-xs tracking-wide text-black/50">
                <tr>
                  <th scope="col" className="w-10 px-4 py-3">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-ahly-red"
                      checked={allSelected}
                      onChange={toggleAll}
                      aria-label="Select all active teams on this page"
                      disabled={selectable.length === 0}
                    />
                  </th>
                  {COLUMNS.map((c) => sortHeader(c.field, c.label))}
                  <th scope="col" className="px-3 py-3 font-semibold uppercase">
                    Status
                  </th>
                  {sortHeader('assignedJudges', 'Judges')}
                  {sortHeader('progress', 'Progress')}
                  <th scope="col" className="px-4 py-3">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-black/5">
                {teams.map((t) => (
                  <tr
                    key={t.id}
                    className={t.status === 'archived' ? 'bg-black/[0.02] text-black/55' : ''}
                  >
                    <td className="px-4 py-3">
                      {t.status === 'active' && (
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-ahly-red"
                          checked={selected.has(t.id)}
                          onChange={() => toggle(t)}
                          aria-label={`Select ${t.teamCode}`}
                        />
                      )}
                    </td>
                    <td className="px-3 py-3 font-semibold whitespace-nowrap text-ink">
                      <Link to={`/admin/teams/${t.id}`} className="hover:underline">
                        {t.teamCode}
                      </Link>
                    </td>
                    <td className="px-3 py-3">{t.name}</td>
                    <td className="px-3 py-3 text-black/70">{t.projectName}</td>
                    <td className="px-3 py-3">
                      <Badge tone={t.status === 'active' ? 'green' : 'gray'}>
                        {TEAM_STATUS_LABELS[t.status]}
                      </Badge>
                    </td>
                    <td className="px-3 py-3 text-center font-semibold">{t.assignedJudges}</td>
                    <td className="px-3 py-3">
                      <ProgressBar submitted={t.submittedEvaluations} total={t.assignedJudges} />
                    </td>
                    <td className="px-4 py-3">
                      <RowActions team={t} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <ul className="space-y-3 lg:hidden">
            {teams.map((t) => (
              <li key={t.id}>
                <Card className="space-y-3 !p-4">
                  <div className="flex items-start gap-3">
                    {t.status === 'active' && (
                      <input
                        type="checkbox"
                        className="mt-1 h-4 w-4 accent-ahly-red"
                        checked={selected.has(t.id)}
                        onChange={() => toggle(t)}
                        aria-label={`Select ${t.teamCode}`}
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold">
                        {t.teamCode} · {t.name}
                      </p>
                      <p className="text-sm text-black/60">{t.projectName}</p>
                    </div>
                    <Badge tone={t.status === 'active' ? 'green' : 'gray'}>
                      {TEAM_STATUS_LABELS[t.status]}
                    </Badge>
                  </div>
                  <ProgressBar submitted={t.submittedEvaluations} total={t.assignedJudges} />
                  {t.assignedJudges > 0 && (
                    <p className="text-xs text-black/55">
                      {t.assignedJudges} judge{t.assignedJudges === 1 ? '' : 's'} assigned
                    </p>
                  )}
                  <RowActions team={t} />
                </Card>
              </li>
            ))}
          </ul>

          {totalPages > 1 && (
            <div className="flex items-center justify-between">
              <Button
                variant="secondary"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                ← Previous
              </Button>
              <span className="text-sm text-black/60">
                Page {page} of {totalPages}
              </span>
              <Button
                variant="secondary"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next →
              </Button>
            </div>
          )}
        </>
      )}

      {dialog?.kind === 'create' && (
        <TeamFormDialog onSubmit={create} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'edit' && (
        <TeamFormDialog
          team={dialog.team}
          onSubmit={(v) => edit(dialog.team, v)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'status' && (
        <TeamStatusDialog
          team={dialog.team}
          onConfirm={(reason) => changeStatus(dialog.team, reason)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'assign' && (
        <AssignJudgesDialog
          teams={dialog.teams.map((t) => ({ id: t.id, label: t.teamCode }))}
          onAssigned={assigned}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
