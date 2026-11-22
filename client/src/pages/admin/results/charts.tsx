/**
 * Small, dependency-free charts for the dashboard. Each chart has a legend with
 * the numbers (identity never relies on colour alone), a hover title on every
 * segment, and an equivalent table for screen readers.
 */
export interface Segment {
  key: string;
  label: string;
  value: number;
  /** Tailwind background class for the segment and its legend swatch. */
  color: string;
}

export function StackedBar({ title, segments }: { title: string; segments: Segment[] }) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  const pct = (v: number) => (total ? Math.round((v / total) * 1000) / 10 : 0);
  return (
    <figure className="space-y-3">
      <figcaption className="text-sm font-semibold">{title}</figcaption>
      <div
        className="flex h-4 w-full gap-0.5 overflow-hidden rounded-full bg-black/5"
        aria-hidden="true"
      >
        {segments
          .filter((s) => s.value > 0)
          .map((s) => (
            <div
              key={s.key}
              className={`${s.color} h-full first:rounded-l-full last:rounded-r-full`}
              style={{ width: `${(s.value / total) * 100}%` }}
              title={`${s.label}: ${s.value} (${pct(s.value)}%)`}
            />
          ))}
      </div>
      <ul className="flex flex-wrap gap-x-5 gap-y-1.5 text-sm" aria-hidden="true">
        {segments.map((s) => (
          <li key={s.key} className="flex items-center gap-2">
            <span className={`inline-block size-2.5 rounded-full ${s.color}`} />
            <span className="text-black/70">{s.label}</span>
            <span className="font-semibold tabular-nums">{s.value}</span>
          </li>
        ))}
      </ul>
      <table className="sr-only">
        <caption>{title}</caption>
        <tbody>
          {segments.map((s) => (
            <tr key={s.key}>
              <th scope="row">{s.label}</th>
              <td>
                {s.value} ({pct(s.value)}%)
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

export interface ProgressRow {
  key: string;
  label: string;
  done: number;
  draft: number;
  total: number;
  note?: string;
}

/** One thin bar per row: submitted, then drafts, out of the assigned total. */
export function ProgressBars({ title, rows }: { title: string; rows: ProgressRow[] }) {
  return (
    <figure className="space-y-3">
      <figcaption className="text-sm font-semibold">{title}</figcaption>
      <ul className="space-y-2.5">
        {rows.map((r) => (
          <li key={r.key} className="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-3">
            <span className="truncate text-sm" title={r.label}>
              {r.label}
              {r.note && <span className="text-muted"> {r.note}</span>}
            </span>
            <div
              className="flex h-2.5 gap-0.5 overflow-hidden rounded-full bg-black/5"
              role="img"
              aria-label={`${r.label}: ${r.done} of ${r.total} submitted, ${r.draft} in draft`}
            >
              {r.done > 0 && (
                <div
                  className="h-full rounded-l-full bg-emerald-600 last:rounded-r-full"
                  style={{ width: `${(r.done / r.total) * 100}%` }}
                  title={`Submitted: ${r.done}`}
                />
              )}
              {r.draft > 0 && (
                <div
                  className="h-full bg-ahly-gold first:rounded-l-full last:rounded-r-full"
                  style={{ width: `${(r.draft / r.total) * 100}%` }}
                  title={`Draft: ${r.draft}`}
                />
              )}
            </div>
            <span className="text-sm tabular-nums text-black/70">
              {r.done}/{r.total}
            </span>
          </li>
        ))}
      </ul>
    </figure>
  );
}
