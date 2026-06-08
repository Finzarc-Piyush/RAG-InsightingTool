import { detectPeriodFromQuery, normalizeDateToPeriod } from "./dateUtils.js";
import {
  hasExplicitBreakdownOrGrain,
  vagueTemporalTrendQuestion,
} from "./questionAggregationPolicy.js";
import {
  isTemporalFacetColumnKey,
  parseTemporalFacetDisplayKey,
  facetColumnKey,
  detectCoarseTimeIntentFromMessage,
  GRAIN_TO_PERIOD,
  type TemporalFacetGrain,
} from "./temporalFacetColumns.js";

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
 * absent the patch falls back to the pre-T2 behaviour ("month"). minIso/maxIso
 * (Wave T4) let `distinctBucketsForGrain` count how many buckets a coarse grain
 * would yield, so the patch can REFINE a collapsing facet (e.g. Month → Day on a
 * single-month daily span), not just coarsen a raw date. */
export type DateRangeByColumn = ReadonlyMap<
  string,
  { spanDays: number; distinctDayCount: number; minIso?: string; maxIso?: string }
>;

/** Coarse→fine ordinal so we only ever refine to a STRICTLY finer grain. */
const GRAIN_RANK: Record<TemporalFacetGrain, number> = {
  date: 0,
  week: 1,
  month: 2,
  quarter: 3,
  half_year: 4,
  year: 5,
};

/** `pickTrendGrainForSpan` returns SQL periods; map them to facet grains. */
const PERIOD_TO_FACET_GRAIN: Record<
  "day" | "week" | "month" | "quarter",
  TemporalFacetGrain
> = { day: "date", week: "week", month: "month", quarter: "quarter" };

/**
 * How many distinct buckets a grain yields over [minIso, maxIso]. `date` →
 * `distinctDayCount` directly; coarser grains walk the span day-by-day and
 * bucket via `normalizeDateToPeriod` (matching the upload-time facet keys).
 * Returns 1 when the span can't be resolved (the safe "single bucket" answer),
 * and is bounded so a multi-year span can't dominate planning time.
 */
export function distinctBucketsForGrain(
  range: { spanDays: number; distinctDayCount: number; minIso?: string; maxIso?: string },
  grain: TemporalFacetGrain,
): number {
  if (grain === "date") return Math.max(0, range.distinctDayCount ?? 0);
  if (!range.minIso || !range.maxIso) return 1;
  const parse = (iso: string): Date | null => {
    const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const start = parse(range.minIso);
  const end = parse(range.maxIso);
  if (!start || !end || end.getTime() < start.getTime()) return 1;
  const period = GRAIN_TO_PERIOD[grain];
  const keys = new Set<string>();
  const MAX_STEPS = 4000; // ~11 years of daily steps — beyond this any coarse grain clearly has ≥2 buckets.
  let steps = 0;
  const cur = new Date(start.getTime());
  while (cur.getTime() <= end.getTime() && steps < MAX_STEPS) {
    const norm = normalizeDateToPeriod(new Date(cur.getTime()), period);
    if (norm) keys.add(norm.normalizedKey);
    cur.setDate(cur.getDate() + 1);
    steps += 1;
  }
  if (steps >= MAX_STEPS) return Math.max(keys.size, 2);
  return Math.max(1, keys.size);
}

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
): void {
  if (step.tool !== "execute_query_plan") return;
  const q = question.trim();
  if (!q) return;
  if (/\b(daily|per\s+day|each\s+day|day\s+by\s+day)\b/i.test(q)) return;
  if (!TREND_OVER_TIME_RE.test(q)) return;
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
