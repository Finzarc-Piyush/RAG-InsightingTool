/**
 * ============================================================================
 * dashboardFeatureSweep.ts — fill the gaps so a dashboard is actually complete
 * ============================================================================
 * WHAT THIS FILE DOES
 *   When a user asks for a dashboard, the LLM planner builds some charts but
 *   often misses obvious ones. This file runs AFTER the planner and
 *   deterministically (no LLM, just rules) fills the holes. It looks at every
 *   meaningful breakdown dimension the analysis identified (segmentation
 *   dimensions + candidate driver dimensions) and, for any that isn't already
 *   charted against the main outcome metric, builds an "outcome by dimension"
 *   chart. It also adds a primary time-trend on the best date column if one
 *   isn't there yet. To stay legible it caps how many charts it adds and
 *   handles high-cardinality dimensions by bucketing the long tail into "Other"
 *   (top 15 values kept), and skips dimensions with too many distinct values.
 *
 * WHY IT MATTERS
 *   Dashboards are a headline feature, and "the dashboard missed the obvious
 *   breakdowns" was a real complaint. This guarantees genuine breadth — every
 *   important dimension gets a chart — without relying on the LLM to remember
 *   them all. Because it reuses the exact same compile path as the planner's
 *   fallback, the charts it adds are indistinguishable from LLM-proposed ones
 *   downstream.
 *
 * KEY PIECES
 *   - enumerateMissingDashboardCharts — main entry: returns the net-new chart
 *       specs to append (respecting the maxAdds cap and a coverage check).
 *   - bucketRowsTopN — collapses long-tail dimension values into "Other".
 *   - tryBuildChart — compiles one (outcome × dim) chart, or null on failure.
 *   - FeatureSweepReport — records skipped high-cardinality + bucketed dims so
 *       the caller can emit telemetry.
 *
 * HOW IT CONNECTS
 *   Pure module, no LLM calls and no I/O. Called from agentLoop.service.ts when
 *   assembling a dashboard. Reuses chartSpecCompiler (compileChartSpec),
 *   chartGenerator (processChartData) and axisScaling
 *   (calculateSmartDomainsForChart) — the same path as the visual planner's
 *   deterministic fallback.
 */
import type { AgentExecutionContext } from "./types.js";
import type { ChartSpec } from "../../../shared/schema.js";
import { chartSpecSchema } from "../../../shared/schema.js";
import { processChartData } from "../../chartGenerator.js";
import { compileChartSpec } from "../../chartSpecCompiler.js";
import { calculateSmartDomainsForChart } from "../../axisScaling.js";
import {
  distinctBucketsForGrain,
  pickTrendGrainForSpan,
  PERIOD_TO_FACET_GRAIN,
} from "../../queryPlanTemporalPatch.js";
import { facetColumnKey, parseTemporalFacetDisplayKey } from "../../temporalFacetColumns.js";

/**
 * Cardinality regime (how many distinct values a dimension has):
 *  - 2 ≤ uniques ≤ LOW_CARDINALITY_MAX → chart natively.
 *  - LOW_CARDINALITY_MAX < uniques ≤ MEDIUM_CARDINALITY_MAX → chart against a
 *    top-N + Other bucketing of the dim column. Captures the long-tail
 *    contribution that a plain hard skip would silently drop (e.g. 200-unique
 *    customer columns) without producing illegible 200-bar charts.
 *  - uniques > MEDIUM_CARDINALITY_MAX → skipped; reported in
 *    `skippedHighCardinality` so the caller can emit telemetry.
 */
const LOW_CARDINALITY_MAX = 60;
const MEDIUM_CARDINALITY_MAX = 500;
const TOP_N_BUCKET = 15;
const OTHER_BUCKET_LABEL = "Other";
// Aligned with `DASHBOARD_CHART_HARD_CAP` and the per-sheet schema ceiling
// (`dashboardSheetSpecSchema.charts.max(24)`). This is only the FALLBACK
// ceiling — agentLoop.service.ts always passes
// `maxAdds: remaining = DASHBOARD_CHART_HARD_CAP - mergedCharts.length`
// so the effective ceiling matches the hard cap. Tests / direct callers
// that don't pass `maxAdds` get this 24 ceiling.
const DEFAULT_MAX_SWEEP_CHARTS = 24;

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
      // the dim in the dashboard. Without this, a high-cardinality dim would
      // be silently dropped — that's the "missed features" complaint at the root.
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

// Exposed for tests so the bucketing helper can be pinned independently.
export const __test__ = {
  bucketRowsTopN,
  pickStrongestDateColumn,
  LOW_CARDINALITY_MAX,
  MEDIUM_CARDINALITY_MAX,
  TOP_N_BUCKET,
  DEFAULT_MAX_SWEEP_CHARTS,
};

function pickStrongestDateColumn(ctx: AgentExecutionContext): string | null {
  const dates = ctx.summary.dateColumns ?? [];
  if (!dates.length) return null;
  const colNames = ctx.summary.columns.map((c) => c.name);
  // Prefer a derived month/quarter facet when present — already aggregated
  // into clean buckets, which line/area charts read more cleanly.
  const monthLike = colNames.find((n) => /^Month · /.test(n));
  if (!monthLike) return dates[0]!;

  // W3 · a Month facet collapses to ONE bucket on a single-month (daily) span,
  // which renders a flat 1-point "trend" and triggers the "only one temporal
  // bucket" caveat. When that happens, fall to the span-appropriate finer grain
  // (Month → Week → Day) so a real multi-point trend is charted. No-op (keeps
  // Month) when the span genuinely yields ≥2 monthly buckets or when per-column
  // dateRange metadata is unavailable.
  const parsed = parseTemporalFacetDisplayKey(monthLike);
  const source = parsed?.sourceColumn;
  const dateRange = source
    ? (
        ctx.summary.columns.find((c) => c.name === source) as
          | {
              dateRange?: {
                spanDays: number;
                distinctDayCount: number;
                minIso?: string;
                maxIso?: string;
              };
            }
          | undefined
      )?.dateRange
    : undefined;
  if (!source || !dateRange) return monthLike;
  if (distinctBucketsForGrain(dateRange, "month") >= 2) return monthLike;

  // Month collapsed — pick the grain appropriate to the span (Day for ≤90 days,
  // Week for ≤1y, …) and use its facet if it exists and yields ≥2 buckets.
  const period = pickTrendGrainForSpan(dateRange.spanDays, dateRange.distinctDayCount);
  const preferredGrain = PERIOD_TO_FACET_GRAIN[period] ?? "date";
  const candidateGrains = [preferredGrain, "week", "date"] as const;
  for (const grain of candidateGrains) {
    if (distinctBucketsForGrain(dateRange, grain) < 2) continue;
    const facet = facetColumnKey(source, grain);
    if (colNames.includes(facet)) return facet;
  }
  return monthLike;
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
      // MW2 · size-normalized comparison for dimension breakdowns — a per-record
      // AVERAGE de-confounds unit size (a raw SUM rewards big ASMs/clusters and
      // is not comparable). Trends (line) keep their default so totals-over-time
      // read naturally.
      { type, x, y, ...(type === "bar" ? { aggregate: "mean" as const } : {}) },
      {
        columnOrder: ctx.summary.columns.map((c) => c.name),
        // Each feature-sweep chart is a single (outcome × dim) breakdown.
        // Suppress the bar → heatmap upgrade so wide schemas (3+ dims)
        // don't collapse every dim into a 2D heatmap.
        disallowHeatmapUpgrade: true,
        ...(type === "bar" ? { preserveAggregate: true } : {}),
      }
    );
    const spec = chartSpecSchema.parse({
      type: mp.type,
      title:
        mp.type === "heatmap" && mp.z
          ? `${mp.z} (${mp.x} × ${mp.y})`
          : mp.aggregate === "mean"
            ? `${mp.y} (avg) by ${mp.x}`
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
