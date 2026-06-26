import { compareTemporalOrLexicalLabels } from '@/lib/temporalAxisSort';
import { MAX_X_AXIS_LABELS } from '@/lib/charts/xAxisLabelCap';
import { qualitativePalette } from '@/lib/charts/palette';

/**
 * Theme-aware series colors for the Recharts charts (chat + dashboard modals).
 * Single source of truth: the full qualitative palette (index.css --chart-1 …
 * --chart-24), shared with the visx renderers via `qualitativePalette()`.
 * Consumers index with `[i % CHART_SERIES_COLORS.length]`, so widening the
 * palette automatically gives more series distinct colors before wrap-around.
 */
export const CHART_SERIES_COLORS: readonly string[] = qualitativePalette();

/** Primary / secondary Y axis for dual-axis line charts */
export const CHART_DUAL_AXIS_STROKES: readonly string[] = [
  'hsl(var(--chart-1))',
  'hsl(var(--chart-4))',
];

export const LINE_AREA_MAX_X_TICKS = MAX_X_AXIS_LABELS;

export function evenlySpacedDataKeys(
  rows: Record<string, unknown>[],
  xKey: string,
  maxTicks: number
): Array<string | number> | undefined {
  const n = rows.length;
  if (n <= maxTicks) return undefined;
  // Spread `target` ticks across the FULL index range [0, n-1] with a rounded
  // float stride — the same math as `pickEvenlySpacedTicks` (the visx thinner).
  // The previous floored-integer stride (`Math.floor((n-1)/(target-1))`)
  // collapsed to 1 whenever the budget landed in (n/2, n) — e.g. 25 of 48 — so
  // it emitted the first `target` categories CONTIGUOUSLY and only force-
  // appended the last, crowding every label onto the left with a blank gap
  // before a lone final label (visible on dashboard tiles whose measured width
  // yields such a budget; the wider fullscreen modal lands outside that range,
  // which is why it looked correct). Rounding distributes them evenly and
  // always includes the first (i=0 → idx 0) and last (i=target-1 → idx n-1).
  const target = Math.max(2, Math.min(maxTicks, n));
  const out: Array<string | number> = [];
  const seenIdx = new Set<number>();
  const stride = (n - 1) / (target - 1);
  for (let i = 0; i < target; i++) {
    const idx = Math.round(i * stride);
    if (seenIdx.has(idx)) continue;
    seenIdx.add(idx);
    const v = rows[idx]?.[xKey];
    if (v !== undefined && v !== null) {
      out.push(typeof v === 'string' || typeof v === 'number' ? v : String(v));
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
