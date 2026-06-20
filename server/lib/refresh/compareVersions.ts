/**
 * Wave WR12 (incremental refresh) · April-vs-May compare.
 *
 * Diffs the PRIOR dashboard charts (snapshotted at refresh time) against the
 * CURRENT charts, matched by the axis-aware `chartIdentityKey`. For each matched
 * chart it computes a headline total (sum of the y-values) for both versions and
 * the % change — the "Value sales +6.2% MoM" a brand manager reads first.
 *
 * Pure + exported for tests; the endpoint just loads the two chart sets.
 */

import { chartIdentityKey, type ChartSpec } from "../../shared/schema.js";

/** Sum of the chart's numeric y-values across its data rows (headline total). */
export function chartTotal(chart: ChartSpec): number {
  const rows = Array.isArray(chart.data) ? chart.data : [];
  const yCol = chart.y;
  let sum = 0;
  let counted = 0;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const raw = yCol != null ? (row as Record<string, unknown>)[yCol] : undefined;
    const n = typeof raw === "number" ? raw : Number(raw);
    if (Number.isFinite(n)) {
      sum += n;
      counted += 1;
    }
  }
  return counted > 0 ? sum : 0;
}

export interface CompareRow {
  title: string;
  type: string;
  priorTotal: number;
  currentTotal: number;
  /** % change current vs prior; null when prior is 0 (undefined growth). */
  deltaPct: number | null;
  delta: number;
}

export interface RefreshCompareResult {
  available: boolean;
  priorLabel?: string;
  currentLabel?: string;
  rows: CompareRow[];
}

/**
 * Build the compare rows. Charts present in BOTH versions (same identity) are
 * diffed; charts only in one version are skipped (a compare needs both sides).
 */
export function buildRefreshCompare(
  priorCharts: ChartSpec[] | undefined,
  currentCharts: ChartSpec[] | undefined,
  labels: { priorLabel?: string; currentLabel?: string } = {}
): RefreshCompareResult {
  if (!priorCharts?.length || !currentCharts?.length) {
    return { available: false, rows: [], ...labels };
  }
  const currentByKey = new Map<string, ChartSpec>();
  for (const c of currentCharts) currentByKey.set(chartIdentityKey(c), c);

  const rows: CompareRow[] = [];
  for (const prior of priorCharts) {
    const current = currentByKey.get(chartIdentityKey(prior));
    if (!current) continue;
    const priorTotal = chartTotal(prior);
    const currentTotal = chartTotal(current);
    const delta = currentTotal - priorTotal;
    const deltaPct = priorTotal !== 0 ? (delta / Math.abs(priorTotal)) * 100 : null;
    rows.push({
      title: current.title ?? prior.title ?? "Chart",
      type: current.type ?? prior.type ?? "bar",
      priorTotal,
      currentTotal,
      delta,
      deltaPct,
    });
  }
  return {
    available: rows.length > 0,
    rows,
    ...labels,
  };
}
