import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import type { JudgeProgressResponse, JudgeProgressRow } from '@judging/shared';
import { api } from '../../../api/client';
import { FullPageSpinner } from '../../../components/FullPageSpinner';
import { Alert, Badge, Card, SelectField } from '../../../components/ui';
import { EvaluationsHeader, formatDateTime } from './EvaluationsPage';

function Completion({ row }: { row: JudgeProgressRow }) {
  if (row.completionPercent == null) return <span className="text-sm text-black/45">No teams</span>;
  const pct = row.completionPercent;
  return (
    <div className="min-w-[110px]">
      <div className="flex justify-between text-xs text-black/60 tabular-nums">
        <span>
          {row.submitted}/{row.assignedTeams}
        </span>
        <span>{pct}%</span>
      </div>
      <div
        className="mt-1 h-1.5 overflow-hidden rounded-full bg-black/10"
        role="progressbar"
        aria-label={`${row.fullName}: ${pct}% submitted`}
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={`h-full ${pct === 100 ? 'bg-emerald-600' : 'bg-ahly-red'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function Name({ row }: { row: JudgeProgressRow }) {
  return (
    <div className="min-w-0">
      <Link
        to={`/admin/evaluations?judgeId=${row.judgeId}`}
        className="font-semibold hover:underline"
        aria-label={`Show ${row.fullName}’s teams`}
      >
        {row.fullName}
      </Link>{' '}
      {row.role === 'admin' && <Badge tone="red">Admin</Badge>}{' '}
      {row.accountStatus === 'disabled' && <Badge tone="gray">Disabled</Badge>}
      <p className="text-sm break-all text-black/60">{row.email}</p>
    </div>
  );
}

export function JudgeProgressPage() {
  const [search, setSearch] = useState('');
  const [completion, setCompletion] = useState('');
  const query = new URLSearchParams();
  if (search.trim()) query.set('search', search.trim());
  if (completion) query.set('completion', completion);
  const progress = useQuery({
    queryKey: ['admin', 'judge-progress', query.toString()],
    queryFn: () => api<JudgeProgressResponse>(`/api/admin/judge-progress?${query}`),
    placeholderData: keepPreviousData,
  });
  const rows = progress.data?.judges ?? [];

  return (
    <div className="space-y-6">
      <EvaluationsHeader />
      <Card className="grid gap-3 !p-4 sm:grid-cols-[1fr_220px]">
        <div className="space-y-1.5">
          <label htmlFor="progress-search" className="block text-sm font-medium">
            Judge
          </label>
          <input
            id="progress-search"
            type="search"
            value={search}
            maxLength={100}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Name or e-mail"
            className="block w-full rounded-xl border border-black/15 bg-white px-3.5 py-2.5 text-base shadow-sm outline-none focus:border-ischool-blue focus:ring-4 focus:ring-ischool-blue/15 sm:text-sm"
          />
        </div>
        <SelectField
          label="Completion"
          value={completion}
          onChange={(e) => setCompletion(e.target.value)}
        >
          <option value="">All judges</option>
          <option value="complete">All submitted</option>
          <option value="incomplete">Still pending</option>
          <option value="not_started">Not started</option>
          <option value="no_teams">No teams assigned</option>
        </SelectField>
      </Card>
      <p className="text-sm text-black/55">
        Counts use current assignments to active teams. Evaluations of archived teams or teams a
        judge is no longer assigned to are kept, and counted under “Other”.
      </p>

      {progress.isPending ? (
        <FullPageSpinner label="Loading judge progress…" />
      ) : progress.isError ? (
        <Alert tone="error" title="Could not load judge progress">
          {progress.error.message}
        </Alert>
      ) : rows.length === 0 ? (
        <Card className="py-12 text-center">
          <p className="text-lg font-semibold">No judges match</p>
        </Card>
      ) : (
        <>
          <Card className="hidden overflow-x-auto !p-0 md:block">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-black/5 text-xs tracking-wide text-black/50 uppercase">
                <tr>
                  <th scope="col" className="px-5 py-3 font-semibold">
                    Judge
                  </th>
                  <th scope="col" className="px-3 py-3 text-right font-semibold">
                    Teams
                  </th>
                  <th scope="col" className="px-3 py-3 text-right font-semibold">
                    Not started
                  </th>
                  <th scope="col" className="px-3 py-3 text-right font-semibold">
                    Draft
                  </th>
                  <th scope="col" className="px-3 py-3 text-right font-semibold">
                    Submitted
                  </th>
                  <th scope="col" className="px-3 py-3 font-semibold">
                    Completion
                  </th>
                  <th scope="col" className="px-3 py-3 font-semibold">
                    Last submission
                  </th>
                  <th scope="col" className="px-5 py-3 text-right font-semibold">
                    Other
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-black/5">
                {rows.map((r) => (
                  <tr
                    key={r.judgeId}
                    className={r.accountStatus === 'disabled' ? 'text-black/55' : ''}
                  >
                    <td className="px-5 py-3">
                      <Name row={r} />
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">{r.assignedTeams}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{r.notStarted}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{r.draft}</td>
                    <td className="px-3 py-3 text-right font-semibold tabular-nums">
                      {r.submitted}
                    </td>
                    <td className="px-3 py-3">
                      <Completion row={r} />
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap text-black/65">
                      {formatDateTime(r.lastSubmittedAt)}
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums text-black/55">
                      {r.otherEvaluations}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <ul className="space-y-3 md:hidden">
            {rows.map((r) => (
              <li key={r.judgeId}>
                <Card className="space-y-3 !p-4">
                  <Name row={r} />
                  <Completion row={r} />
                  <p className="text-xs text-black/60 tabular-nums">
                    {r.notStarted} not started · {r.draft} draft · {r.submitted} submitted
                    {r.otherEvaluations > 0 && ` · ${r.otherEvaluations} other`}
                  </p>
                  <p className="text-xs text-black/50">
                    Last submission: {formatDateTime(r.lastSubmittedAt)}
                  </p>
                </Card>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
