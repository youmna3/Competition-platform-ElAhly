import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useLocation } from 'react-router';
import { formatScore, type JudgeAssignment, type PublishedRubricResponse } from '@judging/shared';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Alert, Badge, Button, Card } from '../../components/ui';
import { FullPageSpinner } from '../../components/FullPageSpinner';

const STATUS: Record<
  JudgeAssignment['evaluationStatus'],
  { label: string; tone: 'gray' | 'gold' | 'green'; action: string }
> = {
  not_started: { label: 'Not started', tone: 'gray', action: 'Start Evaluation' },
  draft: { label: 'Draft', tone: 'gold', action: 'Continue Evaluation' },
  submitted: { label: 'Submitted', tone: 'green', action: 'View Evaluation' },
};

const formatDate = (value: string) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value));

function Progress({ a }: { a: JudgeAssignment }) {
  return (
    <span className="text-sm text-black/65 tabular-nums">
      {a.evaluationStatus === 'submitted' && a.totalScore != null ? (
        <>
          <strong className="text-ink">{formatScore(a.totalScore)}</strong> / 100
        </>
      ) : (
        `${a.ratedCount}/${a.requiredCount} rated`
      )}
    </span>
  );
}

function OpenLink({ a }: { a: JudgeAssignment }) {
  const s = STATUS[a.evaluationStatus];
  return (
    <Link
      to={`/judge/teams/${a.teamId}`}
      aria-label={`${s.action.replace('Evaluation', 'evaluation')} of ${a.teamName}`}
      className={a.evaluationStatus === 'submitted' ? 'secondary-link' : 'action-link'}
    >
      {s.action}
    </Link>
  );
}

export function JudgeTeamsPage() {
  const { user } = useAuth();
  const [filter, setFilter] = useState('all');
  const location = useLocation();
  const passwordChanged = (location.state as { passwordChanged?: boolean } | null)?.passwordChanged;
  const query = useQuery({
    queryKey: ['judge', 'assignments'],
    queryFn: () => api<{ assignments: JudgeAssignment[] }>('/api/judge/assignments'),
  });
  const rubric = useQuery({
    queryKey: ['judge', 'rubric'],
    queryFn: () => api<PublishedRubricResponse>('/api/judge/rubric'),
  });
  const assignments = query.data?.assignments ?? [];
  const submitted = assignments.filter((a) => a.evaluationStatus === 'submitted').length;
  const notPublished = rubric.data != null && rubric.data.rubric == null;
  const reopened = assignments.filter((a) => a.reopenNotice);
  const visible = assignments
    .filter(
      (a) =>
        filter === 'all' ||
        (filter === 'pending'
          ? a.evaluationStatus !== 'submitted'
          : a.evaluationStatus === 'submitted'),
    )
    .toSorted(
      (a, b) =>
        Number(a.evaluationStatus === 'submitted') - Number(b.evaluationStatus === 'submitted'),
    );
  const percent = assignments.length ? Math.round((submitted / assignments.length) * 100) : 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">{user?.role === 'admin' ? 'Administrator · judging' : 'Judge'}</p>
          <h1 className="text-2xl font-bold sm:text-3xl">My assigned teams</h1>
          <p className="mt-1 text-sm text-black/60">
            Signed in as {user?.fullName}
            {assignments.length > 0 && ` · ${submitted} of ${assignments.length} submitted`}.
          </p>
        </div>
        <Link to="/rubric" className="secondary-link">
          View Judging Rubric
        </Link>
      </div>
      {passwordChanged && (
        <Alert tone="success">Your password was changed. Other devices have been signed out.</Alert>
      )}
      {reopened.length > 0 && (
        <Alert tone="warning" title="An administrator reopened your evaluation">
          <ul className="space-y-1">
            {reopened.map((a) => (
              <li key={a.teamId}>
                <Link to={`/judge/teams/${a.teamId}`} className="font-semibold underline">
                  {a.teamCode} · {a.teamName}
                </Link>
                {a.reopenReason && <> — “{a.reopenReason}”</>}. Please review it and submit it
                again.
              </li>
            ))}
          </ul>
        </Alert>
      )}
      {notPublished && (
        <Alert tone="info" title="Judging hasn’t started yet">
          The administrator hasn’t published the rubric. You can open your teams once it is
          published.
        </Alert>
      )}
      {query.isPending ? (
        <FullPageSpinner label="Loading your teams…" />
      ) : query.isError ? (
        <Alert tone="error" title="Could not load your teams">
          {query.error.message}
        </Alert>
      ) : assignments.length === 0 ? (
        <Card className="py-12 text-center">
          <p className="text-lg font-semibold">No teams assigned yet</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-black/60">
            The competition administrator will assign teams to you. They will appear here.
          </p>
        </Card>
      ) : (
        <>
          <Card className="!border-ischool-blue/20 !bg-ischool-blue-soft">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="eyebrow">Your judging progress</p>
                <p className="mt-2 text-2xl font-bold">
                  {submitted} of {assignments.length} submitted
                </p>
                <p className="mt-1 text-sm text-muted">
                  {assignments.length - submitted}{' '}
                  {assignments.length - submitted === 1 ? 'team still needs' : 'teams still need'}{' '}
                  your evaluation.
                </p>
              </div>
              <p className="text-3xl font-bold text-ischool-blue-dark tabular-nums">{percent}%</p>
            </div>
            <div
              role="progressbar"
              aria-label="Evaluations submitted"
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
              className="mt-4 h-2.5 overflow-hidden rounded-full bg-ischool-blue/10"
            >
              <div
                className="h-full rounded-full bg-ischool-blue"
                style={{ width: `${percent}%` }}
              />
            </div>
          </Card>
          <div role="group" aria-label="Filter assigned teams" className="flex flex-wrap gap-2">
            {(
              [
                ['all', 'All teams', assignments.length],
                ['pending', 'Needs evaluation', assignments.length - submitted],
                ['submitted', 'Submitted', submitted],
              ] as const
            ).map(([value, label, count]) => (
              <Button
                key={value}
                variant={filter === value ? 'primary' : 'secondary'}
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {label} ({count})
              </Button>
            ))}
          </div>
          {visible.length === 0 ? (
            <Card className="py-10 text-center">
              <p className="font-semibold">No teams in this view</p>
              <p className="mt-1 text-sm text-muted">
                Choose another filter to see your assigned teams.
              </p>
            </Card>
          ) : (
            <ul className="grid gap-4 md:grid-cols-2" aria-label="Assigned teams">
              {visible.map((a) => (
                <li key={a.teamId} className="min-w-0">
                  <Card className="flex h-full flex-col gap-5 !border-t-4 border-t-ischool-blue/30">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-semibold tracking-wide text-muted">
                          TEAM ID · {a.teamCode}
                        </p>
                        <h2 className="mt-1 break-words text-xl font-bold">{a.teamName}</h2>
                      </div>
                      <Badge tone={STATUS[a.evaluationStatus].tone}>
                        {STATUS[a.evaluationStatus].label}
                      </Badge>
                    </div>
                    <div className="min-w-0 rounded-xl bg-surface px-4 py-3">
                      <p className="text-xs font-semibold text-muted">Project</p>
                      <p className="mt-1 break-words text-sm font-medium">{a.projectName}</p>
                    </div>
                    {(a.reopenNotice || a.outdatedVersion) && (
                      <div className="flex flex-wrap gap-2">
                        {a.reopenNotice && <Badge tone="red">Reopened</Badge>}
                        {a.outdatedVersion && (
                          <Badge tone="gold">Older rubric v{a.rubricVersionNo}</Badge>
                        )}
                      </div>
                    )}
                    <div className="mt-auto space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <Progress a={a} />
                        <span className="text-xs text-muted">
                          Assigned {formatDate(a.assignedAt)}
                        </span>
                      </div>
                      <div
                        role="progressbar"
                        aria-label={`${a.teamName}: criteria rated`}
                        aria-valuenow={a.ratedCount}
                        aria-valuemin={0}
                        aria-valuemax={a.requiredCount}
                        className="h-1.5 overflow-hidden rounded-full bg-ischool-blue/10"
                      >
                        <div
                          className={`h-full rounded-full ${a.evaluationStatus === 'submitted' ? 'bg-emerald-600' : 'bg-ischool-blue'}`}
                          style={{
                            width: `${a.requiredCount ? Math.min(100, (a.ratedCount / a.requiredCount) * 100) : 0}%`,
                          }}
                        />
                      </div>
                      <div className="flex justify-end border-t border-line/70 pt-4">
                        {(!notPublished || a.evaluationStatus !== 'not_started') && (
                          <OpenLink a={a} />
                        )}
                      </div>
                    </div>
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
