import { describe, expect, it } from 'vitest';
import {
  defaultRubricContent,
  formatPoints,
  scoreEvaluation,
  sectionRating,
  sectionScore,
  totalWeight,
  validateRubric,
  type RubricContent,
} from '@judging/shared';

const rubric = (weights: (number | null)[] = [30, 30, 20, 20]): RubricContent => {
  const r = defaultRubricContent();
  r.title = 'Final rubric';
  r.sections.forEach((s, i) => (s.weightPercent = weights[i] ?? null));
  return r;
};

describe('scoring', () => {
  it('matches the competition example: 4 and 5 stars in a 30% section give 27', () => {
    expect(sectionRating([4, 5])).toBe(4.5);
    expect(sectionScore([4, 5], 30)).toBe(27);
  });

  it('gives 100 for all five stars and 20 for all one star', () => {
    const sections = rubric([35, 25, 25, 15]).sections;
    const all = (n: number) => sections.map(() => [n, n]);
    expect(scoreEvaluation(sections, all(5)).total).toBe(100);
    expect(scoreEvaluation(sections, all(1)).total).toBe(20);
  });

  it('adds the four weighted section scores exactly', () => {
    const sections = rubric([35, 25, 25, 15]).sections;
    const result = scoreEvaluation(sections, [
      [3, 4], // 3.5 / 5 × 35 = 24.5
      [5, 5], // 25
      [2, 3], // 2.5 / 5 × 25 = 12.5
      [1, 4], // 2.5 / 5 × 15 = 7.5
    ]);
    expect(result.sections.map((s) => s.score)).toEqual([24.5, 25, 12.5, 7.5]);
    expect(result.total).toBe(69.5);
  });

  it('has no total until every criterion is rated, and ignores invalid ratings', () => {
    const sections = rubric().sections;
    const partial = scoreEvaluation(sections, [
      [4, 5],
      [3, null],
      [5, 5],
      [6, 1],
    ]);
    expect(partial.sections.map((s) => s.score)).toEqual([27, null, 20, null]);
    expect(partial.total).toBeNull();
    expect(partial.base).toBe(47);
    expect(partial.bonus).toBe(0);
  });

  it('avoids floating-point drift and formats nicely', () => {
    expect(sectionScore([1, 2], 33)).toBe(9.9);
    expect(formatPoints(27)).toBe('27');
    expect(formatPoints(9.9)).toBe('9.9');
    expect(formatPoints(1 / 3)).toBe('0.33');
  });
});

describe('rubric validation', () => {
  it('starts from 4 sections of 2 criteria with no weights, saveable but not publishable', () => {
    const fresh = defaultRubricContent();
    expect(fresh.sections).toHaveLength(4);
    expect(fresh.sections.every((s) => s.criteria.length === 2 && s.weightPercent === null)).toBe(
      true,
    );
    const v = validateRubric(fresh);
    expect(v.save).toEqual([]);
    expect(v.publish.map((i) => i.path)).toEqual([
      'title',
      'sections.0.weightPercent',
      'sections.1.weightPercent',
      'sections.2.weightPercent',
      'sections.3.weightPercent',
    ]);
  });

  it('accepts any weights that total exactly 100, not just equal ones', () => {
    expect(validateRubric(rubric([30, 30, 20, 20]))).toEqual({ save: [], publish: [] });
    expect(validateRubric(rubric([70, 10, 10, 10]))).toEqual({ save: [], publish: [] });
  });

  it('reports the running total when weights do not add up to 100', () => {
    expect(totalWeight(rubric([35, 25, 25, 25]).sections)).toBe(110);
    expect(validateRubric(rubric([35, 25, 25, 25])).publish).toEqual([
      { path: 'weights', message: 'The section weights total 110%. They must total exactly 100%.' },
    ]);
    expect(validateRubric(rubric([25, 25, 25, 20])).publish[0]!.message).toMatch(/total 95%/);
  });

  it('refuses weights that are not whole numbers from 1 to 100', () => {
    for (const bad of [0, -5, 101, 12.5, Number.NaN]) {
      const v = validateRubric(rubric([bad, 30, 30, 40]));
      expect(v.save[0]!.path, String(bad)).toBe('sections.0.weightPercent');
    }
  });

  it('keeps the shape fixed and titles filled in', () => {
    const r = rubric();
    r.sections.pop();
    expect(validateRubric(r).save[0]!.message).toBe('The rubric must have exactly 4 sections.');
    const c = rubric();
    c.sections[2]!.criteria.pop();
    expect(validateRubric(c).save[0]!.path).toBe('sections.2.criteria');
    const t = rubric();
    t.sections[0]!.criteria[0]!.title = ' ';
    expect(validateRubric(t).save[0]!.message).toBe(
      'Section 1 “Section 1”, criterion 1 needs a title.',
    );
  });
});
