import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  EVALUATION_PROGRESS_LABELS,
  ROLE_LABELS,
  TEAM_STATUS_LABELS,
  type BulkAssignResponse,
  type EvaluationProgress,
  type TeamAssignment,
  type TeamDetails,
  type TeamInput,
  formatScore,
} from '@judging/shared';
import { api } from '../../../api/client';
import { FullPageSpinner } from '../../../components/FullPageSpinner';
import { useToast } from '../../../components/Toast';
import { Alert, Badge, Button, Card } from '../../../components/ui';
import { ConfirmDialog } from '../users/dialogs';
import { AssignJudgesDialog, ProgressBar, TeamFormDialog, TeamStatusDialog } from './dialogs';

const formatDate = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(value),
      )
    : '—';

const PROGRESS_TONES: Record<EvaluationProgress, 'gray' | 'gold' | 'green'> = {
  not_started: 'gray',
  draft: 'gold',
  submitted: 'green',
};

type DialogState =
  | { kind: 'edit' }
  | { kind: 'status' }
  | { kind: 'assign' }
  | { kind: 'remove'; assignment: TeamAssignment }
  | null;

export function TeamDetailsPage() {
  const { id } = useParams();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [dialog, setDialog] = useState<DialogState>(null);
  const query = useQuery({
    queryKey: ['admin', 'team', id],
    queryFn: () => api<{ team: TeamDetails }>(`/api/admin/teams/${id}`),
    enabled: Boolean(id && /^\d+$/.test(id)),
  });

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ['admin'] });
  }

  if (!id || !/^\d+$/.test(id)) return <Alert tone="error">This team address is not valid.</Alert>;
  if (query.isPending) return <FullPageSpinner label="Loading team…" />;
  if (query.isError) {
    return (
      <div className="space-y-4">
        <Link to="/admin/teams" className="text-sm font-semibold text-ischool-blue hover:underline">
          ← Teams
        </Link>
        <Alert tone="error" title="Could not load this team">
          {query.error.message}
        </Alert>
      </div>
    );
  }

  const team = query.data.team;
  const archived = team.status === 'archived';

  async function edit(values: TeamInput) {
    const body: Partial<TeamInput> = {};
    if (values.teamCode !== team.teamCode) body.teamCode = values.teamCode;
    if (values.name !== team.name) body.name = values.name;
    if (values.projectName !== team.projectName) body.projectName = values.projectName;
    if (Object.keys(body).length) {
      await api(`/api/admin/teams/${team.id}`, { method: 'PATCH', body });
      toast('Team details saved.');
    }
    setDialog(null);
    await refresh();
  }

  async function changeStatus(reason?: string) {
    await api(`/api/admin/teams/${team.id}/${archived ? 'reactivate' : 'archive'}`, {
      method: 'POST',
      body: archived ? {} : { reason },
    });
    setDialog(null);
    await refresh();
    toast(
      archived ? 'Team reactivated.' : 'Team archived. Its assignments and evaluations are kept.',
    );
  }

  async function remove(assignment: TeamAssignment) {
    await api(`/api/admin/teams/${team.id}/judges/${assignment.judgeId}`, { method: 'DELETE' });
    setDialog(null);
    await refresh();
    toast(`${assignment.fullName} was removed from ${team.teamCode}.`);
  }

  function assigned(result: BulkAssignResponse) {
    setDialog(null);
    void refresh();
    toast(`Assigned ${result.added} judge${result.added === 1 ? '' : 's'} to ${team.teamCode}.`);
  }

  return (
    <div className="space-y-6">
      <Link to="/admin/teams" className="text-sm font-semibold text-ischool-blue hover:underline">
        ← Teams
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="neutral">{team.teamCode}</Badge>
            <Badge tone={archived ? 'gray' : 'green'}>{TEAM_STATUS_LABELS[team.status]}</Badge>
          </div>
          <h1 className="mt-2 text-2xl font-bold sm:text-3xl">{team.name}</h1>
          <p className="text-black/60">{team.projectName}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setDialog({ kind: 'edit' })}>
            Edit details
          </Button>
          <Button
            variant={archived ? 'primary' : 'secondary'}
            className={archived ? '' : '!text-ahly-red-dark'}
            onClick={() => setDialog({ kind: 'status' })}
          >
            {archived ? 'Reactivate team' : 'Archive team'}
          </Button>
        </div>
      </div>

      {archived && (
        <Alert tone="warning" title="This team is archived">
          Archived {formatDate(team.archivedAt)}
          {team.archiveReason ? ` — “${team.archiveReason}”` : ''}. Judges don’t see it, and it
          can’t receive new assignments. Its assignments and evaluations are kept.
        </Alert>
      )}

      <Card>
        <dl className="grid gap-4 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs font-semibold tracking-wide text-black/50 uppercase">Team ID</dt>
            <dd className="mt-1 font-medium">{team.teamCode}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold tracking-wide text-black/50 uppercase">Created</dt>
            <dd className="mt-1 font-medium">{formatDate(team.createdAt)}</dd>
            {team.createdByEmail && (
              <dd className="text-xs text-black/50">by {team.createdByEmail}</dd>
            )}
          </div>
          <div>
            <dt className="text-xs font-semibold tracking-wide text-black/50 uppercase">
              Evaluation progress
            </dt>
            <dd className="mt-1">
              <ProgressBar submitted={team.submittedEvaluations} total={team.assignedJudges} />
            </dd>
          </div>
        </dl>
        <dl className="mt-4 grid gap-4 border-t border-black/5 pt-4 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs font-semibold tracking-wide text-black/50 uppercase">
              Provisional average
            </dt>
            <dd className="mt-1 text-lg font-bold tabular-nums">
              {team.provisionalAverage != null ? formatScore(team.provisionalAverage) : '—'}
              {team.provisionalAverage != null && (
                <span className="text-sm font-normal text-black/55"> / 100</span>
              )}
            </dd>
            <dd className="text-xs text-black/50">
              Submitted scores of assigned judges. Not an official result.
            </dd>
          </div>
          <div>
            <dt className="text-xs font-semibold tracking-wide text-black/50 uppercase">
              Results readiness
            </dt>
            <dd className="mt-1">
              {team.readyForResults ? (
                <Badge tone="green">Ready: all judges submitted, one rubric version</Badge>
              ) : (
                <Badge tone="gray">
                  {team.assignedJudges === 0
                    ? 'No judges assigned'
                    : team.submittedEvaluations < team.assignedJudges
                      ? `Waiting for ${team.assignedJudges - team.submittedEvaluations} judge${team.assignedJudges - team.submittedEvaluations === 1 ? '' : 's'}`
                      : 'Rubric versions differ'}
                </Badge>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-semibold tracking-wide text-black/50 uppercase">
              Last update
            </dt>
            <dd className="mt-1 font-medium">{formatDate(team.lastUpdatedAt)}</dd>
          </div>
        </dl>
      </Card>

      {team.mixedVersions && (
        <Alert tone="warning" title="Evaluations use different rubric versions">
          Some judges evaluated this team on an older rubric version, with different weights. Their
          scores are kept as submitted and must not be combined as if they were the same. Review
          them before results are finalised.
        </Alert>
      )}

      <section className="space-y-3" aria-labelledby="assigned-judges">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="assigned-judges" className="text-lg font-semibold">
            Assigned judges <span className="text-black/50">({team.assignments.length})</span>
          </h2>
          <Button
            onClick={() => setDialog({ kind: 'assign' })}
            disabled={archived}
            title={archived ? 'Reactivate the team to assign judges' : undefined}
          >
            + Assign judges
          </Button>
        </div>
        {team.assignments.length === 0 ? (
          <Card className="py-10 text-center">
            <p className="font-semibold">No judges assigned yet</p>
            <p className="mt-1 text-sm text-black/60">
              {archived
                ? 'Reactivate the team to assign judges.'
                : 'Use “Assign judges” to choose who evaluates this team.'}
            </p>
          </Card>
        ) : (
          <Card className="!p-0">
            <ul className="divide-y divide-black/5">
              {team.assignments.map((a) => (
                <li key={a.judgeId} className="flex flex-wrap items-center gap-3 px-5 py-4">
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">
                      {a.fullName}{' '}
                      {a.role === 'admin' && <Badge tone="red">{ROLE_LABELS.admin}</Badge>}{' '}
                      {a.accountStatus === 'disabled' && (
                        <Badge tone="gray">Account disabled</Badge>
                      )}
                    </p>
                    <p className="text-sm break-all text-black/60">{a.email}</p>
                    <p className="text-xs text-black/50">
                      Assigned {formatDate(a.assignedAt)}
                      {a.assignedByEmail ? ` by ${a.assignedByEmail}` : ''}
                    </p>
                  </div>
                  <div className="text-right">
                    <Badge tone={PROGRESS_TONES[a.evaluationStatus]}>
                      {EVALUATION_PROGRESS_LABELS[a.evaluationStatus]}
                    </Badge>
                    {a.outdatedVersion && (
                      <span className="ml-1">
                        <Badge tone="gold">Older rubric v{a.rubricVersionNo}</Badge>
                      </span>
                    )}
                    <p className="mt-1 text-xs text-black/60 tabular-nums">
                      {a.evaluationStatus === 'submitted' && a.totalScore != null
                        ? `Score ${formatScore(a.totalScore)} / 100`
                        : a.evaluationStatus === 'draft'
                          ? `${a.ratedCount}/8 rated`
                          : ''}
                    </p>
                    {a.submittedAt && (
                      <p className="text-xs text-black/50">{formatDate(a.submittedAt)}</p>
                    )}
                    {a.rubricVersionNo != null && a.weights && (
                      <p className="text-xs text-black/50">
                        v{a.rubricVersionNo} · weights {a.weights.join('/')}%
                      </p>
                    )}
                    {a.evaluationId != null && (
                      <Link
                        to={`/admin/evaluations/${a.evaluationId}`}
                        className="text-xs font-semibold text-ischool-blue hover:underline"
                        aria-label={`Review ${a.fullName}’s evaluation`}
                      >
                        Review →
                      </Link>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    className="!px-3 !py-1.5 text-xs !text-ahly-red-dark"
                    onClick={() => setDialog({ kind: 'remove', assignment: a })}
                    aria-label={`Remove ${a.fullName} from this team`}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </section>

      {team.pastEvaluations.length > 0 && (
        <section className="space-y-3" aria-labelledby="past-evaluations">
          <h2 id="past-evaluations" className="text-lg font-semibold">
            Evaluations by judges no longer assigned
          </h2>
          <p className="text-sm text-black/60">
            Kept for the record. They don’t count toward this team’s progress.
          </p>
          <Card className="!p-0">
            <ul className="divide-y divide-black/5">
              {team.pastEvaluations.map((p) => (
                <li
                  key={p.judgeId}
                  className="flex flex-wrap items-center justify-between gap-3 px-5 py-3"
                >
                  <div>
                    <p className="font-medium">{p.fullName}</p>
                    <p className="text-sm text-black/60">{p.email}</p>
                  </div>
                  <div className="text-right">
                    <Badge tone={PROGRESS_TONES[p.evaluationStatus]}>
                      {EVALUATION_PROGRESS_LABELS[p.evaluationStatus]}
                    </Badge>
                    <p className="mt-1 text-xs text-black/60">
                      Rubric v{p.rubricVersionNo}
                      {p.totalScore != null && ` · score ${formatScore(p.totalScore)} / 100`}
                    </p>
                    <Link
                      to={`/admin/evaluations/${p.evaluationId}`}
                      className="text-xs font-semibold text-ischool-blue hover:underline"
                      aria-label={`Review ${p.fullName}’s evaluation`}
                    >
                      Review →
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      )}

      {dialog?.kind === 'edit' && (
        <TeamFormDialog team={team} onSubmit={edit} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'status' && (
        <TeamStatusDialog team={team} onConfirm={changeStatus} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'assign' && (
        <AssignJudgesDialog
          teams={[{ id: team.id, label: team.teamCode }]}
          alreadyAssigned={team.assignments.map((a) => a.judgeId)}
          onAssigned={assigned}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'remove' && (
        <ConfirmDialog
          title={`Remove ${dialog.assignment.fullName} from ${team.teamCode}?`}
          message={
            dialog.assignment.evaluationStatus === 'not_started'
              ? 'They will no longer see this team.'
              : 'They will no longer see this team. Their evaluation is kept in the database but will no longer count toward this team’s results.'
          }
          confirmLabel="Remove judge"
          danger
          onConfirm={() => remove(dialog.assignment)}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
