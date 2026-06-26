import { describe, expect, it } from 'vitest';
import { evenlySpacedDataKeys } from './chartRechartsShared';

/** Build N rows `{ asm: 'A<i>' }` so a returned value 'A<i>' maps back to index i. */
function rowsOfN(n: number): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => ({ asm: `A${i}` }));
}

/** Recover the original row indices a thinned tick array selected. */
function selectedIndices(out: Array<string | number> | undefined): number[] {
  return (out ?? []).map((v) => Number(String(v).slice(1)));
}

describe('evenlySpacedDataKeys', () => {
  it('returns undefined when no thinning is needed (rows <= maxTicks)', () => {
    expect(evenlySpacedDataKeys(rowsOfN(3), 'asm', 10)).toBeUndefined();
    expect(evenlySpacedDataKeys(rowsOfN(10), 'asm', 10)).toBeUndefined();
  });

  it('always keeps the first and last bucket when thinning', () => {
    const out = evenlySpacedDataKeys(rowsOfN(48), 'asm', 10);
    expect(out?.[0]).toBe('A0');
    expect(out?.[out.length - 1]).toBe('A47');
  });

  // Regression for the dashboard "x-axis labels crammed on the left + blank gap
  // + lone final label" bug: a 48-category bar chart with a width-derived budget
  // of 25 must NOT emit the first 25 categories contiguously. The floored-stride
  // implementation produced exactly that (step floored to 1 in the (n/2, n) band).
  it('spreads labels across the full range — NOT a contiguous left-side prefix (48 cats, budget 25)', () => {
    const out = evenlySpacedDataKeys(rowsOfN(48), 'asm', 25);
    const idx = selectedIndices(out);

    // First + last present.
    expect(idx[0]).toBe(0);
    expect(idx[idx.length - 1]).toBe(47);

    // The defining symptom: the second tick was 'A1' (contiguous). With even
    // spacing across 48 buckets at budget 25 the stride is ~1.96, so it is 'A2'.
    expect(idx[1]).toBeGreaterThan(1);

    // No contiguous prefix: the selected indices must reach the far end early,
    // not bunch up in the first ~half. Past the midpoint of the *selection* we
    // must already be past the midpoint of the *data*.
    const mid = idx[Math.floor(idx.length / 2)];
    expect(mid).toBeGreaterThan(48 / 4);

    // Strictly increasing, every gap small (evenly spaced, max gap <= ceil(stride)).
    for (let i = 1; i < idx.length; i++) {
      expect(idx[i]).toBeGreaterThan(idx[i - 1]);
      expect(idx[i] - idx[i - 1]).toBeLessThanOrEqual(2);
    }
  });

  it('is evenly spaced for a smaller budget too (48 cats, budget 10)', () => {
    const idx = selectedIndices(evenlySpacedDataKeys(rowsOfN(48), 'asm', 10));
    expect(idx[0]).toBe(0);
    expect(idx[idx.length - 1]).toBe(47);
    // ~5-apart, never the same gap collapse that produced a left-cram.
    for (let i = 1; i < idx.length; i++) {
      expect(idx[i] - idx[i - 1]).toBeGreaterThanOrEqual(4);
      expect(idx[i] - idx[i - 1]).toBeLessThanOrEqual(6);
    }
  });

  it('skips null/undefined cell values without crashing', () => {
    const rows: Record<string, unknown>[] = rowsOfN(48);
    rows[0] = { asm: null };
    const out = evenlySpacedDataKeys(rows, 'asm', 10);
    expect(out).toBeDefined();
    expect(out).not.toContain(null);
    // Last bucket is still labeled.
    expect(out?.[out.length - 1]).toBe('A47');
  });

  it('normalizes non-string/number values to strings', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ asm: { toString: () => `obj${i}` } }));
    const out = evenlySpacedDataKeys(rows as Record<string, unknown>[], 'asm', 5);
    expect(out?.every((v) => typeof v === 'string')).toBe(true);
  });
});
