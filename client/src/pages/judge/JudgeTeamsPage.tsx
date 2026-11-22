import { useQuery } from '@tanstack/react-query';
import { Link, useLocation } from 'react-router';
import { formatScore, type JudgeAssignment, type PublishedRubricResponse } from '@judging/shared';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Alert, Badge, Card } from '../../components/ui';
import { FullPageSpinner } from '../../components/FullPageSpinner';

const STATUS: Record<
  JudgeAssignment['evaluationStatus'],
  { label: string; tone: 'gray' | 'gold' | 'green'; action: string }
> = {
  not_started: { label: 'Not started', tone: 'gray', action: 'Start' },
  draft: { label: 'Draft', tone: 'gold', action: 'Continue' },
  submitted: { label: 'Submitted', tone: 'green', action: 'View' },
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
      aria-label={`${s.action} evaluation of ${a.teamName}`}
      className={`inline-flex items-center rounded-full px-4 py-1.5 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-ischool-blue ${
        a.evaluationStatus === 'submitted'
          ? 'border border-black/15 bg-white hover:bg-black/5'
          : 'bg-ahly-red text-white hover:bg-ahly-red-dark'
      }`}
    >
      {s.action}
    </Link>
  );
}

export function JudgeTeamsPage() {
  const { user } = useAuth();
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

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-ahly-red">
            {user?.role === 'admin' ? 'Administrator · judging' : 'Judge'}
          </p>
          <h1 className="text-2xl font-bold sm:text-3xl">My assigned teams</h1>
          <p className="mt-1 text-sm text-black/60">
            Signed in as {user?.fullName}
            {assignments.length > 0 && ` · ${submitted} of ${assignments.length} submitted`}.
          </p>
        </div>
        <Link to="/rubric" className="text-sm font-semibold text-ischool-blue hover:underline">
          View the judging rubric →
        </Link>
      </div>
      {passwordChanged && (
        <Alert tone="success">Your password was changed. Other devices have been signed out.</Alert>
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
          <Card className="hidden overflow-x-auto !p-0 md:block">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-black/5 text-xs tracking-wide text-black/50 uppercase">
                <tr>
                  <th scope="col" className="px-5 py-3 font-semibold">
                    Team ID
                  </th>
                  <th scope="col" className="px-3 py-3 font-semibold">
                    Team
                  </th>
                  <th scope="col" className="px-3 py-3 font-semibold">
                    Project
                  </th>
                  <th scope="col" className="px-3 py-3 font-semibold">
                    Assigned
                  </th>
                  <th scope="col" className="px-3 py-3 font-semibold">
                    Evaluation
                  </th>
                  <th scope="col" className="px-3 py-3 font-semibold">
                    Progress
                  </th>
                  <th scope="col" className="px-5 py-3 font-semibold">
                    <span className="sr-only">Open</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-black/5">
                {assignments.map((a) => (
                  <tr key={a.teamId}>
                    <td className="px-5 py-3 font-semibold">{a.teamCode}</td>
                    <td className="px-3 py-3">{a.teamName}</td>
                    <td className="px-3 py-3 text-black/70">{a.projectName}</td>
                    <td className="px-3 py-3 whitespace-nowrap text-black/60">
                      {formatDate(a.assignedAt)}
                    </td>
                    <td className="px-3 py-3">
                      <Badge tone={STATUS[a.evaluationStatus].tone}>
                        {STATUS[a.evaluationStatus].label}
                      </Badge>
                      {a.outdatedVersion && (
                        <span className="ml-1">
                          <Badge tone="gold">Older rubric v{a.rubricVersionNo}</Badge>
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      <Progress a={a} />
                    </td>
                    <td className="px-5 py-3 text-right">
                      {!notPublished || a.evaluationStatus !== 'not_started' ? (
                        <OpenLink a={a} />
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <ul className="space-y-3 md:hidden">
            {assignments.map((a) => (
              <li key={a.teamId}>
                <Card className="space-y-2 !p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-semibold">{a.teamName}</p>
                      <p className="text-xs font-medium text-black/50">{a.teamCode}</p>
                    </div>
                    <Badge tone={STATUS[a.evaluationStatus].tone}>
                      {STATUS[a.evaluationStatus].label}
                    </Badge>
                  </div>
                  <p className="text-sm text-black/70">{a.projectName}</p>
                  {a.outdatedVersion && (
                    <Badge tone="gold">Older rubric v{a.rubricVersionNo}</Badge>
                  )}
                  <div className="flex items-center justify-between gap-3">
                    <Progress a={a} />
                    {(!notPublished || a.evaluationStatus !== 'not_started') && <OpenLink a={a} />}
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
