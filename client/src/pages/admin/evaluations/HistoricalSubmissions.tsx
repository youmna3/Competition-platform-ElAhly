import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api } from '../../../api/client';
import { Alert, Card, TextField } from '../../../components/ui';

export function HistoricalSubmissions() {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const query = useQuery({
    queryKey: ['admin', 'historical', search],
    queryFn: () =>
      api<{ evaluations: { id: number; teamCode: string; teamName: string; judgeName: string }[] }>(
        `/api/admin/evaluations/historical?${new URLSearchParams({ search })}`,
      ),
    enabled: open,
  });
  return (
    <Card>
      <details onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary className="cursor-pointer font-semibold text-ischool-blue-dark">
          Historical submissions
        </summary>
        {open && (
          <div className="mt-4 space-y-3">
            <p className="text-sm text-muted">
              Archived teams and unassigned judges. Corrections do not restore ranking eligibility.
              Showing up to 200 results; search to find a submission.
            </p>
            <TextField
              label="Find historical submissions"
              value={search}
              maxLength={100}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Team ID, team or judge"
            />
            {query.isPending ? (
              <p role="status">Loading historical submissions…</p>
            ) : query.isError ? (
              <Alert tone="error">{query.error.message}</Alert>
            ) : query.data?.evaluations.length ? (
              <ul className="space-y-2">
                {query.data.evaluations.map((e) => (
                  <li key={e.id}>
                    <Link
                      className="text-sm font-semibold text-ischool-blue-dark hover:underline"
                      to={`/admin/evaluations/${e.id}`}
                    >
                      {e.teamCode} · {e.teamName} · {e.judgeName}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">No historical submissions match.</p>
            )}
          </div>
        )}
      </details>
    </Card>
  );
}
