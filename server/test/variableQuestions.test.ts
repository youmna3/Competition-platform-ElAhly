import { expect, it } from 'vitest';
import { defaultRubricContent, scoreEvaluation, validateRubric, rankTeams } from '@judging/shared';
it.each([1, 2, 3, 4, 5, 10])('scores and validates %i equally weighted questions', (count) => {
  const r = defaultRubricContent();
  r.scoringFormat = 3;
  r.title = 'Flexible';
  r.sections.forEach((s) => {
    s.weightPercent = 25;
    s.criteria = Array.from({ length: count }, (_, i) => ({
      title: `Q${i}`,
      description: '',
      guidelines: '',
    }));
  });
  expect(validateRubric(r)).toEqual({ save: [], publish: [] });
  expect(
    scoreEvaluation(
      r.sections,
      r.sections.map(() => Array(count).fill(5)),
    ).total,
  ).toBe(100);
  r.sections[0]!.criteria = [];
  expect(validateRubric(r).save.length).toBeGreaterThan(0);
});
it('uses the stated Actual/Bonus examples and requires every started Bonus question', () => {
  const section = { weightPercent: 20, criteria: Array(4).fill({}) };
  expect(scoreEvaluation([section], [[5, 4, 3, 4]]).total).toBe(16);
  const bonus = { ...section, type: 'bonus' as const, weightPercent: null, maxBonusPoints: 10 };
  expect(scoreEvaluation([bonus], [[5, 4, 3, 4]]).bonus).toBe(8);
  expect(scoreEvaluation([bonus], [[null, null, null, null]]).total).toBe(0);
  expect(scoreEvaluation([bonus], [[5, null, null, null]]).total).toBeNull();
});
it('does not round section contributions or full-precision ranking averages', () => {
  const score = scoreEvaluation(
    [{ weightPercent: 100, criteria: Array(3).fill({}) }],
    [[1, 1, 2]],
  ).total!;
  expect(score).toBe(80 / 3);
  const ranked = rankTeams([
    { sumThousandths: 1680001, scale: 63000, judges: 1, tieOrder: 'B' },
    { sumThousandths: 1680000, scale: 63000, judges: 1, tieOrder: 'A' },
  ]);
  expect(ranked.map((t) => t.rank)).toEqual([1, 2]);
  expect(ranked[0]!.tieOrder).toBe('B');
});
