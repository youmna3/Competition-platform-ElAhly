import { useQuery } from '@tanstack/react-query';
import type { HealthResponse } from '@judging/shared';
import { fetchHealth } from '../api/health';

type Tone = 'ok' | 'error' | 'pending';

const toneStyles: Record<Tone, { dot: string; badge: string; label: string }> = {
  ok: {
    dot: 'bg-emerald-500',
    badge: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
    label: 'Connected',
  },
  error: {
    dot: 'bg-ahly-red',
    badge: 'bg-red-50 text-ahly-red-dark ring-ahly-red/25',
    label: 'Not connected',
  },
  pending: {
    dot: 'bg-black/30 animate-pulse',
    badge: 'bg-black/5 text-black/60 ring-black/10',
    label: 'Checking…',
  },
};

function StatusBadge({ tone, label }: { tone: Tone; label?: string }) {
  const style = toneStyles[tone];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${style.badge}`}
    >
      <span className={`h-2 w-2 rounded-full ${style.dot}`} aria-hidden />
      {label ?? style.label}
    </span>
  );
}

function StatusTile({
  title,
  tone,
  children,
}: {
  title: string;
  tone: Tone;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className="ui-card min-w-0 rounded-2xl border border-line bg-white p-5 shadow-card"
      data-tone={tone}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-semibold">{title}</h3>
        <StatusBadge tone={tone} />
      </div>
      <div className="space-y-1 text-sm text-black/70">{children}</div>
    </section>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <p className="flex min-w-0 justify-between gap-4">
      <span className="text-muted">{label}</span>
      <span className="min-w-0 truncate text-right font-medium text-ink">{value}</span>
    </p>
  );
}

export function HealthPanel({ refreshMs = 10_000 }: { refreshMs?: number }) {
  const query = useQuery<HealthResponse>({
    queryKey: ['health'],
    queryFn: ({ signal }) => fetchHealth(signal),
    refetchInterval: refreshMs,
    retry: false,
  });

  const health = query.data;
  const apiTone: Tone = query.isPending ? 'pending' : query.isError ? 'error' : 'ok';
  const db = health?.database;
  const dbTone: Tone = query.isPending ? 'pending' : !db || db.status !== 'ok' ? 'error' : 'ok';
  const checkedAt = query.dataUpdatedAt || query.errorUpdatedAt;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <StatusTile title="API server" tone={apiTone}>
          {query.isError ? (
            <>
              <p className="text-ahly-red-dark">{query.error.message}.</p>
              <p>
                Start it with <code className="rounded bg-black/5 px-1">npm run dev</code> in the
                project folder.
              </p>
            </>
          ) : health ? (
            <>
              <Detail label="Uptime" value={`${health.app.uptimeSeconds} s`} />
            </>
          ) : (
            <p>Contacting the API…</p>
          )}
        </StatusTile>

        <StatusTile title="XAMPP MySQL database" tone={dbTone}>
          {db?.status === 'ok' ? (
            <>
              <Detail label="Response time" value={`${db.latencyMs} ms`} />
            </>
          ) : db?.status === 'error' ? (
            <>
              <p className="font-medium text-ahly-red-dark">
                Database unavailable. Contact the platform administrator.
              </p>
            </>
          ) : query.isError ? (
            <p>Unknown until the API server is running.</p>
          ) : (
            <p>Waiting for the API…</p>
          )}
        </StatusTile>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted">
        <span aria-live="polite">
          {checkedAt
            ? `Last checked ${new Date(checkedAt).toLocaleTimeString()} · refreshes every ${refreshMs / 1000} s`
            : 'Not checked yet'}
        </span>
        <button
          type="button"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
          className="action-link disabled:opacity-60"
        >
          {query.isFetching ? 'Checking…' : 'Check again'}
        </button>
      </div>
    </div>
  );
}
