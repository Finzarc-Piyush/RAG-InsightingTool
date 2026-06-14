import { detectPeriodFromQuery } from "./dateUtils.js";
import {
  hasExplicitBreakdownOrGrain,
  vagueTemporalTrendQuestion,
} from "./questionAggregationPolicy.js";
import {
  isTemporalFacetColumnKey,
  parseTemporalFacetDisplayKey,
  facetColumnKey,
  detectCoarseTimeIntentFromMessage,
} from "./temporalFacetColumns.js";
import {
  GRAIN_RANK,
  PERIOD_TO_FACET_GRAIN,
  distinctBucketsForGrain,
  pickTrendGrainForSpan,
  type DateRange,
  type DateRangeByColumn,
} from "./temporalGrainAuthority.js";

// These span primitives now live in temporalGrainAuthority.ts (the leaf grain
// module). Re-exported here so existing importers of these names keep working.
export {
  GRAIN_RANK,
  PERIOD_TO_FACET_GRAIN,
  distinctBucketsForGrain,
  pickTrendGrainForSpan,
};
export type { DateRange, DateRangeByColumn };

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

/**
 * Wave T4 · Span-aware temporal grain for trend / "over time" questions.
 * Scans the plan's groupBy for the FIRST temporal element (other dimensions are
 * left untouched, so multi-column group-bys like ["Month · Date","Cluster Name"]
 * are handled) and aligns its grain to the dataset's actual date span:
 *
 *   • raw date column, no period  → bind dateAggregationPeriod from the span
 *     (Day / Week / Month / Quarter) — the original T2 behaviour, preserved.
 *   • temporal facet column (e.g. "Month · Date") that COLLAPSES to a single
 *     bucket for the span → REMAP it to the span-appropriate finer facet
 *     (e.g. "Day · Date" for a single month of daily data). Only refines to a
 *     strictly FINER grain that actually yields ≥2 buckets, so genuinely
 *     coarse-grained datasets (multi-year monthly) are never forced to day.
 *
 * Falls back to "month" for the raw-date case when no span metadata exists
 * (pre-T2 behaviour). Honours explicit user grain wording ("monthly", "weekly",
 * "by quarter", …) — those win and suppress refinement.
 *
 * Runs after {@link patchExecuteQueryPlanDateAggregation} so explicit period
 * phrases still win.
 */
export function patchExecuteQueryPlanTrendGrain(
  step: ExecuteQueryPlanStepLike,
  question: string,
  dateColumns: readonly string[],
  dateRangeByColumn?: DateRangeByColumn,
  opts?: { isDashboard?: boolean },
): void {
  if (step.tool !== "execute_query_plan") return;
  const q = question.trim();
  if (!q) return;
  if (/\b(daily|per\s+day|each\s+day|day\s+by\s+day)\b/i.test(q)) return;
  // W3 · a dashboard request ("build a pjp dashboard") rarely says "trend"/"over
  // time", yet the planner still emits a primary trend step. Without this, that
  // step keeps a Month facet that collapses to ONE bucket on a single-month span
  // → the "only one temporal bucket" caveat. For dashboards we therefore allow
  // grain refinement regardless of trend wording (the refinement below is purely
  // defensive — it only acts when a facet actually collapses to <2 buckets).
  if (!opts?.isDashboard && !TREND_OVER_TIME_RE.test(q)) return;
  // Explicit grain wording from the user wins — never override "monthly"/"by week"/etc.
  if (detectCoarseTimeIntentFromMessage(q)) return;

  const plan = step.args.plan as Record<string, unknown> | undefined;
  if (!plan || typeof plan !== "object") return;

  const groupBy = plan.groupBy as unknown;
  if (!Array.isArray(groupBy) || groupBy.length === 0) return;

  const dateSet = new Set(dateColumns);

  for (let i = 0; i < groupBy.length; i++) {
    const g = groupBy[i];
    if (typeof g !== "string") continue;

    // Raw date element with no explicit period → bind the span grain (T2).
    if (dateSet.has(g) && !isTemporalFacetColumnKey(g)) {
      if (plan.dateAggregationPeriod != null) return; // explicit period already chosen
      const range = dateRangeByColumn?.get(g);
      plan.dateAggregationPeriod = range
        ? pickTrendGrainForSpan(range.spanDays, range.distinctDayCount)
        : "month";
      return;
    }

    // Temporal facet element → refine only if it collapses for this span.
    const parsed = parseTemporalFacetDisplayKey(g);
    if (!parsed) continue;
    const range = dateRangeByColumn?.get(parsed.sourceColumn);
    if (!range) return; // no span metadata → leave untouched (safe)

    const targetGrain = PERIOD_TO_FACET_GRAIN[
      pickTrendGrainForSpan(range.spanDays, range.distinctDayCount)
    ];
    // Only ever refine to a STRICTLY finer grain.
    if (GRAIN_RANK[parsed.grain] <= GRAIN_RANK[targetGrain]) return;
    // The chosen grain must actually collapse, and the target must actually help.
    if (distinctBucketsForGrain(range, parsed.grain) >= 2) return;
    if (distinctBucketsForGrain(range, targetGrain) < 2) return;

    groupBy[i] = facetColumnKey(parsed.sourceColumn, targetGrain);
    if (plan.dateAggregationPeriod != null) plan.dateAggregationPeriod = undefined;
    return;
  }
}

/**
 * Back-compat alias — the function now refines coarse facets as well as
 * coarsening raw dates. Existing callers (planner) and the Wave T2 test import
 * this name; keep it pointing at the generalized implementation.
 */
export const patchExecuteQueryPlanTrendCoarserGrain = patchExecuteQueryPlanTrendGrain;

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
