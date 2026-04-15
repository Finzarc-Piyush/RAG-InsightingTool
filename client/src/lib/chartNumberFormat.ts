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

function formatScaledWithSuffix(n: number, divisor: number, suffix: string): string {
  const v = n / divisor;
  const av = Math.abs(v);
  if (av < 10) {
    const s = v.toFixed(2).replace(/\.?0+$/, '');
    return `${s}${suffix}`;
  }
  return `${Math.round(v)}${suffix}`;
}

/**
 * Format a numeric chart value for tooltips.
 * Decimals allowed only when |n| < 10 (or |scaled value before K/M/B| < 10).
 */
export function formatChartTooltipValue(value: unknown): string {
  const n = parseFiniteNumber(value);
  if (n === null) return '—';

  const abs = Math.abs(n);

  if (abs >= 1e9) return formatScaledWithSuffix(n, 1e9, 'B');
  if (abs >= 1e6) return formatScaledWithSuffix(n, 1e6, 'M');
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
