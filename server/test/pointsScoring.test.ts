import { describe, expect, it } from 'vitest';
import {
  isValidRating,
  officialRubric2026,
  pointMaxima,
  scoreEvaluation,
  sectionMaximum,
  validateRubric,
  type RubricContent,
} from '@judging/shared';

const official = officialRubric2026();
const sections = official.sections;
const full = sections.map((s) => s.criteria.map((c) => c.maxPoints!));

describe('official 2026 rubric', () => {
  it('has 4 sections, 12 criteria and section totals 30, 25, 25 and 20', () => {
    expect(official.scoringFormat).toBe(4);
    expect(sections.map((s) => s.title)).toEqual([
      'Prompt Engineering & Logic',
      'UI/UX & Design',
      'Problem Solving & Utility',
      'Pitch & Presentation',
    ]);
    expect(sections.flatMap((s) => s.criteria)).toHaveLength(12);
    expect(sections.map((s) => sectionMaximum(s))).toEqual([30, 25, 25, 20]);
    expect(sections.flatMap((s) => s.criteria.map((c) => c.maxPoints))).toEqual([
      10, 10, 10, 10, 8, 7, 7, 8, 10, 8, 6, 6,
    ]);
  });

  it('is valid to save and publish as it is', () => {
    expect(validateRubric(official)).toEqual({ save: [], publish: [] });
  });
});

describe('points scoring', () => {
  it('scores full marks as 100, sections as the sum of their criteria', () => {
    const b = scoreEvaluation(sections, full);
    expect(b.sections.map((s) => s.score)).toEqual([30, 25, 25, 20]);
    expect(b.total).toBe(100);
    expect(b.maximum).toBe(100);
  });

  it('treats 0 as a score and blank as not scored', () => {
    const zeros = sections.map((s) => s.criteria.map(() => 0));
    expect(scoreEvaluation(sections, zeros).total).toBe(0);
    const oneBlank = full.map((row, i) => row.map((v, j) => (i === 2 && j === 1 ? null : v)));
    const b = scoreEvaluation(sections, oneBlank);
    expect(b.total).toBeNull();
    expect(b.sections[2]!.score).toBeNull();
    expect(b.sections[0]!.score).toBe(30);
  });

  it('adds a realistic mix exactly', () => {
    const values = [
      [8, 7, 9],
      [6, 8, 5],
      [7, 6, 9],
      [8, 4, 6],
    ];
    const b = scoreEvaluation(sections, values);
    expect(b.sections.map((s) => s.score)).toEqual([24, 19, 22, 18]);
    expect(b.total).toBe(83);
  });

  it('refuses values outside 0..max and non-whole numbers', () => {
    expect(isValidRating({ maxPoints: 10 }, 0)).toBe(true);
    expect(isValidRating({ maxPoints: 10 }, 10)).toBe(true);
    expect(isValidRating({ maxPoints: 10 }, 11)).toBe(false);
    expect(isValidRating({ maxPoints: 7 }, -1)).toBe(false);
    expect(isValidRating({ maxPoints: 7 }, 3.5)).toBe(false);
    // Star criteria are unchanged.
    expect(isValidRating({}, 0)).toBe(false);
    expect(isValidRating({}, 5)).toBe(true);
    expect(isValidRating({ maxPoints: null }, 3)).toBe(true);
  });

  it('does not treat star sections as points sections', () => {
    expect(pointMaxima({ criteria: [{}, {}] })).toBeNull();
    expect(pointMaxima({ criteria: [4, 5] })).toBeNull();
    expect(pointMaxima({ criteria: [{ maxPoints: 10 }, { maxPoints: 8 }] })).toEqual([10, 8]);
  });
});

describe('points rubric validation', () => {
  const variant = (change: (r: RubricContent) => void) => {
    const r = officialRubric2026();
    change(r);
    return validateRubric(r);
  };

  it('requires the criteria to total exactly 100 to publish', () => {
    const v = variant((r) => (r.sections[3]!.criteria[2]!.maxPoints = 5));
    expect(v.save).toEqual([]);
    expect(v.publish.map((i) => i.message)).toEqual([
      'The criteria total 99 points. They must total exactly 100.',
    ]);
  });

  it('refuses missing, zero, fractional and oversized maxima before saving', () => {
    for (const bad of [null, 0, 2.5, 101]) {
      const v = variant((r) => (r.sections[0]!.criteria[0]!.maxPoints = bad));
      expect(
        v.save.some((i) => i.path === 'sections.0.criteria.0.maxPoints'),
        String(bad),
      ).toBe(true);
    }
  });

  it('refuses bonus sections and sections above 100 points', () => {
    expect(variant((r) => (r.sections[0]!.type = 'bonus')).save.length).toBeGreaterThan(0);
    const big = variant((r) => {
      r.sections[0]!.criteria = Array.from({ length: 3 }, (_, i) => ({
        title: `C${i}`,
        description: '',
        guidelines: '',
        maxPoints: 40,
      }));
    });
    expect(big.save.map((i) => i.message).join(' ')).toMatch(/at most 100/);
  });

  it('allows 1 to 10 criteria per section', () => {
    expect(variant((r) => (r.sections[0]!.criteria = [])).save.length).toBeGreaterThan(0);
  });
});
