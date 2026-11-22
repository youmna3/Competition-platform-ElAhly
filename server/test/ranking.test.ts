import { describe, expect, it } from 'vitest';
import { compareAverages, rankTeams, toThousandths, formatScore } from '@judging/shared';

const team = (code: string, scores: number[]) => ({
  code,
  sumThousandths: scores.reduce((s, x) => s + toThousandths(x), 0),
  judges: scores.length,
  tieOrder: code,
});
const ranks = (items: ReturnType<typeof team>[]) => rankTeams(items).map((t) => [t.code, t.rank]);

describe('competition ranking', () => {
  it('shares a rank for exact ties and skips the next ones (1, 1, 3)', () => {
    expect(ranks([team('C', [60]), team('B', [100, 70]), team('A', [80, 90])])).toEqual([
      ['A', 1],
      ['B', 1],
      ['C', 3],
    ]);
  });

  it('handles several tie groups (1, 2, 2, 2, 5, 5)', () => {
    expect(
      ranks([
        team('F', [50]),
        team('E', [50]),
        team('D', [70]),
        team('C', [70]),
        team('B', [70]),
        team('A', [90]),
      ]).map(([, r]) => r),
    ).toEqual([1, 2, 2, 2, 5, 5]);
  });

  it('does not tie averages that only look equal after rounding', () => {
    // 80.0333… and 80.0285… both display as 80.03.
    const a = { code: 'A', sumThousandths: 240_100, judges: 3, tieOrder: 'A' };
    const b = { code: 'B', sumThousandths: 160_057, judges: 2, tieOrder: 'B' };
    expect(formatScore(240.1 / 3)).toBe(formatScore(160.057 / 2));
    expect(rankTeams([b, a]).map((t) => [t.code, t.rank])).toEqual([
      ['A', 1],
      ['B', 2],
    ]);
  });

  it('compares exactly where floating point would not (1/3 + 1/3 + 1/3 vs 1)', () => {
    const thirds = { sumThousandths: 3 * 80_333 + 1, judges: 3, tieOrder: 'a' }; // 241000/3
    const whole = { sumThousandths: 160_667, judges: 2, tieOrder: 'b' };
    // 241000/3 = 80.3333…, 160667/2 = 80.3335: different, so not tied.
    expect(compareAverages(thirds, whole)).not.toBe(0);
    const equal = { sumThousandths: 241_000, judges: 3, tieOrder: 'c' };
    expect(compareAverages(thirds, equal)).toBe(0);
  });

  it('orders exact ties by a deterministic display key without changing the rank', () => {
    const out = rankTeams([team('Z', [85]), team('M', [85]), team('A', [85])]);
    expect(out.map((t) => t.code)).toEqual(['A', 'M', 'Z']);
    expect(out.every((t) => t.rank === 1)).toBe(true);
  });

  it('keeps full precision in the average', () => {
    const [t] = rankTeams([team('A', [80, 80, 81])]);
    expect(t!.average).toBeCloseTo(80.333333, 6);
    expect(formatScore(t!.average)).toBe('80.33');
  });

  it('returns an empty list for no teams', () => {
    expect(rankTeams([])).toEqual([]);
  });
});
