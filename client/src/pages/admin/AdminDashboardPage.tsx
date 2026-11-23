import { useQuery } from '@tanstack/react-query';
import { Link, useLocation } from 'react-router';
import {
  COMPETITION_LABELS,
  RUBRIC_STATE_LABELS,
  TEAM_RESULT_STATUS_LABELS,
  formatScore,
  type AdminOverview,
  type DashboardResponse,
} from '@judging/shared';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { useCompetition } from '../../components/CompetitionNotice';
import { RankChip } from '../../components/Results';
import { MiniBar } from '../../components/PointsInput';
import { Alert, Button, Card, StatCard } from '../../components/ui';
import { ProgressBars, StackedBar } from './results/charts';
import { RESULTS_POLL_MS, formatTime } from './results/model';
import { FullPageSpinner } from '../../components/FullPageSpinner';

const QUICK_ACTIONS: { to: string; label: string; note: string }[] = [
  { to: '/admin/teams', label: 'Teams & judges', note: 'Add teams, assign judges' },
  { to: '/admin/evaluations', label: 'Evaluations', note: 'Review and correct' },
  { to: '/admin/leaderboard', label: 'Leaderboard', note: 'Official rankings' },
  { to: '/admin/rubric', label: 'Rubric', note: 'Draft, preview, publish' },
  { to: '/admin/reports', label: 'Reports', note: 'Excel and CSV exports' },
  { to: '/admin/settings', label: 'Settings', note: 'Competition lifecycle' },
];

function CompetitionFigures({
  data,
  refreshing,
  onRefresh,
}: {
  data: DashboardResponse;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const e = data.evaluations;
  const pct = e.completionPercent == null ? null : Math.round(e.completionPercent);
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-bold">Competition progress</h2>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted">Updated {formatTime(data.computedAt)}</span>
          <Button variant="secondary" onClick={onRefresh} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Total teams"
          value={data.teams.active}
          note={`${data.teams.archived} archived`}
        />
        <StatCard
          label="Assigned judges"
          value={data.accounts.participatingJudges}
          note={`${data.accounts.judges} judge account${data.accounts.judges === 1 ? '' : 's'} · ${data.accounts.administrators} administrator${data.accounts.administrators === 1 ? '' : 's'}`}
          accent="gold"
        />
        <StatCard
          label="Submitted evaluations"
          value={e.submitted}
          note={`of ${e.required} required`}
          accent="green"
        />
        <StatCard
          label="Pending evaluations"
          value={e.pending}
          note={`${e.draft} draft${e.draft === 1 ? '' : 's'} · ${e.notStarted} not started`}
          accent={e.pending ? 'red' : 'gray'}
        />
      </div>

      <Card className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="eyebrow">Judging progress</p>
            <p className="mt-1 text-4xl font-bold text-ischool-blue-dark tabular-nums">
              {pct == null ? '—' : `${pct}%`}
            </p>
            <p className="text-sm text-muted">
              {e.submitted} of {e.required} evaluations submitted
            </p>
          </div>
          <dl className="grid grid-cols-3 gap-4 text-sm">
            <div>
              <dt className="text-muted">Teams ready</dt>
              <dd className="text-xl font-bold tabular-nums">{data.teamStatus.ready}</dd>
            </div>
            <div>
              <dt className="text-muted">Waiting</dt>
              <dd className="text-xl font-bold tabular-nums">{e.teamsWaiting}</dd>
            </div>
            <div>
              <dt className="text-muted">Judges with work</dt>
              <dd className="text-xl font-bold tabular-nums">{e.judgesWithPending}</dd>
            </div>
          </dl>
        </div>
        <MiniBar
          value={e.submitted}
          max={Math.max(1, e.required)}
          label="Evaluations submitted"
          tone={e.required > 0 && e.submitted === e.required ? 'green' : 'blue'}
        />
        <p className="text-xs text-muted">
          Average submitted score:{' '}
          <strong>
            {e.averageSubmittedScore == null ? '—' : formatScore(e.averageSubmittedScore)}
          </strong>{' '}
          · Descriptive only — not a team result. {data.teamStatus.blocked} team
          {data.teamStatus.blocked === 1 ? '' : 's'} blocked.
        </p>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="space-y-6">
          <StackedBar
            title="Evaluations: submitted vs pending"
            segments={[
              { key: 'submitted', label: 'Submitted', value: e.submitted, color: 'bg-emerald-600' },
              { key: 'draft', label: 'Draft', value: e.draft, color: 'bg-ahly-gold' },
              {
                key: 'not_started',
                label: 'Not started',
                value: e.notStarted,
                color: 'bg-black/25',
              },
            ]}
          />
          <StackedBar
            title="Teams by completion status"
            segments={[
              {
                key: 'ready',
                label: TEAM_RESULT_STATUS_LABELS.ready,
                value: data.teamStatus.ready,
                color: 'bg-emerald-600',
              },
              {
                key: 'in_progress',
                label: TEAM_RESULT_STATUS_LABELS.in_progress,
                value: data.teamStatus.in_progress,
                color: 'bg-ahly-gold',
              },
              {
                key: 'not_started',
                label: TEAM_RESULT_STATUS_LABELS.not_started,
                value: data.teamStatus.not_started,
                color: 'bg-black/25',
              },
              {
                key: 'blocked',
                label: TEAM_RESULT_STATUS_LABELS.blocked,
                value: data.teamStatus.blocked,
                color: 'bg-ahly-red',
              },
              {
                key: 'unassigned',
                label: TEAM_RESULT_STATUS_LABELS.unassigned,
                value: data.teamStatus.unassigned,
                color: 'bg-ischool-blue/40',
              },
            ]}
          />
        </Card>

        <Card className="space-y-4">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="text-base font-bold">Top teams</h3>
            <Link to="/admin/leaderboard" className="secondary-link">
              Full leaderboard →
            </Link>
          </div>
          {data.officialAvailable && data.topTeams.length ? (
            <ol className="space-y-2">
              {data.topTeams.map((t) => (
                <li
                  key={t.teamId}
                  className="flex items-center justify-between gap-3 rounded-xl border border-line bg-white px-3 py-2.5"
                >
                  <span className="flex min-w-0 items-center gap-3">
                    <RankChip rank={t.rank} />
                    <span className="min-w-0">
                      <span className="block truncate font-semibold">{t.name}</span>
                      <span className="block font-mono text-xs text-muted">{t.teamCode}</span>
                    </span>
                  </span>
                  <span className="text-lg font-bold text-ischool-blue-dark tabular-nums">
                    {formatScore(t.score)}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-sm text-black/60">
              {data.officialUnavailableReason ?? 'No official ranking yet.'}
            </p>
          )}
        </Card>
      </div>

      <Card>
        {data.judges.length ? (
          <ProgressBars
            title="Judge progress (submitted of assigned; gold = draft)"
            rows={data.judges.map((j) => ({
              key: String(j.judgeId),
              label: j.fullName,
              note: [
                j.role === 'admin' ? '(admin)' : '',
                j.accountStatus !== 'active' ? '(disabled)' : '',
              ]
                .filter(Boolean)
                .join(' '),
              done: j.submitted,
              draft: j.draft,
              total: j.assigned,
            }))}
          />
        ) : (
          <p className="text-sm text-black/60">No judge is assigned to an active team yet.</p>
        )}
      </Card>
    </div>
  );
}

export function AdminDashboardPage() {
  const { user } = useAuth();
  const location = useLocation();
  const passwordChanged = (location.state as { passwordChanged?: boolean } | null)?.passwordChanged;
  const overview = useQuery({
    queryKey: ['admin', 'overview'],
    queryFn: () => api<AdminOverview>('/api/admin/overview'),
    refetchInterval: RESULTS_POLL_MS,
  });
  const dashboard = useQuery({
    queryKey: ['admin', 'dashboard'],
    queryFn: () => api<DashboardResponse>('/api/admin/dashboard'),
    refetchInterval: RESULTS_POLL_MS,
  });

  const competition = useCompetition();
  const state = competition.data?.state;
  return (
    <div className="space-y-8">
      <section className="overflow-hidden rounded-3xl bg-ischool-blue border-b-4 border-ahly-red text-white shadow-[0_24px_48px_-32px_#045bc4]">
        <div className="relative px-5 py-6 sm:px-8 sm:py-8">
          <div
            aria-hidden
            className="pointer-events-none absolute -top-24 -right-16 size-72 rounded-full bg-white/10"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute -bottom-28 -left-20 size-64 rounded-full bg-ahly-red/35 blur-2xl"
          />
          <div className="relative flex flex-wrap items-end justify-between gap-4">
            <div className="max-w-2xl">
              <p className="hero-eyebrow text-xs font-bold tracking-[0.16em] text-white/80 uppercase">
                Administrator
              </p>
              <h1 className="mt-1 text-3xl font-bold tracking-tight sm:text-4xl">
                Welcome, {user?.fullName}
              </h1>
              <p className="mt-2 text-sm text-white/85 sm:text-base">
                Your competition at a glance. Track judging, manage the rubric and review official
                results.
              </p>
            </div>
            {state && (
              <div className="rounded-2xl bg-white/12 px-4 py-3 ring-1 ring-white/25 ring-inset">
                <p className="text-xs text-white/80">Competition lifecycle</p>
                <p className="text-lg font-bold">{COMPETITION_LABELS[state]}</p>
                {competition.data?.lockedRubricVersionNo != null && (
                  <p className="text-xs text-white/80">
                    Rubric v{competition.data.lockedRubricVersionNo} locked
                  </p>
                )}
              </div>
            )}
          </div>
          <nav
            aria-label="Quick actions"
            className="relative mt-6 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6"
          >
            {QUICK_ACTIONS.map((a) => (
              <Link
                key={a.to}
                to={a.to}
                className="rounded-2xl bg-white px-4 py-3 text-ink shadow-sm transition hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
              >
                <span className="block text-sm font-bold text-ischool-blue-dark">{a.label}</span>
                <span className="block text-xs text-muted">{a.note}</span>
              </Link>
            ))}
          </nav>
        </div>
      </section>

      {passwordChanged && (
        <Alert tone="success">Your password was changed. Other devices have been signed out.</Alert>
      )}

      {overview.isPending ? (
        <FullPageSpinner label="Loading the dashboard…" />
      ) : overview.isError ? (
        <Alert tone="error" title="Could not load the dashboard">
          {overview.error.message}
        </Alert>
      ) : (
        <>
          <Card className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">
                Judging rubric
              </p>
              <p className="mt-1 text-lg font-semibold">
                {RUBRIC_STATE_LABELS[overview.data.rubricState]}
                {overview.data.publishedRubricVersion
                  ? ` · version ${overview.data.publishedRubricVersion}`
                  : ''}
              </p>
              <p className="text-sm text-black/60">
                {overview.data.rubricState === 'not_configured' ||
                overview.data.rubricState === 'draft_only'
                  ? 'Judging cannot start until the rubric is built and published. '
                  : overview.data.rubricState === 'published_with_draft'
                    ? 'Judges use the published version; a draft with changes is waiting. '
                    : 'Judges score against the published rubric. '}
                <Link to="/admin/rubric" className="secondary-link">
                  Open Rubric Management
                </Link>
              </p>
            </div>
            <span
              className={`self-start rounded-full px-3 py-1 text-xs font-semibold sm:self-center ${
                overview.data.rubricState === 'published'
                  ? 'bg-emerald-50 text-emerald-700'
                  : 'bg-ahly-gold-light text-amber-900'
              }`}
            >
              {RUBRIC_STATE_LABELS[overview.data.rubricState]}
            </span>
          </Card>
          {dashboard.isPending ? (
            <FullPageSpinner label="Calculating progress…" />
          ) : dashboard.isError ? (
            <Alert tone="error" title="Could not load the competition figures">
              {dashboard.error.message}
            </Alert>
          ) : (
            <CompetitionFigures
              data={dashboard.data}
              refreshing={dashboard.isFetching}
              onRefresh={() => {
                void dashboard.refetch();
                void overview.refetch();
              }}
            />
          )}
        </>
      )}
    </div>
  );
}
