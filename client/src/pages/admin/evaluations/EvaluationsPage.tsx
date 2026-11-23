import { useCompetition } from '../../../components/CompetitionNotice';
import { useEffect, useState, type ReactNode } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, NavLink, useSearchParams } from 'react-router';
import {
  COMPETITION_LABELS,
  EVALUATION_PROGRESS_LABELS,
  TEAM_COMPLETION_LABELS,
  formatScore,
  type AdminEvaluationJudge,
  type AdminEvaluationsResponse,
  type AdminTeamEvaluations,
  type EvaluationProgress,
} from '@judging/shared';
import { api } from '../../../api/client';
import { FullPageSpinner } from '../../../components/FullPageSpinner';
import { Alert, Badge, Button, Card, SelectField } from '../../../components/ui';
import { HistoricalSubmissions } from './HistoricalSubmissions';

export const PROGRESS_TONES: Record<EvaluationProgress, 'gray' | 'gold' | 'green'> = {
  not_started: 'gray',
  draft: 'gold',
  submitted: 'green',
};

export const formatDateTime = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(value),
      )
    : '—';

/** Header shared by the two evaluation views. */
export function EvaluationsHeader({ children }: { children?: ReactNode }) {
  const tab = ({ isActive }: { isActive: boolean }) =>
    `inline-flex min-h-11 items-center rounded-xl px-4 py-2 text-sm font-semibold transition ${isActive ? 'bg-ischool-blue text-white' : 'text-muted hover:bg-ischool-blue-soft'}`;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">Administrator</p>
          <h1 className="text-2xl font-bold sm:text-3xl">Evaluations</h1>
          <p className="mt-1 max-w-2xl text-sm text-black/60">
            Review every judge’s evaluation and track progress. Averages here are provisional;
            official results are available on the Leaderboard.
          </p>
        </div>
        {children}
      </div>
      <nav aria-label="Evaluation views" className="flex gap-1">
        <NavLink to="/admin/evaluations" end className={tab}>
          By team
        </NavLink>
        <NavLink to="/admin/evaluations/progress" className={tab}>
          Judge progress
        </NavLink>
      </nav>
    </div>
  );
}

function JudgeLine({ j, teamId }: { j: AdminEvaluationJudge; teamId: number }) {
  const lifecycle = useCompetition();
  const canCorrect = lifecycle.data?.state === 'judging_open';
  const label = (
    <>
      <span className="font-medium">{j.fullName}</span>
      {j.role === 'admin' && <span className="text-xs text-muted"> (admin)</span>}
    </>
  );
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      {j.evaluationId ? (
        <Link
          to={`/admin/evaluations/${j.evaluationId}`}
          className="hover:underline"
          aria-label={`Review ${j.fullName}’s evaluation`}
        >
          {label}
        </Link>
      ) : (
        <span>{label}</span>
      )}
      <Badge tone={PROGRESS_TONES[j.status]}>{EVALUATION_PROGRESS_LABELS[j.status]}</Badge>
      <span className="text-black/60 tabular-nums">
        {j.status === 'submitted' && j.totalScore != null
          ? formatScore(j.totalScore)
          : j.status === 'draft'
            ? `${j.ratedCount}/${j.requiredCount || '?'} rated`
            : ''}
      </span>
      {j.rubricVersionNo != null && (
        <span className="text-xs text-muted">v{j.rubricVersionNo}</span>
      )}
      {j.reopenedCount > 0 && <Badge tone="red">Reopened ×{j.reopenedCount}</Badge>}
      {j.accountStatus === 'disabled' && <Badge tone="gray">Disabled</Badge>}
      {canCorrect && j.status === 'submitted' && j.evaluationId != null && (
        <Link
          to={`/admin/evaluations/${j.evaluationId}?edit=1&teamId=${teamId}`}
          className="action-link !min-h-9 !px-3 !py-1.5 !text-xs"
          aria-label={`Edit Submission — ${j.fullName}`}
        >
          Edit Submission
        </Link>
      )}
    </li>
  );
}

function TeamEvaluations({ team, onBack }: { team: AdminTeamEvaluations; onBack: () => void }) {
  const lifecycle = useCompetition();
  const correctionsClosed = !!lifecycle.data && lifecycle.data.state !== 'judging_open';
  return (
    <section className="space-y-4" aria-label={`Evaluations for ${team.name}`}>
      <Card className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="eyebrow">{team.teamCode}</p>
            <h2 className="mt-1 text-xl font-bold">{team.name}</h2>
            <p className="mt-1 text-sm text-muted">{team.projectName}</p>
          </div>
          <Button variant="secondary" onClick={onBack}>
            All teams
          </Button>
        </div>
        <TeamFlags t={team} />
        <p className="text-sm">
          {team.submitted} of {team.assignedJudges} assigned judge
          {team.assignedJudges === 1 ? '' : 's'} submitted · Team average:{' '}
          <strong>
            {team.provisionalAverage == null ? '—' : formatScore(team.provisionalAverage)}
          </strong>
        </p>
        {correctionsClosed ? (
          <Alert tone="info" title="Corrections are available only while judging is open">
            The competition is currently{' '}
            <strong>{COMPETITION_LABELS[lifecycle.data!.state]}</strong>, so Edit Submission is
            hidden.{' '}
            <Link to="/admin/settings" className="font-semibold text-ischool-blue-dark underline">
              Go to Settings
            </Link>
          </Alert>
        ) : (
          <p className="text-sm text-muted">
            Review each judge separately. Edit Submission corrects that judge’s submitted ratings
            and notes, with a reason and confirmation.
          </p>
        )}
      </Card>
      {team.judges.length ? (
        <ul className="grid gap-4 xl:grid-cols-3">
          {team.judges.map((judge) => (
            <li key={judge.judgeId}>
              <Card className="h-full">
                <ul>
                  <JudgeLine j={judge} teamId={team.teamId} />
                </ul>
              </Card>
            </li>
          ))}
        </ul>
      ) : (
        <Card>No judges assigned to this team.</Card>
      )}
    </section>
  );
}

function TeamFlags({ t }: { t: AdminTeamEvaluations }) {
  return (
    <div className="flex flex-wrap gap-1">
      <Badge
        tone={
          t.completion === 'complete' ? 'green' : t.completion === 'in_progress' ? 'gold' : 'gray'
        }
      >
        {TEAM_COMPLETION_LABELS[t.completion]}
      </Badge>
      {t.mixedVersions && <Badge tone="red">Mixed rubric versions</Badge>}
      {t.readyForResults && <Badge tone="blue">Ready for results</Badge>}
      {t.teamStatus === 'archived' && <Badge tone="gray">Archived</Badge>}
    </div>
  );
}

const SORTS = {
  teamCode: 'Team ID',
  name: 'Team name',
  submitted: 'Submitted',
  pending: 'Pending',
  average: 'Provisional average',
  lastSubmitted: 'Last submission',
} as const;

export function EvaluationsPage() {
  const [params, setParams] = useSearchParams();
  const get = (key: string, fallback = '') => params.get(key) ?? fallback;
  const [search, setSearch] = useState(get('search'));
  const page = Number(get('page', '1')) || 1;

  // Debounce typing into the search box.
  useEffect(() => {
    const t = setTimeout(() => {
      if (search !== get('search')) update({ search });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  function update(patch: Record<string, string>) {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    if (!('page' in patch)) next.delete('page');
    setParams(next, { replace: true });
  }

  const query = new URLSearchParams();
  for (const key of [
    'search',
    'teamId',
    'judgeId',
    'status',
    'version',
    'completion',
    'sort',
    'dir',
  ]) {
    if (get(key)) query.set(key, get(key));
  }
  query.set('teamStatus', get('teamStatus', 'active'));
  query.set('page', String(page));
  query.set('pageSize', '20');
  const list = useQuery({
    queryKey: ['admin', 'evaluations', query.toString()],
    queryFn: () => api<AdminEvaluationsResponse>(`/api/admin/evaluations?${query}`),
    placeholderData: keepPreviousData,
  });
  const data = list.data;
  const selectedTeam = data?.teams.find((team) => team.teamId === Number(get('teamId')));
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const filtered = ['search', 'teamId', 'judgeId', 'status', 'version', 'completion'].some((k) =>
    get(k),
  );

  return (
    <div className="space-y-6">
      <EvaluationsHeader>
        <Button variant="secondary" disabled={list.isFetching} onClick={() => void list.refetch()}>
          {list.isFetching ? 'Refreshing…' : 'Refresh'}
        </Button>
      </EvaluationsHeader>
      <HistoricalSubmissions />

      <Card className="grid gap-3 !p-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1.5 sm:col-span-2">
          <label htmlFor="evaluation-search" className="block text-sm font-medium">
            Search
          </label>
          <input
            id="evaluation-search"
            type="search"
            value={search}
            maxLength={100}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Team ID, team, project or judge"
            className="block w-full rounded-xl border border-black/15 bg-white px-3.5 py-2.5 text-base shadow-sm outline-none focus:border-ischool-blue focus:ring-4 focus:ring-ischool-blue/15 sm:text-sm"
          />
        </div>
        <SelectField
          label="Judge"
          value={get('judgeId')}
          onChange={(e) => update({ judgeId: e.target.value })}
        >
          <option value="">All judges</option>
          {data?.judges.map((j) => (
            <option key={j.id} value={j.id}>
              {j.fullName}
              {j.role === 'admin' ? ' (admin)' : ''}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Evaluation status"
          value={get('status')}
          onChange={(e) => update({ status: e.target.value })}
        >
          <option value="">Any status</option>
          <option value="not_started">Not started</option>
          <option value="draft">Draft</option>
          <option value="submitted">Submitted</option>
        </SelectField>
        <SelectField
          label="Team completion"
          value={get('completion')}
          onChange={(e) => update({ completion: e.target.value })}
        >
          <option value="">Any</option>
          <option value="complete">All judges submitted</option>
          <option value="incomplete">Still pending</option>
          <option value="not_started">Not started</option>
          <option value="no_judges">No judges assigned</option>
          <option value="mixed_versions">Mixed rubric versions</option>
          <option value="ready">Ready for results</option>
        </SelectField>
        <SelectField
          label="Rubric version"
          value={get('version')}
          onChange={(e) => update({ version: e.target.value })}
        >
          <option value="">Any version</option>
          {data?.versionsInUse.map((v) => (
            <option key={v} value={v}>
              Version {v}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Teams"
          value={get('teamStatus', 'active')}
          onChange={(e) => update({ teamStatus: e.target.value })}
        >
          <option value="active">Active teams</option>
          <option value="archived">Archived teams</option>
          <option value="all">All teams</option>
        </SelectField>
        <SelectField
          label="Sort by"
          value={`${get('sort', 'teamCode')}:${get('dir', 'asc')}`}
          onChange={(e) => {
            const [sort, dir] = e.target.value.split(':');
            update({ sort: sort!, dir: dir! });
          }}
        >
          {Object.entries(SORTS).map(([key, label]) => (
            <optgroup key={key} label={label}>
              <option value={`${key}:asc`}>{label} ↑</option>
              <option value={`${key}:desc`}>{label} ↓</option>
            </optgroup>
          ))}
        </SelectField>
      </Card>

      {list.isPending ? (
        <FullPageSpinner label="Loading evaluations…" />
      ) : list.isError ? (
        <Alert tone="error" title="Could not load evaluations">
          {list.error.message}
        </Alert>
      ) : data!.teams.length === 0 ? (
        <Card className="py-12 text-center">
          <p className="text-lg font-semibold">
            {filtered ? 'No teams match these filters' : 'No teams yet'}
          </p>
          <p className="mt-1 text-sm text-black/60">
            {filtered ? 'Try clearing a filter.' : 'Add teams and assign judges on the Teams page.'}
          </p>
        </Card>
      ) : (
        <>
          <p className="text-sm text-black/60" role="status">
            {data!.total} team{data!.total === 1 ? '' : 's'}
          </p>
          {get('teamId') ? (
            selectedTeam && !list.isPlaceholderData ? (
              <TeamEvaluations team={selectedTeam} onBack={() => update({ teamId: '' })} />
            ) : (
              <FullPageSpinner label="Loading team evaluations…" />
            )
          ) : (
            <>
              <Card className="hidden overflow-x-auto !p-0 lg:block">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-black/5 text-xs tracking-wide text-muted uppercase">
                    <tr>
                      <th scope="col" className="px-5 py-3 font-semibold">
                        Team
                      </th>
                      <th scope="col" className="px-3 py-3 font-semibold">
                        Judges
                      </th>
                      <th scope="col" className="px-3 py-3 font-semibold">
                        Submitted
                      </th>
                      <th scope="col" className="px-3 py-3 font-semibold">
                        Provisional average
                      </th>
                      <th scope="col" className="px-3 py-3 font-semibold">
                        Rubric
                      </th>
                      <th scope="col" className="px-5 py-3 font-semibold">
                        Last submission
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-black/5 align-top">
                    {data!.teams.map((t) => (
                      <tr key={t.teamId}>
                        <td className="px-5 py-3">
                          <Link
                            to={`/admin/evaluations?teamId=${t.teamId}`}
                            className="font-semibold hover:underline"
                          >
                            {t.teamCode} · {t.name}
                          </Link>
                          <p className="text-black/60">{t.projectName}</p>
                          <div className="mt-1.5">
                            <TeamFlags t={t} />
                          </div>
                          <Button
                            variant="secondary"
                            className="mt-3 !min-h-9 !px-3 !py-1.5 !text-xs"
                            onClick={() => update({ teamId: String(t.teamId) })}
                            aria-label={`View evaluations for ${t.name}`}
                          >
                            View evaluations
                          </Button>
                        </td>
                        <td className="px-3 py-3">
                          {t.judges.length ? (
                            <ul className="space-y-1.5">
                              {t.judges.map((j) => (
                                <JudgeLine key={j.judgeId} j={j} teamId={t.teamId} />
                              ))}
                            </ul>
                          ) : (
                            <span className="text-muted">No judges assigned</span>
                          )}
                        </td>
                        <td className="px-3 py-3 whitespace-nowrap tabular-nums">
                          <strong>{t.submitted}</strong> / {t.assignedJudges}
                          {t.pending > 0 && (
                            <p className="text-xs text-muted">{t.pending} pending</p>
                          )}
                        </td>
                        <td className="px-3 py-3 tabular-nums">
                          {t.provisionalAverage != null ? (
                            <>
                              <strong>{formatScore(t.provisionalAverage)}</strong>
                              {t.mixedVersions && (
                                <p className="text-xs text-ahly-red-dark">not comparable</p>
                              )}
                            </>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="px-3 py-3 whitespace-nowrap">
                          {t.versions.length ? t.versions.map((v) => `v${v}`).join(', ') : '—'}
                        </td>
                        <td className="px-5 py-3 whitespace-nowrap text-black/65">
                          {formatDateTime(t.lastSubmittedAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
              <ul className="space-y-3 lg:hidden">
                {data!.teams.map((t) => (
                  <li key={t.teamId}>
                    <Card className="space-y-3 !p-4">
                      <div>
                        <Link
                          to={`/admin/evaluations?teamId=${t.teamId}`}
                          className="font-semibold hover:underline"
                        >
                          {t.teamCode} · {t.name}
                        </Link>
                        <p className="text-sm text-black/60">{t.projectName}</p>
                      </div>
                      <TeamFlags t={t} />
                      <Button
                        variant="secondary"
                        onClick={() => update({ teamId: String(t.teamId) })}
                        aria-label={`View evaluations for ${t.name}`}
                      >
                        View evaluations
                      </Button>
                      <p className="text-sm tabular-nums">
                        <strong>{t.submitted}</strong>/{t.assignedJudges} submitted
                        {t.provisionalAverage != null && (
                          <> · average {formatScore(t.provisionalAverage)}</>
                        )}
                        {t.versions.length > 0 && (
                          <> · {t.versions.map((v) => `v${v}`).join(', ')}</>
                        )}
                      </p>
                      {t.judges.length > 0 && (
                        <ul className="space-y-1.5 border-t border-black/5 pt-2">
                          {t.judges.map((j) => (
                            <JudgeLine key={j.judgeId} j={j} teamId={t.teamId} />
                          ))}
                        </ul>
                      )}
                    </Card>
                  </li>
                ))}
              </ul>
            </>
          )}
          {totalPages > 1 && (
            <div className="flex items-center justify-between">
              <Button
                variant="secondary"
                disabled={page <= 1}
                onClick={() => update({ page: String(page - 1) })}
              >
                ← Previous
              </Button>
              <span className="text-sm text-black/60">
                Page {page} of {totalPages}
              </span>
              <Button
                variant="secondary"
                disabled={page >= totalPages}
                onClick={() => update({ page: String(page + 1) })}
              >
                Next →
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
