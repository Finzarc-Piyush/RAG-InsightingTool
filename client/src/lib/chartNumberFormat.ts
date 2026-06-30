/**
 * Tooltip / hover number formatting: show decimals only when |value| < 10.
 */

function parseFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const cleaned = value.replace(/[%,]/g, '').trim();
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// INDIAN TIER LADDER — keep in sync with server/lib/formatCompactNumber.ts,
// client/src/lib/charts/format.ts (formatKMB), and chartFilterHelpers.ts.
// See docs/conventions/indian-number-format.md.
function formatScaledWithSuffix(n: number, divisor: number, suffix: string): string {
  const v = n / divisor;
  // 1 dp for |scaled| ≥ 10, 2 dp below; strip trailing zeros; space before suffix.
  const fixed = (Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2))
    .replace(/\.0+$/, '')
    .replace(/(\.\d*?)0+$/, '$1');
  return `${fixed} ${suffix}`;
}

/**
 * Format a numeric chart value for tooltips (Indian: Cr / Lac / K).
 * Decimals follow the scaled value (1 dp ≥10, 2 dp below); raw |n| < 10 keeps
 * up to 2 dp.
 */
export function formatChartTooltipValue(value: unknown): string {
  const n = parseFiniteNumber(value);
  if (n === null) return '—';

  const abs = Math.abs(n);

  if (abs >= 1e7) return formatScaledWithSuffix(n, 1e7, 'Cr');
  if (abs >= 1e5) return formatScaledWithSuffix(n, 1e5, 'Lac');
  if (abs >= 1e3) return formatScaledWithSuffix(n, 1e3, 'K');

  if (abs < 10) {
    if (Number.isInteger(n)) return String(n);
    return n.toFixed(2).replace(/\.?0+$/, '') || '0';
  }

  return Math.round(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
}

/** Recharts Tooltip formatter: (value, name) => [display, name] */
export function rechartsTooltipValueFormatter(
  value: unknown,
  name: unknown
): [string, string] {
  return [formatChartTooltipValue(value), String(name ?? '')];
}
