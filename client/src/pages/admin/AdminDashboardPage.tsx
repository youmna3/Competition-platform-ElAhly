import { useQuery } from '@tanstack/react-query';
import { Link, useLocation } from 'react-router';
import { RUBRIC_STATE_LABELS, type AdminOverview } from '@judging/shared';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Alert, Card } from '../../components/ui';
import { FullPageSpinner } from '../../components/FullPageSpinner';

function Stat({ label, value, note }: { label: string; value: string | number; note?: string }) {
  return (
    <Card className="!p-5">
      <p className="text-xs font-semibold uppercase tracking-wide text-black/50">{label}</p>
      <p className="mt-2 text-3xl font-bold">{value}</p>
      {note && <p className="mt-1 text-xs text-black/55">{note}</p>}
    </Card>
  );
}

export function AdminDashboardPage() {
  const { user } = useAuth();
  const location = useLocation();
  const passwordChanged = (location.state as { passwordChanged?: boolean } | null)?.passwordChanged;
  const overview = useQuery({
    queryKey: ['admin', 'overview'],
    queryFn: () => api<AdminOverview>('/api/admin/overview'),
    refetchInterval: 30_000,
  });

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-ahly-red">Administrator</p>
          <h1 className="text-2xl font-bold sm:text-3xl">Welcome, {user?.fullName}</h1>
        </div>
        <Link
          to="/admin/status"
          className="text-sm font-semibold text-ischool-blue hover:underline"
        >
          System status →
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
              <p className="text-xs font-semibold uppercase tracking-wide text-black/50">
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
                <Link
                  to="/admin/rubric"
                  className="font-semibold text-ischool-blue hover:underline"
                >
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
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Active judges"
              value={overview.data.activeJudges}
              note="Manage accounts on the Users page"
            />
            <Stat label="Administrators" value={overview.data.activeAdmins} />
            <Stat
              label="Active teams"
              value={overview.data.activeTeams}
              note={`${overview.data.archivedTeams} archived`}
            />
            <Stat label="Submitted evaluations" value={overview.data.submittedEvaluations} />
          </div>
        </>
      )}
    </div>
  );
}
