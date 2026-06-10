/**
 * ============================================================================
 * computeAttentionAreas.ts — management-by-exception: what needs attention
 * ============================================================================
 * WHAT THIS FILE DOES
 *   A manager's first question is "who/what needs my intervention?" — not "who's
 *   doing great". This pure function reads the dashboard's categorical breakdown
 *   charts (each tile already carries its per-unit rates/averages in
 *   `ChartSpec.data`) and flags the units that fall BELOW the org-average
 *   benchmark for that metric. Units more than one standard deviation below are
 *   "red" (critical); the rest below average are "amber". The result drives an
 *   "Attention Areas" callout so the manager sees problem areas without hunting.
 *
 * WHY IT MATTERS
 *   The dataset has no target column, so the benchmark is the all-units average
 *   (zero-config, comparable). Surfacing below-benchmark units IS the
 *   management-by-exception value — the highest-leverage manager feature.
 *   Deterministic + derived from the displayed charts, so it never contradicts a
 *   tile and needs no extra LLM call.
 *
 * HOW IT CONNECTS
 *   Called from buildDashboard with the dashboard's ChartSpec[]; the result is
 *   stamped onto the DashboardSpec and rendered by the client summary band.
 */

export type AttentionStatus = "red" | "amber";

export interface AttentionArea {
  /** The breakdown dimension, e.g. "ASM". */
  dimension: string;
  /** The under-performing unit, e.g. "Bihar West". */
  unit: string;
  /** Human-readable metric label (the chart title), e.g. "PJP Adherence rate by ASM". */
  metric: string;
  /** This unit's value (rate fraction or per-unit average). */
  value: number;
  /** Org-average benchmark for the metric (mean across units). */
  benchmark: number;
  /** Percentage below the benchmark (negative), e.g. -32 = 32% below average. */
  variancePct: number;
  /** "red" = >1 SD below average (critical); "amber" = below average. */
  status: AttentionStatus;
}

interface ChartLike {
  type?: string;
  title?: string;
  x?: string;
  y?: string;
  aggregate?: string;
  data?: Array<Record<string, unknown>>;
}

export interface ComputeAttentionAreasOptions {
  /** Cap on returned items (worst-first). Default 8 — keep the callout legible. */
  maxAreas?: number;
  /** Min distinct units a breakdown needs for a meaningful benchmark. Default 3. */
  minUnits?: number;
}

// Units that are rollup/aggregate rows, not real comparable entities.
const ROLLUP_UNIT_RE = /^(total|grand\s*total|all|overall|other|others|n\/?a|unknown|\(blank\))$/i;
// Metrics where LOWER is better — below-average is GOOD, so skip (don't flag).
const LOWER_IS_BETTER_RE = /\bnon[-\s]?(compliance|gcpc)|non[-\s]?compliant|absent|late|error|gap|miss(?:ed|es)?\b/i;

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function stddev(xs: number[], mu: number): number {
  if (xs.length < 2) return 0;
  return Math.sqrt(xs.reduce((a, b) => a + (b - mu) * (b - mu), 0) / xs.length);
}

/**
 * Derive below-benchmark "attention areas" from the dashboard's categorical
 * breakdown charts. Pure. Worst-first, capped. Skips trends, tiny breakdowns,
 * rollup rows, and lower-is-better metrics.
 */
export function computeAttentionAreas(
  charts: readonly ChartLike[],
  options: ComputeAttentionAreasOptions = {}
): AttentionArea[] {
  const maxAreas = options.maxAreas ?? 8;
  const minUnits = options.minUnits ?? 3;
  const areas: AttentionArea[] = [];

  for (const chart of charts ?? []) {
    if (!chart || chart.type !== "bar") continue; // only categorical breakdowns
    const x = chart.x;
    const y = chart.y;
    const rows = chart.data;
    if (!x || !y || !Array.isArray(rows) || rows.length < minUnits) continue;
    const metric = (chart.title ?? `${y} by ${x}`).trim();
    if (LOWER_IS_BETTER_RE.test(metric) || LOWER_IS_BETTER_RE.test(y)) continue;

    const points: Array<{ unit: string; value: number }> = [];
    for (const r of rows) {
      const unit = String(r[x] ?? "").trim();
      const value = Number(r[y]);
      if (!unit || ROLLUP_UNIT_RE.test(unit) || !Number.isFinite(value)) continue;
      points.push({ unit, value });
    }
    if (points.length < minUnits) continue;

    const values = points.map((p) => p.value);
    const benchmark = mean(values);
    if (!Number.isFinite(benchmark) || benchmark === 0) continue;
    const sd = stddev(values, benchmark);

    for (const p of points) {
      if (p.value >= benchmark) continue; // only below-benchmark units need attention
      areas.push({
        dimension: x,
        unit: p.unit,
        metric,
        value: p.value,
        benchmark,
        variancePct: ((p.value - benchmark) / Math.abs(benchmark)) * 100,
        status: sd > 0 && p.value < benchmark - sd ? "red" : "amber",
      });
    }
  }

  // Worst (most-below benchmark) first; criticals (red) ahead of amber at a tie.
  areas.sort((a, b) => {
    if (a.status !== b.status) return a.status === "red" ? -1 : 1;
    return a.variancePct - b.variancePct;
  });
  return areas.slice(0, maxAreas);
}
