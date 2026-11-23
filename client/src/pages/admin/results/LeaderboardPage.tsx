import { TopTeams } from '../../../components/TopTeams';
import { HeroStats, RankChip, ResultsHero } from '../../../components/Results';
import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import {
  TEAM_RESULT_STATUS_LABELS,
  formatScore,
  type RankedTeam,
  type ResultsResponse,
  type ResultsSort,
  type TeamResult,
} from '@judging/shared';
import { api } from '../../../api/client';
import { FullPageSpinner } from '../../../components/FullPageSpinner';
import { Alert, Badge, Card, SelectField } from '../../../components/ui';
import { RESULT_STATUS_TONES, RESULTS_POLL_MS, formatTime } from './model';

const SORTABLE: { field: ResultsSort; label: string }[] = [
  { field: 'rank', label: 'Rank' },
  { field: 'teamCode', label: 'Team ID' },
  { field: 'name', label: 'Team' },
  { field: 'projectName', label: 'Project' },
  { field: 'judges', label: 'Judges' },
  { field: 'submitted', label: 'Submitted' },
];

const isTied = (team: RankedTeam, all: RankedTeam[]) =>
  all.some((t) => t.teamId !== team.teamId && t.rank === team.rank);

function StatusBadge({ team }: { team: TeamResult }) {
  return (
    <Badge tone={RESULT_STATUS_TONES[team.status]}>{TEAM_RESULT_STATUS_LABELS[team.status]}</Badge>
  );
}

function JudgeList({ team }: { team: TeamResult }) {
  return (
    <ul className="space-y-0.5 text-xs text-black/60">
      {team.judges.map((j) => (
        <li key={j.judgeId}>
          {j.fullName}
          {j.role === 'admin' ? ' (admin)' : ''}
          {j.accountStatus !== 'active' ? ' · disabled' : ''}:{' '}
          <span className="tabular-nums">
            {j.status === 'submitted' && j.score != null
              ? formatScore(j.score)
              : j.reopened
                ? 'reopened'
                : j.status === 'draft'
                  ? 'draft'
                  : 'not started'}
          </span>
        </li>
      ))}
    </ul>
  );
}

function RankedTable({
  teams,
  caption,
  provisional = false,
  sort,
  dir,
  onSort,
}: {
  teams: RankedTeam[];
  caption: string;
  provisional?: boolean;
  sort: ResultsSort;
  dir: 'asc' | 'desc';
  onSort: (field: ResultsSort) => void;
}) {
  const header = (field: ResultsSort, label: string) => (
    <th
      key={field}
      scope="col"
      aria-sort={sort === field ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      className="px-4 py-3"
    >
      <button
        type="button"
        onClick={() => onSort(field)}
        aria-label={`Sort by ${label}`}
        className="inline-flex items-center gap-1 font-semibold hover:text-ischool-blue-dark"
      >
        {label}
        <span aria-hidden="true" className="text-black/35">
          {sort === field ? (dir === 'asc' ? '▲' : '▼') : '↕'}
        </span>
      </button>
    </th>
  );
  return (
    <>
      <Card className="hidden overflow-x-auto !p-0 md:block">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead className="border-b border-black/10 text-xs uppercase tracking-wide text-muted">
            <tr>
              {SORTABLE.map((s) => header(s.field, s.label))}
              <th scope="col" className="px-4 py-3 text-right">
                {provisional ? 'Provisional combined average' : 'Combined final average'}
              </th>
              <th scope="col" className="px-4 py-3">
                Status
              </th>
            </tr>
          </thead>
          <tbody>
            {teams.map((t) => (
              <tr
                key={t.teamId}
                className={`border-b border-black/5 last:border-0 ${
                  !provisional && t.rank <= 3 ? 'bg-ischool-blue-soft/60' : ''
                }`}
              >
                <td className="px-4 py-3">
                  <RankChip rank={t.rank} tied={isTied(t, teams)} />
                </td>
                <td className="px-4 py-3 font-mono text-xs">{t.teamCode}</td>
                <td className="px-4 py-3 font-semibold">
                  <Link to={`/admin/teams/${t.teamId}`} className="hover:underline">
                    {t.name}
                  </Link>
                </td>
                <td className="px-4 py-3 text-black/70">{t.projectName}</td>
                <td className="px-4 py-3">
                  <JudgeList team={t} />
                </td>
                <td className="px-4 py-3 tabular-nums">
                  {t.submitted}/{t.assignedJudges}
                </td>
                <td className="px-4 py-3 text-right text-lg font-bold tabular-nums">
                  <span className="text-ischool-blue-dark">{formatScore(t.score)}</span>{' '}
                  <span className="text-sm font-medium text-muted">/ {t.maximumScore ?? 100}</span>
                  {(t.bonusAverage ?? 0) > 0 && (
                    <span className="block text-xs font-normal text-muted">
                      Base {formatScore(t.baseAverage ?? t.score)} · Bonus +{' '}
                      {formatScore(t.bonusAverage ?? 0)}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-col items-start gap-1">
                    <StatusBadge team={t} />
                    <span className="text-xs text-muted">Rubric v{t.rubricVersionNo}</span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <ul className="space-y-3 md:hidden" aria-label={caption}>
        {teams.map((t) => (
          <li key={t.teamId}>
            <Card
              className={`!p-4 ${!provisional && t.rank <= 3 ? 'ring-2 ring-ischool-blue/30' : ''}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 gap-3">
                  <RankChip rank={t.rank} />
                  <div className="min-w-0">
                    <p className="text-xs text-muted">
                      {isTied(t, teams) ? 'Tied · ' : ''}
                      {t.teamCode}
                    </p>
                    <p className="font-semibold">{t.name}</p>
                    <p className="text-sm text-black/60">{t.projectName}</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-2xl font-bold text-ischool-blue-dark tabular-nums">
                    {formatScore(t.score)}{' '}
                    <span className="text-sm font-medium text-muted">
                      / {t.maximumScore ?? 100}
                    </span>
                  </p>
                  {(t.bonusAverage ?? 0) > 0 && (
                    <p className="text-xs text-muted">
                      Base {formatScore(t.baseAverage ?? t.score)} · Bonus +
                      {formatScore(t.bonusAverage ?? 0)}
                    </p>
                  )}
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-black/60">
                <StatusBadge team={t} />
                <span>
                  {t.submitted}/{t.assignedJudges} submitted · rubric v{t.rubricVersionNo}
                </span>
              </div>
              <div className="mt-2">
                <JudgeList team={t} />
              </div>
            </Card>
          </li>
        ))}
      </ul>
    </>
  );
}

function NotRankedList({ teams }: { teams: TeamResult[] }) {
  return (
    <ul className="grid gap-3 lg:grid-cols-2">
      {teams.map((t) => (
        <li key={t.teamId}>
          <Card className="h-full !p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-mono text-xs text-muted">{t.teamCode}</p>
                <Link to={`/admin/teams/${t.teamId}`} className="font-semibold hover:underline">
                  {t.name}
                </Link>
                <p className="text-sm text-black/60">{t.projectName}</p>
              </div>
              <div className="text-right">
                <StatusBadge team={t} />
                <p className="mt-1 text-xs text-muted tabular-nums">
                  {t.submitted}/{t.assignedJudges} submitted
                </p>
              </div>
            </div>
            <p className="mt-3 text-sm">
              <span className="text-muted">Provisional average (not official): </span>
              <span className="font-semibold tabular-nums">
                {t.provisionalAverage == null ? '—' : formatScore(t.provisionalAverage)}
              </span>
              {t.versions.length > 0 && (
                <span className="text-muted">
                  {' '}
                  · rubric {t.versions.map((v) => `v${v}`).join(', ')}
                </span>
              )}
            </p>
            <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm text-black/70">
              {t.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </Card>
        </li>
      ))}
    </ul>
  );
}

export function LeaderboardPage() {
  const [params, setParams] = useSearchParams();
  const sort = (params.get('sort') as ResultsSort | null) ?? 'rank';
  const dir = params.get('dir') === 'desc' ? 'desc' : 'asc';
  const [search, setSearch] = useState(params.get('search') ?? '');

  function update(patch: Record<string, string>) {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  }

  useEffect(() => {
    const t = setTimeout(() => {
      if (search !== (params.get('search') ?? '')) update({ search });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const onSort = (field: ResultsSort) =>
    update({ sort: field, dir: sort === field && dir === 'asc' ? 'desc' : 'asc' });

  const query = new URLSearchParams();
  for (const key of ['search', 'sort', 'dir']) {
    const value = params.get(key);
    if (value) query.set(key, value);
  }
  const results = useQuery({
    queryKey: ['admin', 'results', query.toString()],
    queryFn: () => api<ResultsResponse>(`/api/admin/results?${query}`),
    placeholderData: keepPreviousData,
    refetchInterval: RESULTS_POLL_MS,
  });
  const data = results.data;
  const searching = Boolean(params.get('search'));

  return (
    <div className="space-y-6">
      <ResultsHero
        eyebrow="Detailed results · administrators only · not public"
        title="Leaderboard"
        description="A team’s final score is the average of the submitted scores of every judge currently assigned to it. Teams are ranked only when all of their judges have submitted. Equal scores share a rank."
        updatedAt={data ? formatTime(data.computedAt) : null}
        refreshing={results.isFetching}
        onRefresh={() => void results.refetch()}
      >
        {data && data.totals.activeTeams > 0 && (
          <HeroStats
            items={[
              ['Ready for results', data.totals.ready],
              ['In progress', data.totals.inProgress],
              ['Not started', data.totals.notStarted],
              ['Blocked', data.totals.blocked],
              ['Unassigned', data.totals.unassigned],
            ]}
          />
        )}
      </ResultsHero>

      <Card className="flex flex-wrap items-end gap-3 !p-4">
        <div className="w-full max-w-md flex-1 space-y-1.5">
          <label htmlFor="results-search" className="block text-sm font-medium">
            Search
          </label>
          <input
            id="results-search"
            type="search"
            value={search}
            maxLength={100}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Team ID, team, project or judge"
            className="block w-full rounded-xl border border-black/15 bg-white px-3.5 py-2.5 text-base shadow-sm outline-none focus:border-ischool-blue focus:ring-4 focus:ring-ischool-blue/15 sm:text-sm"
          />
        </div>
        <div className="md:hidden">
          <SelectField
            label="Sort by"
            value={`${sort}:${dir}`}
            onChange={(e) => {
              const [field, direction] = e.target.value.split(':');
              update({ sort: field!, dir: direction! });
            }}
          >
            {SORTABLE.flatMap((s) => [
              <option key={`${s.field}:asc`} value={`${s.field}:asc`}>
                {s.label} (ascending)
              </option>,
              <option key={`${s.field}:desc`} value={`${s.field}:desc`}>
                {s.label} (descending)
              </option>,
            ])}
          </SelectField>
        </div>
      </Card>

      {results.isPending ? (
        <FullPageSpinner label="Calculating results…" />
      ) : results.isError ? (
        <Alert tone="error" title="Could not load the results">
          {results.error.message}
        </Alert>
      ) : data!.totals.activeTeams === 0 ? (
        <Card className="text-center">
          <p className="font-semibold">No active teams yet</p>
          <p className="mt-1 text-sm text-black/60">
            Add teams and assign judges on the{' '}
            <Link
              to="/admin/teams"
              className="font-semibold text-ischool-blue-dark hover:underline"
            >
              Teams
            </Link>{' '}
            page. Results appear here as judges submit.
          </p>
        </Card>
      ) : (
        <>
          {data!.versionWarnings.map((w) => (
            <Alert key={w} tone="warning" title="Rubric versions">
              {w}
            </Alert>
          ))}

          {data!.official.available && <TopTeams teams={data!.official.teams} />}
          <section className="space-y-3" aria-labelledby="official-heading">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="official-heading" className="text-lg font-bold">
                Official ranking
              </h2>
              {data!.official.rubricVersionNo != null && (
                <span className="text-sm text-muted">
                  All scores on rubric v{data!.official.rubricVersionNo}
                </span>
              )}
            </div>
            {!data!.official.available ? (
              <Alert tone="warning" title="No official ranking yet">
                {data!.official.unavailableReason}
              </Alert>
            ) : data!.official.teams.length === 0 ? (
              <Card className="text-sm text-black/60">No ranked team matches your search.</Card>
            ) : (
              <RankedTable
                teams={data!.official.teams}
                caption="Official ranking"
                sort={sort}
                dir={dir}
                onSort={onSort}
              />
            )}
          </section>

          {data!.provisional.length > 0 && (
            <section className="space-y-4" aria-labelledby="provisional-heading">
              <div>
                <h2 id="provisional-heading" className="text-lg font-bold">
                  Provisional comparison by rubric version
                </h2>
                <p className="text-sm text-black/60">
                  Not official. Each group is ranked only against teams scored with the same rubric
                  version. Scores are never converted between versions.
                </p>
              </div>
              {data!.provisional.map((g) => (
                <div key={g.rubricVersionNo} className="space-y-2">
                  <h3 className="font-semibold">Rubric v{g.rubricVersionNo} (provisional)</h3>
                  {g.teams.length ? (
                    <RankedTable
                      teams={g.teams}
                      caption={`Provisional ranking, rubric version ${g.rubricVersionNo}`}
                      provisional
                      sort={sort}
                      dir={dir}
                      onSort={onSort}
                    />
                  ) : (
                    <p className="text-sm text-black/60">No team matches your search.</p>
                  )}
                </div>
              ))}
            </section>
          )}

          <section className="space-y-3" aria-labelledby="not-ranked-heading">
            <div>
              <h2 id="not-ranked-heading" className="text-lg font-bold">
                Not ranked yet ({data!.notRanked.length})
              </h2>
              <p className="text-sm text-black/60">
                These teams are not eligible for the official ranking. Their provisional average
                uses only the scores submitted so far and may change.
              </p>
            </div>
            {data!.notRanked.length ? (
              <NotRankedList teams={data!.notRanked} />
            ) : (
              <p className="text-sm text-black/60">
                {searching
                  ? 'No unranked team matches your search.'
                  : 'Every active team is ranked.'}
              </p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
