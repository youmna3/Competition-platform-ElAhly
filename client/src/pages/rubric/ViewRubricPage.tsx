import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import type { PublishedRubricResponse } from '@judging/shared';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Alert, Card } from '../../components/ui';
import { FullPageSpinner } from '../../components/FullPageSpinner';
import { RubricView } from './RubricView';

const formatDate = (value: string) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value));

/** Read-only rubric for judges and administrators. */
export function ViewRubricPage() {
  const { user } = useAuth();
  const query = useQuery({
    queryKey: ['judge', 'rubric'],
    queryFn: () => api<PublishedRubricResponse>('/api/judge/rubric'),
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">Judging rubric</p>
          <h1 className="sr-only">Judging rubric</h1>
          <p className="text-sm text-black/60">Read-only. Every team is judged with this rubric.</p>
        </div>
        {user?.role === 'admin' && (
          <Link
            to="/admin/rubric"
            className="text-sm font-semibold text-ischool-blue-dark hover:underline"
          >
            Manage the rubric →
          </Link>
        )}
      </div>
      {query.isPending ? (
        <FullPageSpinner label="Loading the rubric…" />
      ) : query.isError ? (
        <Alert tone="error" title="Could not load the rubric">
          {query.error.message}
        </Alert>
      ) : query.data.rubric == null ? (
        <Card className="py-12 text-center">
          <p className="text-lg font-semibold">The rubric hasn’t been published yet</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-black/60">
            Judging isn’t available until the competition administrator publishes the rubric. Check
            back later.
          </p>
        </Card>
      ) : (
        <RubricView
          rubric={query.data.rubric}
          meta={
            query.data.rubric.publishedAt
              ? `Published ${formatDate(query.data.rubric.publishedAt)}`
              : undefined
          }
        />
      )}
    </div>
  );
}
