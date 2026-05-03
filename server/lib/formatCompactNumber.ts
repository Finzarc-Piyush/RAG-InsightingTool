/**
 * Format a numeric value for human-readable narrative text:
 *   |n| ≥ 1e9  → divide by 1e9, suffix "B"  (e.g. 2_400_000_000 → "2.4B")
 *   |n| ≥ 1e6  → divide by 1e6, suffix "M"  (e.g. 1_500_000     → "1.5M")
 *   |n| ≥ 1e3  → divide by 1e3, suffix "K"  (e.g. 15_240        → "15.2K")
 *   |n| <  1e3 → keep as-is, with bucketed decimals (preserves the
 *                pre-existing roundSmart behaviour so percentages,
 *                ratios, and Pearson r values render unchanged).
 *
 * Within a magnitude bucket the decimal precision follows the
 * scaled value:
 *   |scaled| ≥ 100 → 0 decimals
 *   |scaled| ≥ 10  → 1 decimal
 *   |scaled| < 10  → 2 decimals
 * Trailing zeros / dangling decimal points are stripped.
 */
export function formatCompactNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);

  const abs = Math.abs(n);
  if (abs >= 1e9) return formatScaled(n, 1e9, 'B');
  if (abs >= 1e6) return formatScaled(n, 1e6, 'M');
  if (abs >= 1e3) return formatScaled(n, 1e3, 'K');

  if (abs >= 100) return n.toFixed(0);
  if (abs >= 10) return stripTrailingZeros(n.toFixed(1));
  if (abs >= 1) return stripTrailingZeros(n.toFixed(2));
  return stripTrailingZeros(n.toFixed(3));
}

function formatScaled(n: number, divisor: number, suffix: string): string {
  const v = n / divisor;
  const av = Math.abs(v);
  let s: string;
  if (av >= 100) s = v.toFixed(0);
  else if (av >= 10) s = stripTrailingZeros(v.toFixed(1));
  else s = stripTrailingZeros(v.toFixed(2));
  return `${s}${suffix}`;
}

function stripTrailingZeros(s: string): string {
  if (!s.includes('.')) return s;
  return s.replace(/\.?0+$/, '');
}
