import { TopTeams } from '../../components/TopTeams';
import { RankChip, ResultsHero } from '../../components/Results';
import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import {
  LEADERBOARD_SORTS,
  TEAM_RESULT_STATUS_LABELS,
  formatScore,
  type JudgeLeaderboardResponse,
  type LeaderboardSort,
} from '@judging/shared';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Alert, Badge, Button, Card, SelectField } from '../../components/ui';
import { FullPageSpinner } from '../../components/FullPageSpinner';
import { RESULTS_POLL_MS, formatTime } from '../admin/results/model';

const labels: Record<LeaderboardSort, string> = {
  rank: 'Rank',
  teamCode: 'Team ID',
  name: 'Team',
  projectName: 'Project',
  score: 'Final average',
};

export function CompetitionLeaderboardPage() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const activeSearch = params.get('search') ?? '';
  const [draft, setDraft] = useState({ source: activeSearch, value: activeSearch });
  const search = draft.source === activeSearch ? draft.value : activeSearch;
  const rawSort = params.get('sort');
  const sort: LeaderboardSort = LEADERBOARD_SORTS.find((s) => s === rawSort) ?? 'rank';
  const dir = params.get('dir') === 'desc' ? 'desc' : 'asc';
  useEffect(() => {
    if (search === activeSearch) return;
    const timer = setTimeout(() => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (search.trim()) next.set('search', search.trim());
          else next.delete('search');
          return next;
        },
        { replace: true },
      );
    }, 300);
    return () => clearTimeout(timer);
  }, [search, activeSearch, setParams]);
  function changeSort(field: LeaderboardSort, direction?: string) {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.set('sort', field);
        next.set('dir', direction ?? (sort === field && dir === 'asc' ? 'desc' : 'asc'));
        return next;
      },
      { replace: true },
    );
  }
  const query = new URLSearchParams({ sort, dir });
  if (activeSearch) query.set('search', activeSearch);
  const results = useQuery({
    queryKey: ['judge', 'leaderboard', query.toString()],
    queryFn: () => api<JudgeLeaderboardResponse>(`/api/judge/leaderboard?${query}`),
    placeholderData: keepPreviousData,
    refetchInterval: RESULTS_POLL_MS,
  });
  const data = results.data;
  const teams = data?.official.teams ?? [];
  const tied = (rank: number) => teams.filter((t) => t.rank === rank).length > 1;
  return (
    <div className="space-y-6">
      <ResultsHero
        eyebrow="Competition results · read-only"
        title="Leaderboard"
        description="Official rankings for signed-in administrators and judges. A team is ranked after every assigned judge submits on a compatible rubric. Equal scores share a rank."
        updatedAt={data ? formatTime(data.computedAt) : null}
        refreshing={results.isFetching}
        onRefresh={() => void results.refetch()}
      >
        {user?.role === 'admin' && (
          <Link
            to="/admin/leaderboard"
            className="inline-flex min-h-11 items-center rounded-xl bg-white/15 px-4 text-sm font-semibold text-white ring-1 ring-white/30 ring-inset hover:bg-white/25"
          >
            Open detailed results →
          </Link>
        )}
      </ResultsHero>
      <Card className="grid items-end gap-4 !p-4 sm:grid-cols-[minmax(0,1fr)_220px]">
        <div className="space-y-1.5">
          <label htmlFor="leaderboard-search" className="block text-sm font-medium">
            Search
          </label>
          <input
            id="leaderboard-search"
            type="search"
            placeholder="Team ID, team or project"
            value={search}
            maxLength={100}
            onChange={(e) => setDraft({ source: activeSearch, value: e.target.value })}
            className="block w-full rounded-xl border border-line bg-white px-3.5 py-2.5 text-base outline-none focus:border-ischool-blue focus:ring-4 focus:ring-ischool-blue/15 sm:text-sm"
          />
        </div>
        <SelectField
          label="Sort by"
          value={`${sort}:${dir}`}
          onChange={(e) => {
            const [field, direction] = e.target.value.split(':');
            changeSort(field as LeaderboardSort, direction);
          }}
        >
          {LEADERBOARD_SORTS.flatMap((s) =>
            ['asc', 'desc'].map((d) => (
              <option key={`${s}:${d}`} value={`${s}:${d}`}>
                {labels[s]} ({d === 'asc' ? 'ascending' : 'descending'})
              </option>
            )),
          )}
        </SelectField>
      </Card>
      {results.isPending ? (
        <FullPageSpinner label="Loading competition results…" />
      ) : results.isError ? (
        <Alert tone="error" title="Could not load the leaderboard">
          <p>{results.error.message}</p>
          <Button variant="secondary" className="mt-3" onClick={() => void results.refetch()}>
            Try again
          </Button>
        </Alert>
      ) : (
        data && (
          <>
            {data.versionWarnings.map((warning) => (
              <Alert key={warning} tone="warning" title="Rubric versions">
                {warning}
              </Alert>
            ))}
            {data.totalTeams === 0 ? (
              <Card className="py-12 text-center">
                <h2 className="text-lg font-bold">No active teams yet</h2>
                <p className="mt-2 text-sm text-muted">
                  Official results will appear here as judging is completed.
                </p>
              </Card>
            ) : (
              <>
                {data.official.available && <TopTeams teams={teams} />}
                <section className="space-y-4" aria-labelledby="competition-ranking">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h2 id="competition-ranking" className="text-lg font-bold">
                      Official ranking
                    </h2>
                    {data.official.rubricVersionNo != null && (
                      <Badge tone="blue">Rubric v{data.official.rubricVersionNo}</Badge>
                    )}
                  </div>
                  {!data.official.available ? (
                    <Alert tone="warning" title="No official ranking yet">
                      {data.official.unavailableReason}
                    </Alert>
                  ) : teams.length === 0 ? (
                    <Card>No ranked team matches your search.</Card>
                  ) : (
                    <>
                      <Card className="hidden overflow-x-auto !p-0 md:block">
                        <table className="w-full text-left text-sm">
                          <caption className="sr-only">Official ranking</caption>
                          <thead className="text-xs uppercase tracking-wide">
                            <tr>
                              {LEADERBOARD_SORTS.map((field) => (
                                <th
                                  key={field}
                                  scope="col"
                                  className="px-5 py-4"
                                  aria-sort={
                                    sort === field
                                      ? dir === 'asc'
                                        ? 'ascending'
                                        : 'descending'
                                      : 'none'
                                  }
                                >
                                  <button
                                    type="button"
                                    className="font-semibold hover:text-ischool-blue-dark"
                                    onClick={() => changeSort(field)}
                                    aria-label={`Sort by ${labels[field]}`}
                                  >
                                    {labels[field]}{' '}
                                    <span aria-hidden>
                                      {sort === field ? (dir === 'asc' ? '↑' : '↓') : '↕'}
                                    </span>
                                  </button>
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-line/60">
                            {teams.map((t) => (
                              <tr
                                key={t.teamId}
                                className={t.rank <= 3 ? 'bg-ischool-blue-soft/50' : ''}
                              >
                                <td className="px-5 py-5">
                                  <RankChip rank={t.rank} tied={tied(t.rank)} />
                                </td>
                                <td className="px-5 py-5 font-mono text-xs text-muted">
                                  {t.teamCode}
                                </td>
                                <td className="px-5 py-5 font-semibold">{t.name}</td>
                                <td className="px-5 py-5 text-muted">{t.projectName}</td>
                                <td className="px-5 py-5 text-xl font-bold tabular-nums">
                                  <span className="text-ischool-blue-dark">
                                    {formatScore(t.score)}
                                  </span>{' '}
                                  <span className="text-sm font-medium text-muted">
                                    / {t.maximumScore ?? 100}
                                  </span>
                                  {(t.bonusAverage ?? 0) > 0 && (
                                    <span className="block text-xs font-normal text-muted">
                                      Base {formatScore(t.baseAverage ?? t.score)} · Bonus +{' '}
                                      {formatScore(t.bonusAverage ?? 0)}
                                    </span>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </Card>
                      <ol className="grid gap-3 md:hidden" aria-label="Official ranking">
                        {teams.map((t) => (
                          <li key={t.teamId}>
                            <Card className="space-y-3">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <RankChip rank={t.rank} tied={tied(t.rank)} />
                                <span className="text-xs text-muted">{t.teamCode}</span>
                              </div>
                              <h3 className="break-words text-lg font-bold">{t.name}</h3>
                              <p className="break-words text-sm text-muted">{t.projectName}</p>
                              <p className="border-t border-line pt-3 text-2xl font-bold text-ischool-blue-dark tabular-nums">
                                {formatScore(t.score)}{' '}
                                <span className="text-sm font-medium text-muted">
                                  / {t.maximumScore ?? 100}
                                </span>
                                {(t.bonusAverage ?? 0) > 0 && (
                                  <span className="block text-xs font-normal text-muted">
                                    Base {formatScore(t.baseAverage ?? t.score)} · Bonus +{' '}
                                    {formatScore(t.bonusAverage ?? 0)}
                                  </span>
                                )}
                              </p>
                            </Card>
                          </li>
                        ))}
                      </ol>
                    </>
                  )}
                </section>
                <section className="space-y-3" aria-labelledby="competition-not-ranked">
                  <div>
                    <h2 id="competition-not-ranked" className="text-lg font-bold">
                      Not ranked yet ({data.notRanked.length})
                    </h2>
                    <p className="mt-1 text-sm text-muted">
                      Incomplete, blocked and rubric-incompatible teams stay outside the official
                      ranking. No provisional scores are shown.
                    </p>
                  </div>
                  {data.notRanked.length ? (
                    <ul className="grid gap-3 sm:grid-cols-2">
                      {data.notRanked.map((t) => (
                        <li key={t.teamId}>
                          <Card className="h-full space-y-2 !p-4">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="font-mono text-xs text-muted">{t.teamCode}</span>
                              <Badge
                                tone={
                                  t.status === 'blocked' || t.status === 'version_conflict'
                                    ? 'gold'
                                    : 'gray'
                                }
                              >
                                {t.status === 'version_conflict'
                                  ? 'Rubric version conflict'
                                  : TEAM_RESULT_STATUS_LABELS[t.status]}
                              </Badge>
                            </div>
                            <h3 className="break-words font-semibold">{t.name}</h3>
                            <p className="break-words text-sm text-muted">{t.projectName}</p>
                          </Card>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-muted">
                      {activeSearch
                        ? 'No unranked team matches your search.'
                        : 'Every active team is ranked.'}
                    </p>
                  )}
                </section>
              </>
            )}
          </>
        )
      )}
    </div>
  );
}
