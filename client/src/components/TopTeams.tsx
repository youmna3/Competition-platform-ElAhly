import { formatScore } from '@judging/shared';

type Team = {
  teamId: number;
  teamCode: string;
  name: string;
  projectName: string;
  rank: number;
  score: number;
  maximumScore?: number | null;
  baseAverage?: number | null;
  bonusAverage?: number | null;
};

const MEDAL: Record<number, { ring: string; chip: string; label: string }> = {
  1: {
    ring: 'border-ahly-gold shadow-[0_18px_40px_-24px_#b07d0c]',
    chip: 'bg-ahly-gold text-white',
    label: '1st place',
  },
  2: { ring: 'border-slate-300', chip: 'bg-slate-500 text-white', label: '2nd place' },
  3: { ring: 'border-amber-700/40', chip: 'bg-amber-700 text-white', label: '3rd place' },
};

function LeaderCard({ team, tied, hero }: { team: Team; tied: boolean; hero: boolean }) {
  const medal = MEDAL[team.rank] ?? MEDAL[3]!;
  const bonus = team.bonusAverage ?? 0;
  return (
    <article
      className={`leader-card relative flex min-w-0 flex-col rounded-2xl border-2 bg-white p-5 sm:p-6 ${medal.ring} ${
        hero ? 'leader-first md:-translate-y-3 md:pb-8' : ''
      }`}
      aria-label={`${tied ? 'Shared ' : ''}rank ${team.rank}: ${team.name}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span
          className={`leader-rank inline-flex h-11 min-w-11 items-center justify-center rounded-xl px-2 text-lg font-bold ${medal.chip}`}
        >
          #{team.rank}
        </span>
        <span className="text-xs font-semibold tracking-wide text-muted uppercase">
          {tied ? 'Shared rank' : medal.label}
        </span>
      </div>
      <p className="mt-5 font-mono text-xs text-muted">{team.teamCode}</p>
      <h3 className={`mt-1 font-bold text-ink ${hero ? 'text-2xl' : 'text-xl'}`}>{team.name}</h3>
      <p className="mt-1 text-sm text-muted">{team.projectName}</p>
      <div className="mt-auto border-t border-line pt-4">
        <p
          className={`font-bold tracking-tight text-ischool-blue-dark tabular-nums ${hero ? 'text-4xl' : 'text-3xl'}`}
        >
          {formatScore(team.score)}{' '}
          <span className="text-base font-medium text-muted">/ {team.maximumScore ?? 100}</span>
        </p>
        {bonus > 0 && (
          <p className="mt-1 text-xs text-muted">
            Base {formatScore(team.baseAverage ?? team.score)} · Bonus +{formatScore(bonus)}
          </p>
        )}
      </div>
    </article>
  );
}

/**
 * The leading teams. Every team at rank 1–3 is shown, ties included, and a tie
 * is never broken. A podium (2nd · 1st · 3rd) is used only for three distinct
 * ranks; one or two teams, and any ties, use a simple row without empty places.
 */
export function TopTeams({ teams }: { teams: Team[] }) {
  const featured = teams
    .filter((t) => t.rank <= 3)
    .sort((a, b) => a.rank - b.rank || a.teamCode.localeCompare(b.teamCode));
  if (!featured.length) return null;
  const count = (rank: number) => featured.filter((t) => t.rank === rank).length;
  const podium = featured.length === 3 && featured.every((t, i) => t.rank === i + 1);
  const ordered = podium ? [featured[1]!, featured[0]!, featured[2]!] : featured;
  const columns =
    ordered.length === 1
      ? 'mx-auto max-w-md'
      : ordered.length === 2
        ? 'md:grid-cols-2'
        : 'md:grid-cols-3';
  return (
    <section
      className="top-teams rounded-3xl border border-ischool-blue/15 bg-gradient-to-b from-ischool-blue-soft to-white p-5 sm:p-7"
      aria-label="Leading eligible teams"
    >
      <div className="flex items-center gap-3">
        <span className="inline-flex size-10 items-center justify-center rounded-xl bg-ahly-red text-white">
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            className="h-5 w-5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
          >
            <path d="M8 3h8v6a4 4 0 0 1-8 0V3Zm0 2H4v3a4 4 0 0 0 4 4m8-7h4v3a4 4 0 0 1-4 4M12 13v5m-4 3h8m-9-3h10" />
          </svg>
        </span>
        <div>
          <p className="eyebrow">Competition leaders</p>
          <h2 className="text-xl font-bold">
            {featured.length >= 3 ? 'Top ranked teams' : 'Leading teams'}
          </h2>
        </div>
      </div>
      <div className={`leaders-grid mt-6 grid items-end gap-4 ${columns}`}>
        {ordered.map((t) => (
          <div key={t.teamId} className={podium && t.rank !== 1 ? 'md:mt-6' : ''}>
            <LeaderCard team={t} tied={count(t.rank) > 1} hero={t.rank === 1 && count(1) === 1} />
          </div>
        ))}
      </div>
    </section>
  );
}
