import { describe, expect, it } from 'vitest';
import {
  defaultRubricContent,
  scoreEvaluation,
  validateRubric,
  totalWeight,
} from '@judging/shared';

const dynamic = () => {
  const r = defaultRubricContent();
  r.scoringFormat = 2;
  r.title = 'Dynamic';
  r.sections.forEach((s) => (s.weightPercent = 25));
  return r;
};
describe('versioned Actual and Bonus scoring', () => {
  it('adds a fifth Actual section only after weights are rebalanced', () => {
    const r = dynamic();
    r.sections.push(structuredClone(r.sections[0]!));
    expect(validateRubric(r).publish[0]?.message).toContain('125%');
    r.sections.forEach((s) => (s.weightPercent = 20));
    expect(validateRubric(r)).toEqual({ save: [], publish: [] });
    r.sections[0]!.weightPercent = 19;
    expect(validateRubric(r).publish[0]?.message).toContain('99%');
  });
  it('separates proportional bonus points and never caps combined at 100', () => {
    const r = dynamic();
    r.sections.push({
      ...structuredClone(r.sections[0]!),
      type: 'bonus',
      weightPercent: null,
      maxBonusPoints: 10,
    });
    expect(totalWeight(r.sections)).toBe(100);
    const full = scoreEvaluation(r.sections, [
      [5, 5],
      [5, 5],
      [5, 5],
      [5, 5],
      [3, 4],
    ]);
    expect(full).toMatchObject({ base: 100, bonus: 7, total: 107, maximum: 110 });
    const example = scoreEvaluation(r.sections, [
      [4, 4],
      [4, 5],
      [4, 5],
      [4, 4],
      [3, 4],
    ]);
    expect(example).toMatchObject({ base: 85, bonus: 7, total: 92 });
  });
  it('allows untouched bonus, rejects incomplete/invalid started bonus', () => {
    const r = dynamic();
    r.sections.push({
      ...structuredClone(r.sections[0]!),
      type: 'bonus',
      weightPercent: null,
      maxBonusPoints: 10,
    });
    const stars = [
      [5, 5],
      [5, 5],
      [5, 5],
      [5, 5],
    ];
    expect(scoreEvaluation(r.sections, [...stars, [null, null]]).total).toBe(100);
    expect(scoreEvaluation(r.sections, [...stars, [5, null]]).total).toBeNull();
    expect(scoreEvaluation(r.sections, [...stars, [6, 5]]).total).toBeNull();
  });
  it('requires explicit bonus limits and preserves the legacy four-section validator', () => {
    const r = dynamic();
    r.sections.push({ ...structuredClone(r.sections[0]!), type: 'bonus', weightPercent: null });
    expect(validateRubric(r).publish.some((p) => p.path.endsWith('maxBonusPoints'))).toBe(true);
    for (const invalid of [0, -1, 101, 1.5]) {
      r.sections[4]!.maxBonusPoints = invalid;
      expect(validateRubric(r).save.some((p) => p.path.endsWith('maxBonusPoints'))).toBe(true);
    }
    r.scoringFormat = 1;
    expect(validateRubric(r).save[0]?.message).toContain('exactly 4');
  });
});
