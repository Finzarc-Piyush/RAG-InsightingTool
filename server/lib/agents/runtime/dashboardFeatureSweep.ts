/**
 * Deterministic dashboard feature sweep.
 *
 * After the LLM-driven planner + visual planner produce charts, fill in
 * coverage gaps when the user explicitly asked for a dashboard
 * (`analysisBrief.requestsDashboard === true`). For every dimension named
 * in `segmentationDimensions ∪ candidateDriverDimensions` that is NOT
 * already charted against the outcome metric, build a deterministic
 * outcome-by-dim chart so the dashboard reaches genuine breadth — and add
 * a primary trend on the strongest date column when one isn't already
 * present.
 *
 * Pure module: no LLM calls, no I/O. Uses the same compile path as the
 * visual planner's deterministic fallback (compileChartSpec +
 * processChartData + calculateSmartDomainsForChart) so the resulting
 * specs are indistinguishable from LLM-proposed charts downstream.
 */
import type { AgentExecutionContext } from "./types.js";
import type { ChartSpec } from "../../../shared/schema.js";
import { chartSpecSchema } from "../../../shared/schema.js";
import { processChartData } from "../../chartGenerator.js";
import { compileChartSpec } from "../../chartSpecCompiler.js";
import { calculateSmartDomainsForChart } from "../../axisScaling.js";

/**
 * DB4 · Cardinality regime.
 *  - 2 ≤ uniques ≤ LOW_CARDINALITY_MAX → chart natively.
 *  - LOW_CARDINALITY_MAX < uniques ≤ MEDIUM_CARDINALITY_MAX → chart against a
 *    top-N + Other bucketing of the dim column. Captures the long-tail
 *    contribution that the pre-DB4 hard skip silently dropped (e.g. 200-unique
 *    customer columns) without producing illegible 200-bar charts.
 *  - uniques > MEDIUM_CARDINALITY_MAX → still skipped; reported in
 *    `skippedHighCardinality` so the caller can emit telemetry.
 */
const LOW_CARDINALITY_MAX = 60;
const MEDIUM_CARDINALITY_MAX = 500;
const TOP_N_BUCKET = 15;
const OTHER_BUCKET_LABEL = "Other";
const DEFAULT_MAX_SWEEP_CHARTS = 18;

export interface FeatureSweepOptions {
  /** Hard cap on net-new charts the sweep will emit. */
  maxAdds?: number;
}

export interface FeatureSweepReport {
  /** Dimensions with > MEDIUM_CARDINALITY_MAX uniques that the sweep refused
   * to chart. Caller emits a telemetry event so the user / ops can see why a
   * candidate dim never made it onto the dashboard. */
  skippedHighCardinality: Array<{ dimension: string; uniques: number }>;
  /** Dimensions whose chart was built against a top-N + Other bucketed copy
   * of the dim column. */
  bucketedDimensions: Array<{ dimension: string; uniques: number; topN: number }>;
}

export function enumerateMissingDashboardCharts(
  ctx: AgentExecutionContext,
  mergedCharts: ChartSpec[],
  opts: FeatureSweepOptions = {},
  report?: FeatureSweepReport
): ChartSpec[] {
  const brief = ctx.analysisBrief;
  if (!brief?.requestsDashboard) return [];
  const outcome = brief.outcomeMetricColumn?.trim();
  if (!outcome) return [];
  if (!ctx.summary.numericColumns.includes(outcome)) return [];

  const maxAdds = Math.max(0, opts.maxAdds ?? DEFAULT_MAX_SWEEP_CHARTS);
  if (maxAdds === 0) return [];

  const colNames = new Set(ctx.summary.columns.map((c) => c.name));
  const dateCols = new Set(ctx.summary.dateColumns);

  const orderedDims: string[] = [];
  const seenDims = new Set<string>();
  const pushDim = (raw: string | undefined) => {
    const t = raw?.trim();
    if (!t || seenDims.has(t)) return;
    if (!colNames.has(t)) return;
    if (t === outcome) return;
    if (dateCols.has(t)) return;
    seenDims.add(t);
    orderedDims.push(t);
  };
  for (const d of brief.segmentationDimensions ?? []) pushDim(d);
  for (const d of brief.candidateDriverDimensions ?? []) pushDim(d);

  const coveredX = new Set<string>();
  const yMatchesOutcome = (y: string | undefined): boolean => {
    if (!y) return false;
    if (y === outcome) return true;
    return y.startsWith(`${outcome}_`);
  };
  for (const c of mergedCharts) {
    if (yMatchesOutcome(c.y)) coveredX.add(c.x);
  }

  const sourceRows = (ctx.turnStartDataRef ?? ctx.data) as
    | Record<string, unknown>[]
    | undefined;
  if (!sourceRows?.length) return [];

  const out: ChartSpec[] = [];

  const trendX = pickStrongestDateColumn(ctx);
  if (trendX && !coveredX.has(trendX)) {
    const trend = tryBuildChart(ctx, sourceRows, "line", trendX, outcome);
    if (trend) out.push(trend);
  }

  for (const dim of orderedDims) {
    if (out.length >= maxAdds) break;
    if (coveredX.has(dim)) continue;
    const uniques = countUniqueValuesUpTo(sourceRows, dim, MEDIUM_CARDINALITY_MAX + 1);
    if (uniques < 2) continue;
    if (uniques > MEDIUM_CARDINALITY_MAX) {
      report?.skippedHighCardinality.push({ dimension: dim, uniques });
      continue;
    }
    if (uniques > LOW_CARDINALITY_MAX) {
      // Top-N + Other bucketing keeps the chart legible while still surfacing
      // the dim in the dashboard. Without DB4, this entire dim was silently
      // dropped — that's the "missed features" complaint at the root.
      const bucketed = bucketRowsTopN(sourceRows, dim, TOP_N_BUCKET, outcome);
      const built = tryBuildChart(ctx, bucketed, "bar", dim, outcome);
      if (built) {
        out.push(built);
        report?.bucketedDimensions.push({ dimension: dim, uniques, topN: TOP_N_BUCKET });
      }
    } else {
      const built = tryBuildChart(ctx, sourceRows, "bar", dim, outcome);
      if (built) out.push(built);
    }
  }

  return out.slice(0, maxAdds);
}

/**
 * Replace all values in `rows[*][dim]` outside the top-N (by sum of `outcome`)
 * with the literal "Other". Pure: returns a new shallow-copied row array; the
 * input rows are not mutated. Numeric coercion is best-effort — non-finite
 * outcome values contribute zero.
 */
function bucketRowsTopN(
  rows: Record<string, unknown>[],
  dim: string,
  topN: number,
  outcome: string
): Record<string, unknown>[] {
  const totals = new Map<string, number>();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const raw = r[dim];
    if (raw == null || raw === "") continue;
    const key = String(raw);
    const yRaw = r[outcome];
    const y = typeof yRaw === "number" ? yRaw : Number(yRaw);
    const contribution = Number.isFinite(y) ? y : 0;
    totals.set(key, (totals.get(key) ?? 0) + contribution);
  }
  const sorted = Array.from(totals.entries()).sort((a, b) => b[1] - a[1]);
  const keep = new Set(sorted.slice(0, topN).map(([k]) => k));
  return rows.map((r) => {
    const raw = r?.[dim];
    if (raw == null || raw === "") return r;
    const key = String(raw);
    if (keep.has(key)) return r;
    return { ...r, [dim]: OTHER_BUCKET_LABEL };
  });
}

// DB4 · exposed for tests so the bucketing helper can be pinned independently.
export const __test__ = {
  bucketRowsTopN,
  LOW_CARDINALITY_MAX,
  MEDIUM_CARDINALITY_MAX,
  TOP_N_BUCKET,
  DEFAULT_MAX_SWEEP_CHARTS,
};

function pickStrongestDateColumn(ctx: AgentExecutionContext): string | null {
  const dates = ctx.summary.dateColumns ?? [];
  if (!dates.length) return null;
  // Prefer a derived month/quarter facet when present — already aggregated
  // into clean buckets, which line/area charts read more cleanly.
  const monthLike = ctx.summary.columns
    .map((c) => c.name)
    .find((n) => /^Month · /.test(n));
  if (monthLike) return monthLike;
  return dates[0]!;
}

function countUniqueValuesUpTo(
  rows: Record<string, unknown>[],
  col: string,
  capPlusOne: number
): number {
  const seen = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const v = rows[i]?.[col];
    if (v == null || v === "") continue;
    seen.add(String(v));
    if (seen.size >= capPlusOne) break;
  }
  return seen.size;
}

function tryBuildChart(
  ctx: AgentExecutionContext,
  rows: Record<string, unknown>[],
  type: "bar" | "line",
  x: string,
  y: string
): ChartSpec | null {
  try {
    const { merged: mp } = compileChartSpec(
      rows,
      {
        numericColumns: ctx.summary.numericColumns,
        dateColumns: ctx.summary.dateColumns,
      },
      { type, x, y },
      {
        columnOrder: ctx.summary.columns.map((c) => c.name),
        // Each feature-sweep chart is a single (outcome × dim) breakdown.
        // Suppress the bar → heatmap upgrade so wide schemas (3+ dims)
        // don't collapse every dim into a 2D heatmap.
        disallowHeatmapUpgrade: true,
      }
    );
    const spec = chartSpecSchema.parse({
      type: mp.type,
      title:
        mp.type === "heatmap" && mp.z
          ? `${mp.z} (${mp.x} × ${mp.y})`
          : `${mp.y} by ${mp.x}`,
      x: mp.x,
      y: mp.y,
      ...(mp.z ? { z: mp.z } : {}),
      ...(mp.seriesColumn ? { seriesColumn: mp.seriesColumn } : {}),
      ...(mp.barLayout ? { barLayout: mp.barLayout } : {}),
      aggregate: mp.aggregate ?? ("sum" as const),
    });
    const processed = processChartData(
      rows as Record<string, any>[],
      spec,
      ctx.summary.dateColumns,
      { chartQuestion: ctx.question }
    );
    const smartDomains =
      spec.type === "heatmap"
        ? {}
        : calculateSmartDomainsForChart(
            processed,
            spec.x,
            spec.y,
            spec.y2 || undefined,
            {
              yOptions: { useIQR: true, paddingPercent: 5, includeOutliers: true },
              y2Options: spec.y2
                ? { useIQR: true, paddingPercent: 5, includeOutliers: true }
                : undefined,
            }
          );
    return {
      ...spec,
      xLabel: spec.x,
      yLabel: spec.y,
      data: processed,
      ...smartDomains,
    } as ChartSpec;
  } catch {
    return null;
  }
}
