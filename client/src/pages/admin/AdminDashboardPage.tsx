import { useQuery } from '@tanstack/react-query';
import { Link, useLocation } from 'react-router';
import {
  RUBRIC_STATE_LABELS,
  TEAM_RESULT_STATUS_LABELS,
  formatScore,
  type AdminOverview,
  type DashboardResponse,
} from '@judging/shared';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Alert, Button, Card } from '../../components/ui';
import { ProgressBars, StackedBar } from './results/charts';
import { RESULTS_POLL_MS, formatTime } from './results/model';
import { FullPageSpinner } from '../../components/FullPageSpinner';

function Stat({ label, value, note }: { label: string; value: string | number; note?: string }) {
  return (
    <Card className="dashboard-stat !p-5">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-2 text-3xl font-bold">{value}</p>
      {note && <p className="mt-1 text-xs text-muted">{note}</p>}
    </Card>
  );
}

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

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Active teams"
          value={data.teams.active}
          note={`${data.teams.archived} archived`}
        />
        <Stat
          label="Judges"
          value={data.accounts.judges}
          note={`${data.accounts.participatingJudges} assigned to teams (incl. admins)`}
        />
        <Stat label="Administrators" value={data.accounts.administrators} />
        <Stat
          label="Completion"
          value={e.completionPercent == null ? '—' : `${Math.round(e.completionPercent)}%`}
          note={`${e.submitted} of ${e.required} evaluations submitted`}
        />
        <Stat label="Draft evaluations" value={e.draft} note={`${e.notStarted} not started`} />
        <Stat
          label="Teams ready for results"
          value={data.teamStatus.ready}
          note={`${data.teamStatus.blocked} blocked · ${e.teamsWaiting} waiting`}
        />
        <Stat
          label="Judges with pending work"
          value={e.judgesWithPending}
          note={`${e.pending} evaluations pending`}
        />
        <Stat
          label="Average submitted score"
          value={e.averageSubmittedScore == null ? '—' : formatScore(e.averageSubmittedScore)}
          note="Descriptive only — not a team result"
        />
      </div>

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
            <h3 className="text-sm font-semibold">Top teams</h3>
            <Link to="/admin/leaderboard" className="secondary-link">
              Full leaderboard →
            </Link>
          </div>
          {data.officialAvailable && data.topTeams.length ? (
            <ol className="space-y-2">
              {data.topTeams.map((t) => (
                <li
                  key={t.teamId}
                  className="flex items-center justify-between gap-3 rounded-xl bg-ahly-gold-light/40 px-3 py-2"
                >
                  <span>
                    <span className="mr-2 font-bold tabular-nums">#{t.rank}</span>
                    <span className="font-semibold">{t.name}</span>
                    <span className="ml-2 font-mono text-xs text-muted">{t.teamCode}</span>
                  </span>
                  <span className="text-lg font-bold tabular-nums">{formatScore(t.score)}</span>
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

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Administrator</p>
          <h1 className="text-2xl font-bold sm:text-3xl">Welcome, {user?.fullName}</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted">
            Your competition at a glance. Track judging, manage the rubric and review official
            results.
          </p>
        </div>
        <Link to="/admin/settings" className="secondary-link">
          Settings →
        </Link>
      </div>

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
