import { useState } from 'react';
import {
  formatPoints,
  isPointsRubric,
  maximumScore,
  sectionPoints,
  sectionMaximum,
  scoreEvaluation,
  totalWeight,
  type RubricContent,
} from '@judging/shared';
import { PointsInput, PointsValue } from '../../components/PointsInput';
import { StarRating } from '../../components/StarRating';
import { Badge, Card } from '../../components/ui';

const SEGMENT_COLORS = ['bg-ischool-blue', 'bg-ischool-blue-dark', 'bg-ahly-gold', 'bg-ink'];

/**
 * Read-only rubric, exactly as judges see it. With `practice`, the stars can be
 * clicked to try the scoring (admin preview only; nothing is saved).
 */
export function RubricView({
  rubric,
  meta,
  practice = false,
}: {
  rubric: RubricContent;
  meta?: string;
  practice?: boolean;
}) {
  const [ratings, setRatings] = useState<(number | null)[][]>(() =>
    rubric.sections.map((s) => s.criteria.map(() => null)),
  );
  const points = isPointsRubric(rubric);
  const breakdown = scoreEvaluation(rubric.sections, ratings);
  // Points rubrics: a section's size is the sum of its criterion maxima.
  const sizeOf = (s: RubricContent['sections'][number]) =>
    points ? sectionPoints(s) : (s.weightPercent ?? 0);
  const weightsSet = points || rubric.sections.every((s) => s.weightPercent != null);
  const firstWeight = points ? null : (rubric.sections[0]?.weightPercent ?? null);
  const total = points
    ? rubric.sections.reduce((n, s) => n + sectionPoints(s), 0)
    : totalWeight(rubric.sections);
  const practiceTotal = points
    ? ratings.every((row) => row.every((v) => v != null))
      ? ratings.flat().reduce<number>((n, v) => n + (v ?? 0), 0)
      : null
    : breakdown.total;

  function rate(i: number, j: number, value: number | null) {
    setRatings((prev) =>
      prev.map((row, a) => (a === i ? row.map((v, b) => (b === j ? value : v)) : row)),
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-2xl font-bold sm:text-3xl">{rubric.title || 'Untitled rubric'}</h2>
        {meta && <p className="mt-1 text-sm text-muted">{meta}</p>}
        {rubric.description && (
          <p className="mt-2 max-w-3xl whitespace-pre-wrap text-black/70">{rubric.description}</p>
        )}
      </div>

      <Card className="space-y-4">
        <div>
          <p className="text-xs font-semibold tracking-wide text-muted uppercase">
            How scoring works
          </p>
          <p className="mt-1 text-sm text-black/70">
            {rubric.sections.length} sections ·{' '}
            {rubric.sections.reduce((n, s) => n + s.criteria.length, 0)} criteria ·{' '}
            {points ? 'each scored 0 to its maximum points' : 'each rated 1–5 stars'} · final score
            out of <strong>{points ? total : maximumScore(rubric.sections)}</strong>
          </p>
        </div>
        {points ? (
          <ul className="space-y-1 text-sm text-black/70">
            <li>Each criterion gets a whole number of points from 0 to its maximum.</li>
            <li>Section score = the sum of its criterion points.</li>
            <li>Final score = the sum of all section scores.</li>
          </ul>
        ) : (
          <ul className="space-y-1 text-sm text-black/70">
            <li>Section rating = average of the section’s two star ratings.</li>
            <li>Section score = section rating ÷ 5 × the section’s weight.</li>
            <li>
              Combined score = all Actual section scores plus awarded Bonus points. Untouched Bonus
              sections award zero; complete all questions when started.
            </li>
          </ul>
        )}
        {firstWeight != null && (
          <p className="rounded-xl bg-ahly-gold-light/50 px-3.5 py-2 text-sm text-amber-950">
            Each question in the first section contributes up to{' '}
            <strong>
              {formatPoints(firstWeight / Math.max(1, rubric.sections[0]!.criteria.length))}
            </strong>{' '}
            points. Its section maximum remains {firstWeight} points.
          </p>
        )}
        {weightsSet && (
          <div>
            <div
              className="flex h-3 overflow-hidden rounded-full bg-black/10"
              role="img"
              aria-label={`Section ${points ? 'points' : 'weights'}: ${rubric.sections.map((s) => `${s.title} ${sizeOf(s)}${points ? ' points' : '%'}`).join(', ')}`}
            >
              {rubric.sections.map((s, i) => (
                <div
                  key={i}
                  className={SEGMENT_COLORS[i % SEGMENT_COLORS.length]}
                  style={{ width: `${(100 * sizeOf(s)) / Math.max(total, 100)}%` }}
                />
              ))}
            </div>
            <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-black/65">
              {rubric.sections.map((s, i) => (
                <li key={i} className="flex items-center gap-1.5">
                  <span
                    className={`h-2.5 w-2.5 rounded-full ${SEGMENT_COLORS[i % SEGMENT_COLORS.length]}`}
                  />
                  {s.title} {sizeOf(s)}
                  {points ? ' pts' : '%'}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      {rubric.instructions && (
        <Card>
          <h3 className="font-semibold">Instructions for judges</h3>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-black/75">
            {rubric.instructions}
          </p>
        </Card>
      )}

      {rubric.sections.map((s, i) => {
        const part = breakdown.sections[i];
        return (
          <Card key={i} className="!p-0">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-black/5 px-5 py-4 sm:px-6">
              <div className="min-w-0">
                <p className="text-xs font-semibold tracking-wide text-muted uppercase">
                  Section {i + 1}
                </p>
                <h3 className="text-lg font-bold">{s.title || 'Untitled section'}</h3>
                {s.description && (
                  <p className="mt-1 whitespace-pre-wrap text-sm text-black/65">{s.description}</p>
                )}
              </div>
              <div className="shrink-0 text-right">
                {points ? (
                  <Badge tone="blue">{sectionPoints(s)} points</Badge>
                ) : s.weightPercent != null || s.type === 'bonus' ? (
                  <Badge tone="blue">
                    {s.type === 'bonus'
                      ? `Bonus +${s.maxBonusPoints} maximum`
                      : `${s.weightPercent}% of base`}
                  </Badge>
                ) : (
                  <Badge tone="gray">Weight not set</Badge>
                )}
                {practice && points && ratings[i]!.some((v) => v != null) && (
                  <p className="mt-1 text-sm">
                    Section score{' '}
                    <strong>
                      {ratings[i]!.reduce<number>((n, v) => n + (v ?? 0), 0)} / {sectionPoints(s)}
                    </strong>
                  </p>
                )}
                {practice && !points && part?.score != null && (
                  <p className="mt-1 text-sm">
                    Section score{' '}
                    <strong>
                      {formatPoints(part.score)} / {sectionMaximum(s)}
                    </strong>
                  </p>
                )}
              </div>
            </div>
            <ol className="divide-y divide-black/5">
              {s.criteria.map((c, j) => (
                <li key={j} className="space-y-2 px-5 py-4 sm:px-6">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-semibold">
                      {points ? `${String.fromCharCode(65 + i)}.${j + 1}` : `${i + 1}.${j + 1}`}{' '}
                      {c.title || 'Untitled criterion'}
                    </p>
                    {points && c.maxPoints != null ? (
                      practice ? (
                        <PointsInput
                          label={`Points for ${c.title || `criterion ${i + 1}.${j + 1}`}`}
                          value={ratings[i]?.[j] ?? null}
                          max={c.maxPoints}
                          onChange={(v) => rate(i, j, v)}
                        />
                      ) : (
                        <PointsValue value={null} max={c.maxPoints} />
                      )
                    ) : practice ? (
                      <StarRating
                        label={`Rating for ${c.title || `criterion ${i + 1}.${j + 1}`}`}
                        value={ratings[i]?.[j] ?? null}
                        onChange={(v) => rate(i, j, v)}
                      />
                    ) : (
                      <StarRating label={c.title || `Criterion ${i + 1}.${j + 1}`} />
                    )}
                  </div>
                  {c.description && (
                    <p className="whitespace-pre-wrap text-sm text-black/70">{c.description}</p>
                  )}
                  {c.guidelines && (
                    <div className="rounded-xl bg-blue-50/70 px-3.5 py-2.5 text-sm">
                      <p className="text-xs font-semibold tracking-wide text-blue-900 uppercase">
                        Judging guidelines
                      </p>
                      <p className="mt-0.5 whitespace-pre-wrap text-blue-950/85">{c.guidelines}</p>
                    </div>
                  )}
                </li>
              ))}
            </ol>
          </Card>
        );
      })}

      {practice && (
        <Card className="flex flex-wrap items-center justify-between gap-3 border-ischool-blue/20">
          <div>
            <p className="font-semibold">Practice score</p>
            <p className="text-xs text-muted">
              {points ? 'Enter points' : 'Click the stars'} to try the scoring. Nothing is saved.
            </p>
          </div>
          <p className="text-2xl font-bold text-ischool-blue-dark" aria-live="polite">
            {practiceTotal != null ? formatPoints(practiceTotal) : '—'}{' '}
            <span className="text-base text-muted">
              / {points ? total : maximumScore(rubric.sections)}
            </span>
          </p>
        </Card>
      )}
    </div>
  );
}
