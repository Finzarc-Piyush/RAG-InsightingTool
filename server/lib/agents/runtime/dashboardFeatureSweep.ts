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
import { finishChartSpec } from "../../chartSpecFinish.js";
import { toNumber } from "../../numberCoercion.js";
import { isNonAdditiveMetric } from "../../financeMetricAuthority.js";
import {
  resolveTrendGrain,
  buildDateRangeByColumn,
} from "../../temporalGrainAuthority.js";
import { isTemporalFacetColumnKey } from "../../temporalFacetColumns.js";
import { findMetricMentionedInQuestion } from "../utils/columnMatcher.js";
import {
  planContinuousDimensionBucket,
  applyContinuousDimensionBucket,
} from "../../continuousDimensionBucket.js";
import { isFlagOn } from "../../featureFlags.js";
import type { DepthBudget } from "./queryIntentAuthority.js";

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
/**
 * Per-side count for the best+worst leaderboard used in exhaustive breadth:
 * a bucketed dimension shows its top-K AND bottom-K groups (2·K bars), so the
 * WORST performers are visible instead of being lumped into "Other".
 */
const TOP_BOTTOM_K = 8;
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
  /**
   * Override for the outcome metric. On a plain analytical turn there is no
   * `analysisBrief`, so the caller resolves the metric (e.g. from the charts
   * the turn already built) and passes it here. Falls back to
   * `brief.outcomeMetricColumn` when omitted.
   */
  outcomeOverride?: string;
  /**
   * EXHAUSTIVE BREADTH. When true, after the brief's segmentation/driver lists
   * the sweep also enumerates EVERY categorical column in the dataset, so
   * coverage no longer depends on the LLM brief naming each dimension (the root
   * cause of "Android/iOS and TSOE-name got ignored"). Also lifts the
   * `requestsDashboard` precondition — the caller decides when to run it.
   */
  exhaustiveDimensions?: boolean;
  /**
   * When true, a dimension with uniques > MEDIUM_CARDINALITY_MAX is top-N+Other
   * bucketed (a leaderboard) instead of hard-skipped — so high-cardinality name
   * columns (e.g. TSO_TSE Name) still surface their top performers.
   */
  bucketHighCardinality?: boolean;
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
  // Exhaustive breadth lifts the requestsDashboard precondition — the caller
  // gates it (flag + analysis turn) and supplies the outcome via outcomeOverride.
  if (!opts.exhaustiveDimensions && !brief?.requestsDashboard) return [];
  const outcome = (opts.outcomeOverride ?? brief?.outcomeMetricColumn)?.trim();
  if (!outcome) return [];
  if (!ctx.summary.numericColumns.includes(outcome)) return [];

  const maxAdds = Math.max(0, opts.maxAdds ?? DEFAULT_MAX_SWEEP_CHARTS);
  if (maxAdds === 0) return [];

  const colNames = new Set(ctx.summary.columns.map((c) => c.name));
  const dateCols = new Set(ctx.summary.dateColumns);
  const numericCols = new Set(ctx.summary.numericColumns);

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
  for (const d of brief?.segmentationDimensions ?? []) pushDim(d);
  for (const d of brief?.candidateDriverDimensions ?? []) pushDim(d);
  // Exhaustive: append EVERY remaining categorical column (non-numeric,
  // non-date) so a dimension is charted even when the LLM brief omitted it (or
  // when there is no brief at all on a plain analysis turn). Numeric columns are
  // excluded — they are measures/ordinals (e.g. "Day"), not breakdown axes.
  if (opts.exhaustiveDimensions) {
    for (const c of ctx.summary.columns) {
      if (numericCols.has(c.name)) continue;
      pushDim(c.name);
    }
  }

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

  const trendX = pickStrongestDateColumn(ctx, sourceRows);
  if (trendX && !coveredX.has(trendX)) {
    const trend = tryBuildChart(ctx, sourceRows, "line", trendX, outcome);
    // Record the grain we just plotted so a temporal-facet dim of the SAME
    // grain in the loop below doesn't emit a duplicate line (both now share
    // chartAxisSignature `line|x|y|series`). coveredX was snapshotted from
    // mergedCharts before the loop, so it must be updated as `out` grows.
    if (trend) {
      out.push(trend);
      coveredX.add(trendX);
    }
  }

  for (const dim of orderedDims) {
    if (out.length >= maxAdds) break;
    if (coveredX.has(dim)) continue;
    // A temporal facet ("Day · Date", "Week · Date") is a TIME axis, not a
    // category — it must be a line, never a bar (bars imply category ranking).
    // Skip the top-N / top-bottom bucketing below (meaningless on a time axis)
    // and the cardinality gates (a long daily span is a legitimately wide line;
    // lines downsample, bars do not). Metric-aware aggregate: a per-period mean
    // for rate/%/score metrics, a per-period total for count-like metrics.
    if (isTemporalFacetColumnKey(dim)) {
      // Keep the lower-bound guard (a single-bucket time axis is a degenerate
      // one-point line — e.g. the Month facet of a single month of data), but
      // SKIP the upper-bound cardinality / top-N bucketing: a long daily span is
      // a legitimately wide line (lines downsample; bars cannot), and bucketing
      // a time axis into top-N+Other is meaningless.
      if (countUniqueValuesUpTo(sourceRows, dim, 2) < 2) continue;
      const aggregate = isNonAdditiveMetric(outcome) ? "mean" : "sum";
      const line = tryBuildChart(ctx, sourceRows, "line", dim, outcome, aggregate);
      if (line) {
        out.push(line);
        coveredX.add(dim);
      }
      continue;
    }
    // Continuous time dimensions (Clock-In Time, Working Hrs) are BINNED into
    // hour-of-day / duration-range bars — never ranked as categories or top-N/Other
    // bucketed (which would make a meaningless leaderboard of per-second values).
    // Runs BEFORE the cardinality regime below, since a per-second column trips the
    // high-cardinality skip. See docs/conventions/continuous-dimension-bucketing.md.
    const contPlan = planContinuousDimensionBucket({
      column: dim,
      rows: sourceRows,
      summaryColumn: ctx.summary.columns.find((c) => c.name === dim),
    });
    if (contPlan && contPlan.orderedKeys.length >= 2) {
      const built = tryBuildChart(
        ctx,
        applyContinuousDimensionBucket(sourceRows, contPlan),
        "bar",
        dim,
        outcome
      );
      if (built) {
        out.push(built);
        coveredX.add(dim);
      }
      continue;
    }
    const uniques = countUniqueValuesUpTo(sourceRows, dim, MEDIUM_CARDINALITY_MAX + 1);
    if (uniques < 2) continue;
    if (uniques > MEDIUM_CARDINALITY_MAX) {
      report?.skippedHighCardinality.push({ dimension: dim, uniques });
      // Default: hard-skip for legibility. With bucketHighCardinality the dim is
      // top-N+Other bucketed into a leaderboard instead — so a high-card name
      // column (e.g. TSO_TSE Name) still surfaces its top performers rather than
      // vanishing silently.
      if (!opts.bucketHighCardinality) continue;
      // Exhaustive breadth: show the BEST and WORST performers, not top-N+Other
      // (which buries the worst — the exact thing the user wants for people-level
      // dimensions like TSO_TSE Name).
      const bucketed = bucketTopAndBottom(sourceRows, dim, TOP_BOTTOM_K, outcome);
      const built = tryBuildChart(ctx, bucketed, "bar", dim, outcome);
      if (built) {
        out.push(built);
        report?.bucketedDimensions.push({ dimension: dim, uniques, topN: TOP_BOTTOM_K * 2 });
      }
      continue;
    }
    if (uniques > LOW_CARDINALITY_MAX) {
      // Bucket a medium-cardinality dim into a legible chart. In exhaustive
      // breadth we keep top-K AND bottom-K (best+worst visible); the legacy
      // dashboard-only path keeps top-N+Other (long-tail aggregate preserved).
      const bucketed = opts.bucketHighCardinality
        ? bucketTopAndBottom(sourceRows, dim, TOP_BOTTOM_K, outcome)
        : bucketRowsTopN(sourceRows, dim, TOP_N_BUCKET, outcome);
      const built = tryBuildChart(ctx, bucketed, "bar", dim, outcome);
      if (built) {
        out.push(built);
        report?.bucketedDimensions.push({
          dimension: dim,
          uniques,
          topN: opts.bucketHighCardinality ? TOP_BOTTOM_K * 2 : TOP_N_BUCKET,
        });
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

/**
 * Keep ONLY the top-K and bottom-K groups of `dim`, ranked by the MEAN of
 * `outcome` (size-normalised — correct for a rate; a raw SUM would just reward
 * the biggest group), and DROP the middle. The resulting chart shows the BEST
 * and WORST performers of a high-cardinality dimension side by side, instead of
 * a top-N+Other view that hides the worst. Kept groups retain ALL their rows so
 * per-group means stay exact. Pure: returns a filtered (not mutated) row array;
 * returns the input unchanged when there are ≤ 2·K groups (already small enough).
 */
function bucketTopAndBottom(
  rows: Record<string, unknown>[],
  dim: string,
  k: number,
  outcome: string
): Record<string, unknown>[] {
  const agg = new Map<string, { sum: number; n: number }>();
  for (const r of rows) {
    const raw = r?.[dim];
    if (raw == null || raw === "") continue;
    // toNumber (not bare Number) so the ranking agrees with how the chart
    // aggregates — handles "85%"/"1,234" string cells the same way.
    const y = toNumber(r?.[outcome]);
    if (!Number.isFinite(y)) continue;
    const key = String(raw);
    const cur = agg.get(key) ?? { sum: 0, n: 0 };
    cur.sum += y;
    cur.n += 1;
    agg.set(key, cur);
  }
  const means = [...agg.entries()].map(([key, { sum, n }]) => ({ key, mean: sum / n }));
  if (means.length <= 2 * k) return rows;
  means.sort((a, b) => b.mean - a.mean);
  const keep = new Set<string>([
    ...means.slice(0, k).map((m) => m.key),
    ...means.slice(means.length - k).map((m) => m.key),
  ]);
  return rows.filter((r) => {
    const raw = r?.[dim];
    return raw != null && raw !== "" && keep.has(String(raw));
  });
}

// Exposed for tests so the bucketing helper can be pinned independently.
export const __test__ = {
  bucketRowsTopN,
  bucketTopAndBottom,
  pickStrongestDateColumn,
  LOW_CARDINALITY_MAX,
  MEDIUM_CARDINALITY_MAX,
  TOP_N_BUCKET,
  TOP_BOTTOM_K,
  DEFAULT_MAX_SWEEP_CHARTS,
};

/**
 * Pick the time-axis column for the dashboard trend tile via the single grain
 * authority. The authority is span-aware AND counts MATERIALIZED buckets from the
 * raw rows, so a single month of daily data yields the Day facet even when the
 * per-column dateRange was stripped on the columnar/metadata reload path (the
 * old W3 logic silently kept Month whenever dateRange was absent). Falls back to
 * the first raw date column only when no temporal facet is usable at all.
 */
function pickStrongestDateColumn(
  ctx: AgentExecutionContext,
  sourceRows: readonly Record<string, unknown>[],
): string | null {
  const dates = ctx.summary.dateColumns ?? [];
  if (!dates.length) return null;
  const decision = resolveTrendGrain({
    availableColumns: ctx.summary.columns.map((c) => c.name),
    dateColumns: dates,
    dateRangeByColumn: buildDateRangeByColumn(ctx.summary),
    question: ctx.question,
    sample: sourceRows.slice(0, 200),
    isDashboard: true,
    allowSingleBucket: true, // a dashboard trend tile shows one honest point as a last resort
  });
  return decision.facetColumn ?? dates[0]!;
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
  y: string,
  // Optional aggregate override — DECOUPLES aggregate from chart type so a
  // temporal-facet LINE can carry a per-period "mean" (rate metrics) just like a
  // bar does. When omitted: bars de-confound size with "mean" (MW2); lines keep
  // the compiler's inferred default so existing trend tiles are unchanged.
  aggregateOverride?: "mean" | "sum"
): ChartSpec | null {
  // bar → "mean" (size-normalised breakdown, MW2); line → compiler default,
  // unless the caller pins an explicit aggregate (the facet-trend path).
  const aggregate = aggregateOverride ?? (type === "bar" ? "mean" : undefined);
  // Pin the aggregate through compile only when it is meaningful — i.e. bar's
  // "mean" or an explicit override. A plain line keeps inference (old behaviour).
  const preserveAggregate = aggregateOverride !== undefined || type === "bar";
  try {
    const { merged: mp } = compileChartSpec(
      rows,
      {
        numericColumns: ctx.summary.numericColumns,
        dateColumns: ctx.summary.dateColumns,
      },
      // MW2 · size-normalized comparison for dimension breakdowns — a per-record
      // AVERAGE de-confounds unit size (a raw SUM rewards big ASMs/clusters and
      // is not comparable).
      { type, x, y, ...(aggregate ? { aggregate } : {}) },
      {
        columnOrder: ctx.summary.columns.map((c) => c.name),
        // Each feature-sweep chart is a single (outcome × dim) breakdown.
        // Suppress the bar → heatmap upgrade so wide schemas (3+ dims)
        // don't collapse every dim into a 2D heatmap.
        disallowHeatmapUpgrade: true,
        ...(preserveAggregate ? { preserveAggregate: true } : {}),
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
      { chartQuestion: ctx.question, columnMeta: ctx.summary.columns }
    );
    return finishChartSpec(spec, processed);
  } catch {
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Exhaustive breadth — deterministic per-dimension coverage on analysis turns
// ───────────────────────────────────────────────────────────────────────────

/**
 * Flag (invariant #6). Default OFF in code; the Marico deploy sets
 * EXHAUSTIVE_BREADTH_ENABLED=true in server.env. When on, a plain analysis turn
 * gets one "outcome by <dim>" chart for EVERY categorical dimension (not just
 * the LLM-brief's lists, and not only on explicit dashboard asks).
 */
export function isExhaustiveBreadthEnabled(): boolean {
  return isFlagOn("EXHAUSTIVE_BREADTH_ENABLED");
}

/**
 * Decide — purely, so it is unit-testable in isolation (mirrors
 * classifyDashboardIntent) — whether a turn should run the cross-dimension
 * feature sweep (one "outcome by <dim>" chart per categorical column).
 *
 * This is the depth-budget enforcement point for breadth. It honours the
 * query-intent authority's documented contract (queryIntentAuthority.ts
 * DepthBudget docs): a `standard` descriptive/trend ask is the "full envelope
 * but NO breadth augmentation unless explicitly asked" — so it must NOT sweep.
 * The sweep fires only when:
 *   - the user explicitly asked for a dashboard (always a breadth context), OR
 *   - breadth is enabled on an analysis turn AND the ask is genuinely broad,
 *     i.e. diagnostic/strategic depth (`full`) OR an explicit breadth request
 *     (`signals.breadth`, e.g. "all columns / every level / full fledged").
 *
 * Gating on `!minimal` here (the previous behaviour) was the bug: it let every
 * `standard` trend question fan out one chart per dimension — the "pointed
 * question → plethora" the user reported. See queryIntentAuthority signals.breadth.
 */
export function shouldRunFeatureSweep(args: {
  isExplicitDashboardAsk: boolean;
  depthBudget: DepthBudget | undefined;
  breadthSignal: boolean;
  breadthEnabled: boolean;
  mode: string | undefined;
}): boolean {
  if (args.isExplicitDashboardAsk) return true;
  return (
    args.breadthEnabled &&
    args.mode === "analysis" &&
    (args.depthBudget === "full" || args.breadthSignal === true)
  );
}

/**
 * Columns whose NAME marks them as a temporal ordinal / counter (Day, Week,
 * Month, Year, …). Numeric, so they sneak into numericColumns and become
 * eligible as an outcome metric — producing meaningless "Day (avg) by X"
 * charts. Guarded out of outcome selection.
 */
export function isOrdinalLikeColumnName(name: string): boolean {
  const n = name.trim().toLowerCase().replace(/[_-]+/g, " ");
  return /\b(day|days|week|weeks|wk|month|months|year|years|quarter|quarters|qtr|day num|week num|month num|auto day)\b/.test(
    n
  );
}

/**
 * Resolve the outcome metric to break down, deterministically, WITHOUT relying
 * on the LLM brief (which doesn't exist on plain analytical turns):
 *   1. brief.outcomeMetricColumn (when present, numeric, non-ordinal),
 *   2. the dominant numeric Y across the charts the turn already built
 *      (i.e. the metric the user is actually analysing), excluding ordinals,
 *   3. a rate/score-named numeric column (pjp_adherence_rate-shaped),
 *   4. null → caller skips the breadth sweep.
 */
export function resolveBreadthOutcomeMetric(
  ctx: AgentExecutionContext,
  builtCharts: ReadonlyArray<{ y?: string | null }>
): string | null {
  const numeric = new Set(ctx.summary.numericColumns);
  const ok = (c: string | undefined | null): c is string =>
    !!c && numeric.has(c) && !isOrdinalLikeColumnName(c);

  const briefOutcome = ctx.analysisBrief?.outcomeMetricColumn?.trim();
  if (ok(briefOutcome)) return briefOutcome;

  // Dominant numeric Y among already-built charts.
  const tally = new Map<string, number>();
  for (const c of builtCharts) {
    const y = c.y?.trim();
    if (ok(y)) tally.set(y, (tally.get(y) ?? 0) + 1);
  }
  if (tally.size > 0) {
    return [...tally.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  }

  // The numeric metric the user NAMED in the question, before any name-pattern
  // last resort — so a "PJP" ask anchors on PJP rather than letting the generic
  // rate/compliance regex below win by column order.
  const named = findMetricMentionedInQuestion(
    ctx.question,
    ctx.summary.columns
      .map((c) => c.name)
      .filter((n) => numeric.has(n) && !isOrdinalLikeColumnName(n))
  );
  if (named) return named;

  // Rate/score-shaped numeric column, in dataset column order — delegated to the
  // metric-semantics authority (catches "pjp_adherence_rate" AND a literal "GC%").
  const rateCol = ctx.summary.columns.find(
    (c) =>
      numeric.has(c.name) &&
      !isOrdinalLikeColumnName(c.name) &&
      isNonAdditiveMetric(c.name)
  );
  return rateCol?.name ?? null;
}

export interface DimensionLeaders {
  dimension: string;
  best: { key: string; value: number };
  worst: { key: string; value: number };
  /** Number of distinct groups compared (≥2). */
  groupCount: number;
}

/**
 * Compute the best and worst performing group within one dimension, ranked by
 * the MEAN of the outcome (size-normalised — correct for a rate metric, where a
 * raw SUM would just reward the biggest group). Returns null when there are
 * fewer than 2 comparable groups. Pure.
 */
export function computeDimensionLeaders(
  rows: ReadonlyArray<Record<string, unknown>>,
  dimension: string,
  outcome: string
): DimensionLeaders | null {
  const agg = new Map<string, { sum: number; n: number }>();
  for (const r of rows) {
    const raw = r?.[dimension];
    if (raw == null || raw === "") continue;
    // toNumber so the best/worst finding agrees with the chart's aggregation.
    const y = toNumber(r?.[outcome]);
    if (!Number.isFinite(y)) continue;
    const key = String(raw);
    const cur = agg.get(key) ?? { sum: 0, n: 0 };
    cur.sum += y;
    cur.n += 1;
    agg.set(key, cur);
  }
  const means: Array<{ key: string; value: number }> = [];
  for (const [key, { sum, n }] of agg) {
    if (n > 0) means.push({ key, value: sum / n });
  }
  if (means.length < 2) return null;
  means.sort((a, b) => b.value - a.value);
  return {
    dimension,
    best: means[0]!,
    worst: means[means.length - 1]!,
    groupCount: means.length,
  };
}
