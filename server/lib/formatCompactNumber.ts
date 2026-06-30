/**
 * Format a numeric value for human-readable narrative text in the INDIAN
 * numbering system (₹ is added by callers / the LLM prompt, not here):
 *   |n| ≥ 1e7  → divide by 1e7, suffix " Cr"  (e.g. 1_049_389_992 → "104.9 Cr")
 *   |n| ≥ 1e5  → divide by 1e5, suffix " Lac" (e.g. 481_000       → "4.81 Lac")
 *   |n| ≥ 1e3  → divide by 1e3, suffix " K"   (e.g. 50_000        → "50 K")
 *   |n| <  1e3 → keep as-is, with bucketed decimals (preserves the
 *                pre-existing roundSmart behaviour so percentages,
 *                ratios, and Pearson r values render unchanged).
 *
 * INDIAN TIER LADDER — keep in sync with the three mirrored ladders:
 *   client/src/lib/charts/format.ts (formatKMB)
 *   client/src/lib/chartNumberFormat.ts
 *   client/src/lib/charts/chartFilterHelpers.ts (formatAxisLabelFieldBlind)
 * See docs/conventions/indian-number-format.md.
 *
 * Within a magnitude bucket the decimal precision follows the scaled value:
 *   |scaled| ≥ 10 → 1 decimal   (so 104.94 → "104.9 Cr", not "105 Cr")
 *   |scaled| < 10 → 2 decimals  (never more than two — W-DEC1)
 * A SPACE precedes the suffix ("104.9 Cr"); trailing zeros / dangling decimal
 * points are stripped.
 */
export function formatCompactNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);

  const abs = Math.abs(n);
  if (abs >= 1e7) return formatScaled(n, 1e7, 'Cr');
  if (abs >= 1e5) return formatScaled(n, 1e5, 'Lac');
  if (abs >= 1e3) return formatScaled(n, 1e3, 'K');

  if (abs >= 100) return n.toFixed(0);
  if (abs >= 10) return stripTrailingZeros(n.toFixed(1));
  // ≤2 decimals everywhere (product rule) — sub-1 values were 3 dp before W-DEC1.
  return stripTrailingZeros(n.toFixed(2));
}

function formatScaled(n: number, divisor: number, suffix: string): string {
  const v = n / divisor;
  const av = Math.abs(v);
  // Indian magnitude tiers: 1 dp for |scaled| ≥ 10, 2 dp below.
  const s = av >= 10 ? stripTrailingZeros(v.toFixed(1)) : stripTrailingZeros(v.toFixed(2));
  return `${s} ${suffix}`;
}

function stripTrailingZeros(s: string): string {
  if (!s.includes('.')) return s;
  return s.replace(/\.?0+$/, '');
}
