import type { ReactNode } from 'react';
import { Button } from './ui';

/** A rank as a chip: gold, silver and bronze for ranks 1–3. Ties say so in words. */
export function RankChip({ rank, tied = false }: { rank: number; tied?: boolean }) {
  const tone =
    rank === 1
      ? 'bg-ahly-gold text-white'
      : rank === 2
        ? 'bg-slate-500 text-white'
        : rank === 3
          ? 'bg-amber-700 text-white'
          : 'bg-ischool-blue-soft text-ischool-blue-dark';
  return (
    <span className="inline-flex items-center gap-2">
      <span
        className={`inline-flex h-9 min-w-9 items-center justify-center rounded-xl px-2 text-base font-bold tabular-nums ${tone}`}
      >
        {rank}
      </span>
      {tied && (
        <span className="rounded-full bg-ischool-blue-soft px-2 py-0.5 text-xs font-semibold text-ischool-blue-dark ring-1 ring-ischool-blue/20 ring-inset">
          Tied
        </span>
      )}
    </span>
  );
}

/** The blue results banner at the top of both leaderboards. */
export function ResultsHero({
  eyebrow,
  title,
  description,
  updatedAt,
  refreshing,
  onRefresh,
  children,
}: {
  eyebrow: string;
  title: string;
  description: ReactNode;
  updatedAt?: string | null;
  refreshing: boolean;
  onRefresh: () => void;
  children?: ReactNode;
}) {
  return (
    <section className="results-hero overflow-hidden rounded-3xl bg-ischool-blue border-b-4 border-ahly-red text-white shadow-[0_24px_48px_-32px_#045bc4]">
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
              {eyebrow}
            </p>
            <h1 className="mt-1 text-3xl font-bold tracking-tight sm:text-4xl">{title}</h1>
            <p className="mt-2 text-sm text-white/85 sm:text-base">{description}</p>
          </div>
          <div className="flex items-center gap-3">
            {updatedAt && (
              <span className="text-xs text-white/80" aria-live="polite">
                Updated {updatedAt}
              </span>
            )}
            <Button
              variant="secondary"
              className="!border-white/30 !bg-white !text-ischool-blue-dark"
              onClick={onRefresh}
              disabled={refreshing}
            >
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </Button>
          </div>
        </div>
        {children && <div className="relative mt-6">{children}</div>}
      </div>
    </section>
  );
}

/** Small figures inside the results banner. */
export function HeroStats({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
      {items.map(([label, value]) => (
        <div
          key={label}
          className="rounded-2xl bg-white/12 px-4 py-3 ring-1 ring-white/20 ring-inset"
        >
          <dt className="text-xs text-white/80">{label}</dt>
          <dd className="text-2xl font-bold tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
