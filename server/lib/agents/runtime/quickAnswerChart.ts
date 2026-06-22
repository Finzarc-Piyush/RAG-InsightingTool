/**
 * ============================================================================
 * quickAnswerChart.ts — give a quick-answer lookup a chart of all performers
 * ============================================================================
 * WHAT THIS FILE DOES
 *   The quick-answer fast path (quickAnswerPath.ts) answers a simple lookup
 *   ("who is the top performer?") with a concise table. The user also wants to
 *   SEE the broader picture: a chart of all performers, sorted by performance.
 *   This file is the PURE seam that produces that one chart.
 *
 *   Two functions, both pure (no LLM, no executor, no env):
 *     - deriveLeaderboardPlan — given the executed query plan, derive a
 *       "leaderboard variant": same groupBy + measure, sorted by the measure,
 *       capped at a chart-readable row count. Used by quickAnswerPath to
 *       RE-EXECUTE and get the full ranking when the answer itself was a single
 *       winner (e.g. "who is THE top performer" → limit 1 → one row → no chart).
 *     - buildQuickAnswerChart — pick the source frame (the answer rows when they
 *       already carry ≥2 sorted rows, else the re-executed leaderboard rows) and
 *       delegate to the shared deterministic chart builder.
 *
 * WHY IT MATTERS
 *   The pivot half already works: derivePivotDefaultsFromExecution re-queries
 *   the base data, so the pivot shows all performers even for a one-row answer.
 *   The CHART was the gap — buildChartFromAnalyticalTable returns null for a
 *   single-row table. By charting a leaderboard frame instead, the fast path
 *   reaches parity with the full-loop minimal-depth path (which already emits
 *   one deterministic chart) without re-parsing the question or padding the
 *   answer with speculative extras (invariant #12 stays intact).
 *
 * HOW IT CONNECTS
 *   The PURE seam keeps the executor call in quickAnswerPath (which owns the
 *   DuckDB / in-memory branch). The measure-alias rule mirrors the executor's
 *   `outputAliasForAgg` (queryPlanDuckdbExecutor.ts) and is PINNED back onto the
 *   aggregation so the output column name is fixed and the sort column always
 *   matches (the sort allowlist accepts both an explicit alias and
 *   `${col}_${op}` — queryPlanExecutor.ts).
 */
import type { ChartSpec, DataSummary } from "../../../shared/schema.js";
import type { QueryPlanBody } from "../../queryPlanExecutor.js";
import { isIdColumn, getCountNameForIdColumn } from "../../columnIdHeuristics.js";
import { buildChartFromAnalyticalTable } from "./chartFromTable.js";

/** Chart-readable cap. Stays under chartFromTable's 60-cardinality ceiling so a
 *  high-cardinality leaderboard still produces a chart (top-N), while the pivot
 *  retains the full set. */
export const QUICK_ANSWER_CHART_ROW_CAP = 50;

type AggregationEntry = NonNullable<QueryPlanBody["aggregations"]>[number];

/**
 * Replicate the executor's output-column naming (`outputAliasForAgg` in
 * queryPlanDuckdbExecutor.ts, mirrored in dataTransform.ts) for ONE aggregation.
 * Returns the column name the executor will emit for this aggregation. Used both
 * to pin the leaderboard sort column and to find the measure column in result
 * rows when ordering the chart frame.
 */
export function aggregationOutputAlias(agg: AggregationEntry): string {
  if (agg.alias?.trim()) return agg.alias.trim();
  if (agg.operation === "count" && isIdColumn(agg.column)) {
    return getCountNameForIdColumn(agg.column);
  }
  if (agg.operation === "countIf") return "matching";
  if (agg.operation === "sumIf") return `${agg.column}_sumIf`;
  if (agg.perDimension) {
    const safePerDim = agg.perDimension
      .replace(/[^A-Za-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "");
    return `${agg.column}_${agg.operation}_per_${safePerDim}`;
  }
  return `${agg.column}_${agg.operation}`;
}

export interface LeaderboardPlanResult {
  plan: QueryPlanBody;
  /** The output column the leaderboard is sorted by (also the chart's measure). */
  measureAlias: string;
}

/**
 * Derive a leaderboard variant of an executed plan: same groupBy + measure,
 * sorted by the measure, capped at QUICK_ANSWER_CHART_ROW_CAP rows. The result
 * is re-executed by the caller to obtain the full ranking for the chart.
 *
 * Returns null when the plan has no breakdown (no `groupBy`) or no measure
 * (neither an aggregation nor a computed aggregation) — a pure scalar lookup
 * gets no chart.
 *
 * The sort DIRECTION is inherited from the original plan when present (so a
 * "lowest / bottom" ask keeps its ascending order); defaults to descending.
 */
export function deriveLeaderboardPlan(
  plan: QueryPlanBody
): LeaderboardPlanResult | null {
  if (!plan.groupBy || plan.groupBy.length === 0) return null;

  const aggs = plan.aggregations ?? [];
  const computed = plan.computedAggregations ?? [];

  const next: QueryPlanBody = { ...plan };
  let measureAlias: string;

  if (aggs.length > 0) {
    // Pin the first aggregation's output alias so the sort column is guaranteed
    // to exist in the result set regardless of which executor runs.
    measureAlias = aggregationOutputAlias(aggs[0]!);
    next.aggregations = aggs.map((a, i) =>
      i === 0 ? { ...a, alias: measureAlias } : { ...a }
    );
  } else if (computed.length > 0) {
    // Rank by the final computed alias (e.g. a ratio output). Computed aliases
    // are valid sort targets at the executor layer.
    measureAlias = computed[computed.length - 1]!.alias;
    next.computedAggregations = computed.map((c) => ({ ...c }));
  } else {
    return null;
  }

  const direction = plan.sort?.[0]?.direction ?? "desc";
  next.sort = [{ column: measureAlias, direction }];
  next.limit = QUICK_ANSWER_CHART_ROW_CAP;

  return { plan: next, measureAlias };
}

export interface BuildQuickAnswerChartInput {
  /** Rows the quick-answer query returned (the answer frame). */
  rows: Record<string, unknown>[];
  /** Rows from the re-executed leaderboard plan, or null if not re-executed. */
  leaderboardRows: Record<string, unknown>[] | null;
  /** The executed (normalized) plan — used to find the measure column. */
  plan: QueryPlanBody;
  summary: DataSummary;
  question: string;
}

/**
 * Build ONE chart for a quick-answer lookup, or null when there's nothing
 * sensible to chart.
 *
 * Source frame:
 *   - the answer rows when they already carry the leaderboard (≥2 rows);
 *   - otherwise the re-executed leaderboard rows.
 * The frame is ordered by the measure (descending) and capped before charting
 * so a high-cardinality breakdown becomes a readable top-N. The shared
 * deterministic builder (buildChartFromAnalyticalTable) makes the final
 * line-vs-bar / axis decisions, so this chart looks identical to planner-built
 * ones and auto-sorts by value for display.
 */
export function buildQuickAnswerChart(
  input: BuildQuickAnswerChartInput
): ChartSpec | null {
  const { rows, leaderboardRows, plan, summary, question } = input;

  // Only a breakdown (groupBy) can become a chart; pure scalars get none.
  if (!plan.groupBy || plan.groupBy.length === 0) return null;

  const source =
    rows.length >= 2
      ? rows
      : leaderboardRows && leaderboardRows.length >= 2
        ? leaderboardRows
        : null;
  if (!source || source.length < 2) return null;

  const frame = orderAndCapByMeasure(source, plan);
  const columns = inferColumns(frame);
  if (columns.length < 2) return null;

  return buildChartFromAnalyticalTable({
    table: { rows: frame, columns },
    summary,
    question,
  });
}

/**
 * Order the rows by the plan's primary measure (descending) and cap to a
 * chart-readable size, so the chart shows the TOP performers even when the
 * source frame is unsorted or larger than the cap. Falls back to a plain cap
 * when the measure column isn't numeric in the rows.
 */
function orderAndCapByMeasure(
  rows: Record<string, unknown>[],
  plan: QueryPlanBody
): Record<string, unknown>[] {
  const measureAlias = primaryMeasureAlias(plan);
  if (measureAlias) {
    const allNumeric = rows.every(
      (r) => typeof toNumber(r[measureAlias]) === "number"
    );
    if (allNumeric) {
      const sorted = rows
        .slice()
        .sort((a, b) => (toNumber(b[measureAlias]) ?? 0) - (toNumber(a[measureAlias]) ?? 0));
      return sorted.slice(0, QUICK_ANSWER_CHART_ROW_CAP);
    }
  }
  return rows.slice(0, QUICK_ANSWER_CHART_ROW_CAP);
}

/** The output column of the plan's primary measure, or null for a scalar plan. */
function primaryMeasureAlias(plan: QueryPlanBody): string | null {
  const aggs = plan.aggregations ?? [];
  if (aggs.length > 0) return aggregationOutputAlias(aggs[0]!);
  const computed = plan.computedAggregations ?? [];
  if (computed.length > 0) return computed[computed.length - 1]!.alias;
  return null;
}

function toNumber(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** Union of keys across a sample of rows (handles sparse rows). */
function inferColumns(rows: Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows.slice(0, 20)) {
    for (const k of Object.keys(r)) {
      if (!seen.has(k)) {
        seen.add(k);
        out.push(k);
      }
    }
  }
  return out;
}
