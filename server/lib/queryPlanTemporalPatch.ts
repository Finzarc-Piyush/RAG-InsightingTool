import { detectPeriodFromQuery } from "./dateUtils.js";
import {
  hasExplicitBreakdownOrGrain,
  vagueTemporalTrendQuestion,
} from "./questionAggregationPolicy.js";
import { isTemporalFacetColumnKey } from "./temporalFacetColumns.js";

/** Minimal shape for planner steps; keeps tests free of planner → LLM import chain. */
export type ExecuteQueryPlanStepLike = {
  tool: string;
  args: Record<string, unknown>;
};

/** When groupBy includes a date column but the model omitted dateAggregationPeriod, bind from question. */
export function patchExecuteQueryPlanDateAggregation(
  step: ExecuteQueryPlanStepLike,
  question: string,
  dateColumns: readonly string[]
): void {
  if (step.tool !== "execute_query_plan") return;
  const plan = step.args.plan as Record<string, unknown> | undefined;
  if (!plan || typeof plan !== "object") return;
  if (plan.dateAggregationPeriod != null) return;
  const groupBy = plan.groupBy as string[] | undefined;
  if (!groupBy?.length) return;
  const dateSet = new Set(dateColumns);
  if (!groupBy.some((c) => dateSet.has(c))) return;
  const hint = detectPeriodFromQuery(question);
  if (!hint) return;
  plan.dateAggregationPeriod = hint;
}

export const TREND_OVER_TIME_RE =
  /\b(trend|over\s+time|time\s+series|evolution|trajectory|how\s+.+\s+(changed|evolved)|temporal\s+pattern)\b/i;

/** Wave T2 · per-source-date-column span metadata, as populated by
 * `createDataSummary` (Wave T1). Optional input to the grain patch; when
 * absent the patch falls back to the pre-T2 behaviour ("month"). */
export type DateRangeByColumn = ReadonlyMap<
  string,
  { spanDays: number; distinctDayCount: number }
>;

/** Wave T2 · pure picker. Mirrors the display-side thresholds in
 * `temporalGrain.ts`. Returns the SQL aggregation period the
 * planner should bind to `plan.dateAggregationPeriod`. */
export function pickTrendGrainForSpan(
  spanDays: number,
  distinctDayCount: number,
): "day" | "week" | "month" | "quarter" {
  if (!Number.isFinite(spanDays) || spanDays <= 0 || distinctDayCount <= 1) {
    return "month";
  }
  if (spanDays <= 90) return "day";
  if (spanDays <= 365) return "week";
  if (spanDays <= 365 * 5) return "month";
  return "quarter";
}

/**
 * When the user asks for a trend / over time and the plan groups only by a raw date column with no
 * period, pick a calibrated aggregation period (Day / Week / Month / Quarter) from the dataset's
 * post-parse date span. Falls back to "month" when no span metadata is provided (pre-T2 behaviour).
 *
 * Runs after {@link patchExecuteQueryPlanDateAggregation} so explicit period phrases still win.
 */
export function patchExecuteQueryPlanTrendCoarserGrain(
  step: ExecuteQueryPlanStepLike,
  question: string,
  dateColumns: readonly string[],
  dateRangeByColumn?: DateRangeByColumn,
): void {
  if (step.tool !== "execute_query_plan") return;
  const q = question.trim();
  if (!q) return;
  if (/\b(daily|per\s+day|each\s+day|day\s+by\s+day)\b/i.test(q)) return;
  if (!TREND_OVER_TIME_RE.test(q)) return;

  const plan = step.args.plan as Record<string, unknown> | undefined;
  if (!plan || typeof plan !== "object") return;
  if (plan.dateAggregationPeriod != null) return;

  const groupBy = plan.groupBy as string[] | undefined;
  if (!groupBy || groupBy.length !== 1) return;

  const dateSet = new Set(dateColumns);
  const g0 = groupBy[0];
  if (!dateSet.has(g0)) return;
  if (isTemporalFacetColumnKey(g0)) return;

  const range = dateRangeByColumn?.get(g0);
  plan.dateAggregationPeriod = range
    ? pickTrendGrainForSpan(range.spanDays, range.distinctDayCount)
    : "month";
}

/**
 * When the user asks a vague trend / over-time question but the model omitted groupBy
 * (aggregations only → one row), inject the primary date column + monthly bucketing so
 * {@link promoteQueryPlanDateAggregationToFacetGroupBy} can align with pivot facets.
 * Runs after {@link patchExecuteQueryPlanTrendCoarserGrain}.
 */
export function patchExecuteQueryPlanTrendMissingGroupBy(
  step: ExecuteQueryPlanStepLike,
  question: string,
  dateColumns: readonly string[]
): void {
  if (step.tool !== "execute_query_plan") return;
  const q = question.trim();
  if (!q) return;
  if (/\b(daily|per\s+day|each\s+day|day\s+by\s+day)\b/i.test(q)) return;

  const trendIntent =
    TREND_OVER_TIME_RE.test(q) || vagueTemporalTrendQuestion(question);
  if (!trendIntent) return;
  if (hasExplicitBreakdownOrGrain(question)) return;

  const plan = step.args.plan as Record<string, unknown> | undefined;
  if (!plan || typeof plan !== "object") return;

  const aggs = plan.aggregations as unknown[] | undefined;
  if (!aggs?.length) return;

  const groupBy = plan.groupBy as string[] | undefined;
  if (Array.isArray(groupBy) && groupBy.length > 0) return;

  if (!dateColumns.length) return;

  plan.groupBy = [dateColumns[0]];
  if (plan.dateAggregationPeriod == null || plan.dateAggregationPeriod === undefined) {
    plan.dateAggregationPeriod = "month";
  }
}
