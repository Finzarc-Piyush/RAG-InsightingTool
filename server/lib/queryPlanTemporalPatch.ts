import { detectPeriodFromQuery } from "./dateUtils.js";
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

const TREND_OVER_TIME_RE =
  /\b(trend|over\s+time|time\s+series|evolution|trajectory|how\s+.+\s+(changed|evolved)|temporal\s+pattern)\b/i;

/**
 * When the user asks for a trend / over time and the plan groups only by a raw date column with no
 * period, default to monthly aggregation to avoid one row per day and unreadable charts.
 * Runs after {@link patchExecuteQueryPlanDateAggregation} so explicit period phrases still win.
 */
export function patchExecuteQueryPlanTrendCoarserGrain(
  step: ExecuteQueryPlanStepLike,
  question: string,
  dateColumns: readonly string[]
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

  plan.dateAggregationPeriod = "month";
}
