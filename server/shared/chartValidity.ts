/**
 * Single shared authority for "is this chart fit to render?" — defined ONCE here
 * and re-exported by `client/src/shared/chartValidity.ts`, so the server (which
 * DECIDES whether to persist a chart) and the client (which DECIDES whether to
 * render an already-persisted one) can never drift. Mirrors the
 * `chartInsightLanes` / `chartSort` / `dashboardLayout` shared-authority pattern.
 *
 * THE RULE: a trend / time-series chart needs MORE THAN ONE point. A `line`,
 * `area`, or `scatter` chart whose x-axis materializes to fewer than 2 distinct
 * points is a degenerate "single dot" — a trendline with nothing to connect — and
 * must never be created or rendered, at ANY granularity (a single day, week,
 * month, or quarter all collapse to one point).
 *
 * WHY HERE (and not in a chart builder): in dashboard mode the temporal-grain
 * authority is intentionally called with `allowSingleBucket: true` ("show one
 * honest point as a last resort"), and the raw-date-column fallback can also
 * yield a single point. The builders see RAW columns and cannot predict the
 * grain-collapse; only AFTER the chart's `data` is materialized can the actual
 * point count be known. So suppression lives at the two materialized-data seams —
 * `finalizeMergedCharts` (server, before persist) and the client tile lists —
 * both reading this one predicate.
 *
 * Pure and dependency-free; runs byte-identically on server and client.
 */

/** Chart types whose semantics REQUIRE ≥2 x-axis points to be meaningful. */
export const DEGENERATE_TREND_CHART_TYPES: ReadonlySet<string> = new Set([
  "line",
  "area",
  "scatter",
]);

/**
 * Structural shape we need from a chart — deliberately NOT `ChartSpec` so this
 * stays decoupled and accepts both server runtime objects and loosely-typed
 * persisted dashboard charts.
 */
export type ChartValidityInput = {
  type?: string;
  x?: string;
  data?: readonly Record<string, unknown>[] | null;
};

/**
 * Count distinct non-null values of `row[x]` across `data`, short-circuiting at
 * 2 (we never need an exact count above the threshold). Returns `Infinity` when
 * the chart is UNEVALUABLE — no materialized `data` array, or no usable `x` key —
 * so an un-materialized chart is treated as "enough points" and never dropped.
 */
export function countDistinctXPoints(chart: ChartValidityInput): number {
  const { data, x } = chart;
  if (!Array.isArray(data) || typeof x !== "string" || x === "") {
    return Infinity;
  }
  const seen = new Set<string>();
  for (const row of data) {
    const v = row?.[x];
    if (v === null || v === undefined) continue;
    seen.add(String(v));
    if (seen.size >= 2) return 2;
  }
  return seen.size;
}

/**
 * True when `chart` is a `line` / `area` / `scatter` chart whose x-axis
 * materializes to fewer than 2 distinct points (a single-dot trendline). A
 * non-trend type (bar / pie / heatmap) is never degenerate here; an
 * un-materialized chart (`data` absent) is conservatively NOT degenerate.
 */
export function isDegenerateTrendChart(
  chart: ChartValidityInput | null | undefined,
): boolean {
  if (!chart || typeof chart.type !== "string") return false;
  if (!DEGENERATE_TREND_CHART_TYPES.has(chart.type)) return false;
  return countDistinctXPoints(chart) < 2;
}

/** Convenience inverse for `.filter(isRenderableChart)` at render seams. */
export function isRenderableChart(
  chart: ChartValidityInput | null | undefined,
): boolean {
  return !isDegenerateTrendChart(chart);
}
