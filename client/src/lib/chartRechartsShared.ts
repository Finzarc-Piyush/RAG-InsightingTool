import { compareTemporalOrLexicalLabels } from '@/lib/temporalAxisSort';

/** Theme-aware series colors (see index.css --chart-1 … --chart-5) */
export const CHART_SERIES_COLORS = [
  'hsl(var(--chart-1))',
  'hsl(var(--chart-2))',
  'hsl(var(--chart-3))',
  'hsl(var(--chart-4))',
  'hsl(var(--chart-5))',
  'hsl(var(--chart-1) / 0.85)',
] as const;

export const LINE_AREA_MAX_X_TICKS = 12;

export function evenlySpacedDataKeys(
  rows: Record<string, unknown>[],
  xKey: string,
  maxTicks: number
): Array<string | number> | undefined {
  if (rows.length <= maxTicks) return undefined;
  const out: Array<string | number> = [];
  const n = rows.length;
  const target = Math.min(maxTicks, n);
  const step = Math.max(1, Math.floor((n - 1) / Math.max(1, target - 1)));
  for (let i = 0; i < n && out.length < target; i += step) {
    const v = rows[i]?.[xKey];
    if (v !== undefined && v !== null) {
      out.push(typeof v === 'string' || typeof v === 'number' ? v : String(v));
    }
  }
  const lastRow = rows[n - 1];
  const last = lastRow?.[xKey];
  if (last !== undefined && last !== null) {
    const normalized = typeof last === 'string' || typeof last === 'number' ? last : String(last);
    if (out[out.length - 1] !== normalized) {
      out.push(normalized);
    }
  }
  return out.length > 0 ? out : undefined;
}

/** Chronological X order for line/area (backend may return unsorted string dates). */
export function sortRowsForLineAreaChart(
  type: string,
  rows: Record<string, unknown>[],
  xKey: string | undefined
): Record<string, unknown>[] {
  if (type !== 'line' && type !== 'area') return rows;
  if (typeof xKey !== 'string') return rows;
  return [...rows].sort((a, b) => {
    const ra = a[xKey];
    const rb = b[xKey];
    const sa =
      ra instanceof Date && !isNaN(ra.getTime())
        ? ra.toISOString()
        : String(ra ?? '');
    const sb =
      rb instanceof Date && !isNaN(rb.getTime())
        ? rb.toISOString()
        : String(rb ?? '');
    return compareTemporalOrLexicalLabels(sa, sb);
  });
}
