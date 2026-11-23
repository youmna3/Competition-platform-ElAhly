import { formatScore } from '@judging/shared';
import { Badge } from './ui';

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
/** Feature rank groups, including every team tied at the third rank. Never break ties. */
export function TopTeams({ teams }: { teams: Team[] }) {
  const featured = teams
    .filter((t) => t.rank <= 3)
    .sort((a, b) => a.rank - b.rank || a.teamCode.localeCompare(b.teamCode));
  if (!featured.length) return null;
  return (
    <section className="top-teams" aria-label="Leading eligible teams">
      <div className="flex items-center gap-3">
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="h-6 w-6 text-ischool-blue"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
        >
          <path d="M8 3h8v6a4 4 0 0 1-8 0V3Zm0 2H4v3a4 4 0 0 0 4 4m8-7h4v3a4 4 0 0 1-4 4M12 13v5m-4 3h8m-9-3h10" />
        </svg>
        <div>
          <p className="eyebrow">Competition leaders</p>
          <h2 className="text-xl font-bold">
            {featured.length >= 3 ? 'Top ranked teams' : 'Leading teams'}
          </h2>
        </div>
      </div>
      <div className="leaders-grid">
        {featured.map((t) => (
          <article key={t.teamId} className={`leader-card ${t.rank === 1 ? 'leader-first' : ''}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="leader-rank">#{t.rank}</span>
              <Badge tone={t.rank === 1 ? 'gold' : 'blue'}>
                {featured.filter((x) => x.rank === t.rank).length > 1 ? 'Shared rank' : 'Official'}
              </Badge>
            </div>
            <p className="mt-5 font-mono text-xs text-muted">{t.teamCode}</p>
            <h3 className="mt-1 text-xl font-bold">{t.name}</h3>
            <p className="mt-1 text-sm text-muted">{t.projectName}</p>
            <div className="mt-5 border-t border-line pt-4">
              <p className="text-3xl font-bold tracking-tight text-ischool-blue-dark">
                {formatScore(t.score)}{' '}
                <span className="text-base font-medium text-muted">/ {t.maximumScore ?? 100}</span>
              </p>
              <p className="mt-1 text-xs text-muted">
                Base {formatScore(t.baseAverage ?? t.score)} · Bonus +
                {formatScore(t.bonusAverage ?? 0)}
              </p>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
