import { useMemo, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ROLE_LABELS,
  TEAM_LIMITS,
  type AssignableUser,
  type BulkAssignResponse,
  type TeamInput,
  type TeamSummary,
} from '@judging/shared';
import { api, ApiError } from '../../../api/client';
import { Modal } from '../../../components/Modal';
import { Alert, Badge, Button, TextField } from '../../../components/ui';

function fieldErrors(error: unknown): Record<string, string> {
  if (error instanceof ApiError && error.details && typeof error.details === 'object') {
    return (error.details as { fields?: Record<string, string> }).fields ?? {};
  }
  return {};
}

/** Create or edit a team. */
export function TeamFormDialog({
  team,
  onSubmit,
  onClose,
}: {
  team?: TeamSummary;
  onSubmit: (values: TeamInput) => Promise<void>;
  onClose: () => void;
}) {
  const [teamCode, setTeamCode] = useState(team?.teamCode ?? '');
  const [name, setName] = useState(team?.name ?? '');
  const [projectName, setProjectName] = useState(team?.projectName ?? '');
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const fields = fieldErrors(error);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await onSubmit({
        teamCode: teamCode.trim(),
        name: name.trim(),
        projectName: projectName.trim(),
      });
    } catch (e) {
      setError(e);
      setSaving(false);
    }
  }

  return (
    <Modal
      title={team ? `Edit ${team.name}` : 'Add a team'}
      description={
        team
          ? 'Changes are saved to the database and recorded in the audit log.'
          : 'The Team ID must be unique.'
      }
      onClose={onClose}
      canClose={!saving}
    >
      <form id="team-form" className="space-y-4" onSubmit={submit} noValidate>
        {error instanceof Error && !Object.keys(fields).length ? (
          <Alert tone="error">{error.message}</Alert>
        ) : null}
        <TextField
          label="Team ID"
          value={teamCode}
          onChange={(e) => setTeamCode(e.target.value)}
          maxLength={TEAM_LIMITS.code}
          required
          autoComplete="off"
          error={fields.teamCode}
          hint="For example AHL-001. Letter case is ignored when checking for duplicates."
        />
        <TextField
          label="Team name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={TEAM_LIMITS.name}
          required
          autoComplete="off"
          error={fields.name}
        />
        <TextField
          label="Project name"
          value={projectName}
          onChange={(e) => setProjectName(e.target.value)}
          maxLength={TEAM_LIMITS.project}
          required
          autoComplete="off"
          error={fields.projectName}
        />
      </form>
      <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          type="submit"
          form="team-form"
          disabled={saving || !teamCode.trim() || !name.trim() || !projectName.trim()}
        >
          {saving ? 'Saving…' : team ? 'Save changes' : 'Create team'}
        </Button>
      </div>
    </Modal>
  );
}

/** Archive (with an optional reason) or reactivate a team. */
export function TeamStatusDialog({
  team,
  onConfirm,
  onClose,
}: {
  team: TeamSummary;
  onConfirm: (reason?: string) => Promise<void>;
  onClose: () => void;
}) {
  const archiving = team.status === 'active';
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(archiving ? reason.trim() || undefined : undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
      setBusy(false);
    }
  }

  return (
    <Modal
      title={archiving ? `Archive ${team.name}?` : `Reactivate ${team.name}?`}
      description={
        archiving
          ? 'The team disappears from judges’ lists and can’t receive new assignments. Its assignments and evaluations are kept, and you can reactivate it at any time.'
          : 'The team becomes active again and reappears in its assigned judges’ lists.'
      }
      onClose={onClose}
      canClose={!busy}
      size="sm"
    >
      {error && <Alert tone="error">{error}</Alert>}
      {archiving && (
        <div className="space-y-1.5">
          <label htmlFor="archive-reason" className="block text-sm font-medium">
            Reason (optional)
          </label>
          <textarea
            id="archive-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={TEAM_LIMITS.reason}
            rows={3}
            className="block w-full rounded-xl border border-black/15 px-3.5 py-2.5 text-base shadow-sm outline-none focus:border-ischool-blue focus:ring-4 focus:ring-ischool-blue/15 sm:text-sm"
          />
        </div>
      )}
      <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          type="button"
          variant={archiving ? 'danger' : 'primary'}
          onClick={confirm}
          disabled={busy}
        >
          {busy ? 'Working…' : archiving ? 'Archive team' : 'Reactivate team'}
        </Button>
      </div>
    </Modal>
  );
}

/** Pick judges (and administrators) to assign to one or more teams. */
export function AssignJudgesDialog({
  teams,
  alreadyAssigned = [],
  onAssigned,
  onClose,
}: {
  teams: { id: number; label: string }[];
  alreadyAssigned?: number[];
  onAssigned: (result: BulkAssignResponse) => void;
  onClose: () => void;
}) {
  const users = useQuery({
    queryKey: ['admin', 'assignable-users'],
    queryFn: () => api<{ users: AssignableUser[] }>('/api/admin/assignable-users'),
  });
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const excluded = useMemo(() => new Set(alreadyAssigned), [alreadyAssigned]);

  const visible = (users.data?.users ?? []).filter((u) => {
    if (excluded.has(u.id)) return false;
    const q = search.trim().toLowerCase();
    return !q || u.fullName.toLowerCase().includes(q) || u.email.includes(q);
  });

  function toggle(id: number) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function assign() {
    setBusy(true);
    setError(null);
    try {
      const result = await api<BulkAssignResponse>('/api/admin/assignments/bulk', {
        method: 'POST',
        body: { teamIds: teams.map((t) => t.id), judgeIds: [...selected] },
      });
      onAssigned(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The judges could not be assigned.');
      setBusy(false);
    }
  }

  const target = teams.length === 1 ? teams[0]?.label : `${teams.length} teams`;

  return (
    <Modal
      title={`Assign judges to ${target}`}
      description="Only active accounts are listed. Administrators can evaluate only teams they are assigned to. Judges already assigned are skipped."
      onClose={onClose}
      canClose={!busy}
    >
      {error && <Alert tone="error">{error}</Alert>}
      <div className="space-y-1.5">
        <label htmlFor="judge-search" className="block text-sm font-medium">
          Find a judge
        </label>
        <input
          id="judge-search"
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Name or e-mail"
          className="block w-full rounded-xl border border-black/15 px-3.5 py-2.5 text-base shadow-sm outline-none focus:border-ischool-blue focus:ring-4 focus:ring-ischool-blue/15 sm:text-sm"
        />
      </div>
      {users.isPending ? (
        <p className="py-6 text-center text-sm text-black/60">Loading accounts…</p>
      ) : users.isError ? (
        <Alert tone="error">{users.error.message}</Alert>
      ) : visible.length === 0 ? (
        <p className="py-6 text-center text-sm text-black/60">
          {users.data.users.length === excluded.size
            ? 'Every active account is already assigned.'
            : 'No accounts match.'}
        </p>
      ) : (
        <fieldset className="max-h-72 divide-y divide-black/5 overflow-y-auto rounded-2xl border border-black/10">
          <legend className="sr-only">Judges</legend>
          {visible.map((u) => (
            <label
              key={u.id}
              className="flex cursor-pointer items-center gap-3 px-4 py-3 hover:bg-black/[0.02]"
            >
              <input
                type="checkbox"
                className="h-4 w-4 accent-ischool-blue"
                checked={selected.has(u.id)}
                onChange={() => toggle(u.id)}
              />
              <span className="min-w-0 flex-1">
                <span className="block font-medium">
                  {u.fullName} {u.role === 'admin' && <Badge tone="red">{ROLE_LABELS.admin}</Badge>}
                </span>
                <span className="block text-sm break-all text-muted">{u.email}</span>
              </span>
              <span className="text-xs whitespace-nowrap text-muted">
                {u.assignedTeams} {u.assignedTeams === 1 ? 'team' : 'teams'}
              </span>
            </label>
          ))}
        </fieldset>
      )}
      <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:items-center sm:justify-between">
        <span className="text-sm text-black/60">{selected.size} selected</span>
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={assign} disabled={busy || selected.size === 0}>
            {busy
              ? 'Assigning…'
              : selected.size
                ? `Assign ${selected.size} ${selected.size === 1 ? 'judge' : 'judges'}`
                : 'Assign judges'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function ProgressBar({ submitted, total }: { submitted: number; total: number }) {
  if (total === 0) return <span className="text-sm text-muted">No judges yet</span>;
  const pct = Math.round((submitted / total) * 100);
  return (
    <div className="min-w-[120px]">
      <div className="flex justify-between text-xs text-black/60">
        <span>
          {submitted}/{total} submitted
        </span>
        <span>{pct}%</span>
      </div>
      <div
        className="mt-1 h-1.5 overflow-hidden rounded-full bg-black/10"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={submitted}
        aria-label={`${submitted} of ${total} evaluations submitted`}
      >
        <div
          className={`h-full rounded-full ${pct === 100 ? 'bg-emerald-600' : 'bg-ahly-gold'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
