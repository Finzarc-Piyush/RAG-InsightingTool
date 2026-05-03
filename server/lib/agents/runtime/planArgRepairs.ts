import type { PlanStep } from "./types.js";
import type { InferredFilter } from "../utils/inferFiltersFromQuestion.js";
import type {
  DataSummary,
  DimensionHierarchy,
  WideFormatTransform,
} from "../../../shared/schema.js";
import { findMatchingColumn } from "../utils/columnMatcher.js";

/** Tools that accept `dimensionFilters` at args[plan].dimensionFilters. */
const NESTED_PLAN_TOOLS = new Set(["execute_query_plan"]);
/** Tools that accept `dimensionFilters` at the top level of args. */
const TOP_LEVEL_FILTER_TOOLS = new Set([
  "run_correlation",
  "run_segment_driver_analysis",
  "breakdown_ranking",
  "run_two_segment_compare",
]);

function dimensionFilterHost(step: PlanStep): Record<string, unknown> | null {
  if (NESTED_PLAN_TOOLS.has(step.tool)) {
    const plan = step.args?.plan;
    return plan && typeof plan === "object" ? (plan as Record<string, unknown>) : null;
  }
  if (TOP_LEVEL_FILTER_TOOLS.has(step.tool)) {
    return (step.args as Record<string, unknown>) ?? null;
  }
  return null;
}

/**
 * Inject inferred filters into any step that accepts dimensionFilters but
 * didn't emit one for an inferred column. Brief-emitted or planner-emitted
 * filters for the same (column, op) are preserved — this only fills gaps.
 * Returns the list of columns that were injected (for logging / tests).
 */
export function ensureInferredFiltersOnStep(
  step: PlanStep,
  inferredFilters: InferredFilter[] | undefined
): string[] {
  if (!inferredFilters?.length) return [];
  const host = dimensionFilterHost(step);
  if (!host) return [];

  const existing = Array.isArray(host.dimensionFilters)
    ? (host.dimensionFilters as Array<Record<string, unknown>>)
    : [];
  const injected: string[] = [];
  const seen = new Set<string>();
  for (const f of existing) {
    if (!f || typeof f !== "object") continue;
    const col = typeof f.column === "string" ? f.column : null;
    const op = typeof f.op === "string" ? f.op : "in";
    if (col) seen.add(`${col}|${op}`);
  }
  const next = [...existing];
  for (const f of inferredFilters) {
    const key = `${f.column}|${f.op}`;
    if (seen.has(key)) continue;
    next.push({
      column: f.column,
      op: f.op,
      values: f.values,
      match: f.match,
    });
    injected.push(f.column);
  }
  if (injected.length) host.dimensionFilters = next;
  return injected;
}

/**
 * H3 / RD1 · Returns true when the user's question is asking *about* the
 * rollup row rather than comparing peer items. In either case, the
 * deterministic exclude filter must NOT fire — the rollup row needs to
 * be in the data (a) for direct lookups ("show me FEMALE SHOWER GEL")
 * and (b) so the LLM can use it as the denominator for share-of-category
 * questions ("MARICO's share of the category").
 */
const SHARE_PATTERN_RE =
  /(?:\b(?:share|contribution|percentage|percent|fraction|portion|proportion)\b|%)\s+(?:of|in|to|within|out\s+of|relative\s+to|compared\s+to|vs\.?)\b/i;
const CATEGORY_PATTERN_RE =
  /\b(category|categor[iy]|total|grand\s+total|overall|whole|entire|full|everything|all)\b/i;

export function shouldSkipRollupExclude(
  userQuestion: string | undefined,
  hierarchy: DimensionHierarchy
): { skip: boolean; reason: "mention" | "share-of-category" | null } {
  const q = (userQuestion ?? "").trim();
  if (!q) return { skip: false, reason: null };
  const qLower = q.toLowerCase();
  const rollupLower = hierarchy.rollupValue.toLowerCase();
  if (rollupLower && qLower.includes(rollupLower)) {
    return { skip: true, reason: "mention" };
  }
  // RD1 · "MARICO's share of the category" / "% of total Products" /
  // "what fraction of the overall belongs to MARICO" — share-pattern
  // combined with EITHER the column name OR a generic category word
  // means the user wants the rollup as denominator. Skip the exclude
  // so the rollup row stays in the data; let the narrator + planner
  // hint guide the LLM to use it as the denominator.
  if (SHARE_PATTERN_RE.test(qLower)) {
    const colLower = hierarchy.column.toLowerCase();
    if (qLower.includes(colLower) || CATEGORY_PATTERN_RE.test(qLower)) {
      return { skip: true, reason: "share-of-category" };
    }
  }
  return { skip: false, reason: null };
}

/**
 * H3 · Auto-inject `not_in` filters that exclude declared rollup values from
 * the dimensions a step is about to group/rank by. Without this, breakdowns
 * like "Total_Sales by Products" are dominated by the category-total row
 * (e.g. FEMALE SHOWER GEL = sum of MARICO + PURITE + ...) which is just
 * "the parent always wins".
 *
 * Skips injection when:
 *   - The user question explicitly mentions the rollup value (case-insensitive)
 *     — the user is asking *about* the rollup, not comparing peers.
 *   - RD1 · The user question matches a "share/contribution/% of the
 *     category" pattern — the user wants the rollup AS the denominator.
 *   - The step args already include any filter on the same column whose `in`
 *     values contain the rollup value — explicit user-driven inclusion wins.
 *   - The step args already include a `not_in` filter on the same column whose
 *     values include the rollup value — already excluded.
 *
 * Returns the list of `<column>=<rollupValue>` strings that were injected
 * (for logging / tests). Empty array means no injection happened.
 */
export function injectRollupExcludeFilters(
  step: PlanStep,
  hierarchies: DimensionHierarchy[] | undefined,
  userQuestion: string | undefined
): string[] {
  if (!hierarchies?.length) return [];
  const host = dimensionFilterHost(step);
  if (!host) return [];

  const dims = collectGroupingDimensions(step);
  if (dims.length === 0) return [];

  const existing = Array.isArray(host.dimensionFilters)
    ? (host.dimensionFilters as Array<Record<string, unknown>>)
    : [];

  const injected: string[] = [];
  const next = [...existing];

  for (const col of dims) {
    // ML1 · multi-level same-column hierarchies: the user can declare
    // more than one rollup per column (e.g. "World" AND "Asia" are both
    // category totals in a Geography column). Collect ALL rollup values
    // for this column and decide per-value whether to exclude.
    const hierarchiesForCol = hierarchies.filter((h) => h.column === col);
    if (hierarchiesForCol.length === 0) continue;

    const valuesToExclude: string[] = [];
    for (const hierarchy of hierarchiesForCol) {
      const rollupLower = hierarchy.rollupValue.toLowerCase();
      if (!rollupLower) continue;
      const skip = shouldSkipRollupExclude(userQuestion, hierarchy);
      if (skip.skip) continue;

      let alreadyHandled = false;
      for (const f of existing) {
        if (!f || typeof f !== "object") continue;
        if (f.column !== col) continue;
        const values = Array.isArray(f.values)
          ? (f.values as unknown[]).map((v) =>
              typeof v === "string" ? v.toLowerCase() : ""
            )
          : [];
        if (values.includes(rollupLower)) {
          alreadyHandled = true;
          break;
        }
      }
      if (alreadyHandled) continue;
      valuesToExclude.push(hierarchy.rollupValue);
      injected.push(`${col}=${hierarchy.rollupValue}`);
    }

    if (valuesToExclude.length > 0) {
      next.push({
        column: col,
        op: "not_in",
        values: valuesToExclude,
        match: "case_insensitive",
      });
    }
  }

  if (injected.length) host.dimensionFilters = next;
  return injected;
}

/**
 * RD1 · For each declared hierarchy, classify how the user's question
 * relates to it. Used to surface a planner prompt hint that tells the
 * LLM to use the rollup as denominator for share-of-category questions.
 */
export interface HierarchyIntent {
  column: string;
  rollupValue: string;
  intent: "share-of-category" | "rollup-mention" | "peer-comparison";
}

export function classifyHierarchyIntent(
  userQuestion: string | undefined,
  hierarchies: DimensionHierarchy[] | undefined
): HierarchyIntent[] {
  if (!hierarchies?.length) return [];
  const out: HierarchyIntent[] = [];
  for (const h of hierarchies) {
    const skip = shouldSkipRollupExclude(userQuestion, h);
    out.push({
      column: h.column,
      rollupValue: h.rollupValue,
      intent:
        skip.reason === "share-of-category"
          ? "share-of-category"
          : skip.reason === "mention"
            ? "rollup-mention"
            : "peer-comparison",
    });
  }
  return out;
}

function collectGroupingDimensions(step: PlanStep): string[] {
  const dims: string[] = [];
  if (step.tool === "breakdown_ranking") {
    const col = (step.args as Record<string, unknown>)?.breakdownColumn;
    if (typeof col === "string" && col.trim()) dims.push(col);
  }
  if (step.tool === "execute_query_plan") {
    const plan = (step.args as Record<string, unknown>)?.plan;
    const groupBy = (plan as Record<string, unknown> | undefined)?.groupBy;
    if (Array.isArray(groupBy)) {
      for (const g of groupBy) {
        if (typeof g === "string" && g.trim()) dims.push(g);
      }
    }
  }
  return dims;
}

/**
 * WPF2 · Vocabulary mapping question keywords → metric value families.
 * Compound-shape datasets carry a `Metric` column (e.g. value_sales / volume).
 * If the planner's step touches the value column without filtering by metric,
 * we silently sum across mixed metrics → garbage. This vocab lets us infer
 * the user's intended metric from question phrasing.
 *
 * Each entry's `keywords` are matched as case-insensitive whole-word patterns
 * against the user question; `metricMatch` is a regex tested against each
 * distinct value of the dataset's metric column to find the canonical value.
 *
 * Order matters: more specific entries first so "value sales" hits before
 * a bare "value" wildcard.
 */
const METRIC_VOCABULARY: ReadonlyArray<{
  keywords: RegExp;
  metricMatch: RegExp;
  family: "value_sales" | "volume" | "units" | "distribution" | "price";
}> = [
  {
    family: "value_sales",
    keywords: /\b(value\s+sales|sales\s+value|revenue|turnover|gmv|sales)\b/i,
    metricMatch: /value[\s_-]*sales|sales[\s_-]*value|revenue|turnover|gmv|^sales$/i,
  },
  {
    family: "volume",
    keywords: /\b(volume|tonnage|kg|kilos?|litres?|liters?|cartons?|cases?)\b/i,
    metricMatch: /\bvolume\b|tonnage|^kg$|carton|case/i,
  },
  {
    family: "units",
    keywords: /\b(units?|pieces?|packs?|bottles?)\b/i,
    metricMatch: /\bunits?\b|pieces?|packs?/i,
  },
  {
    family: "distribution",
    keywords: /\b(distribution|numeric\s+distribution|nd|weighted\s+distribution|wd)\b/i,
    metricMatch: /distribution|^nd$|^wd$/i,
  },
  {
    family: "price",
    keywords: /\b(price|asp|price\s+per\s+unit|unit\s+price)\b/i,
    metricMatch: /\bprice\b|asp/i,
  },
];

/**
 * Returns the distinct metric values that match the user's intent, in the
 * order they appear in `distinctMetricValues`. Empty array means no
 * vocabulary keyword fired — caller should apply a fallback heuristic.
 *
 * Multiple matches can fire when the user explicitly cross-compares
 * ("value sales vs volume") — the caller should expand groupBy in that case
 * rather than inject a single-metric filter.
 */
export function resolveMetricFromQuestion(
  userQuestion: string | undefined,
  distinctMetricValues: ReadonlyArray<string>
): string[] {
  const q = (userQuestion ?? "").trim();
  if (!q) return [];
  const matched = new Set<string>();
  for (const entry of METRIC_VOCABULARY) {
    if (!entry.keywords.test(q)) continue;
    for (const v of distinctMetricValues) {
      if (entry.metricMatch.test(v)) {
        matched.add(v);
      }
    }
  }
  return distinctMetricValues.filter((v) => matched.has(v));
}

/**
 * WPF2 · Detect when a step touches the wide-format value column. Mirrors the
 * tool-args inspection pattern in `dimensionFilterHost` / `collectGroupingDimensions`.
 *
 * Tools considered:
 *   - execute_query_plan: any aggregation entry whose `column` is `valueColumn`.
 *   - breakdown_ranking:  `args.metricColumn === valueColumn`.
 *   - run_two_segment_compare: `args.metricColumn === valueColumn`.
 *   - run_correlation:    `args.targetVariable === valueColumn`.
 *   - run_segment_driver_analysis: `args.outcomeColumn === valueColumn`.
 */
function stepTouchesValueColumn(step: PlanStep, valueColumn: string): boolean {
  if (step.tool === "execute_query_plan") {
    const plan = (step.args as Record<string, unknown>)?.plan as
      | Record<string, unknown>
      | undefined;
    const aggs = plan?.aggregations;
    if (Array.isArray(aggs)) {
      for (const a of aggs) {
        const col = (a as { column?: unknown })?.column;
        if (typeof col === "string" && col === valueColumn) return true;
      }
    }
    return false;
  }
  if (step.tool === "breakdown_ranking") {
    return (step.args as { metricColumn?: unknown })?.metricColumn === valueColumn;
  }
  if (step.tool === "run_two_segment_compare") {
    return (step.args as { metricColumn?: unknown })?.metricColumn === valueColumn;
  }
  if (step.tool === "run_correlation") {
    return (step.args as { targetVariable?: unknown })?.targetVariable === valueColumn;
  }
  if (step.tool === "run_segment_driver_analysis") {
    return (step.args as { outcomeColumn?: unknown })?.outcomeColumn === valueColumn;
  }
  return false;
}

/**
 * WPF2 · Whether the step's groupBy already includes the metric column,
 * indicating the user wants a cross-metric breakdown (no single-metric filter
 * should be injected — let each metric stay separable).
 */
function stepGroupsByMetric(step: PlanStep, metricColumn: string): boolean {
  if (step.tool === "execute_query_plan") {
    const plan = (step.args as Record<string, unknown>)?.plan as
      | Record<string, unknown>
      | undefined;
    const groupBy = plan?.groupBy;
    if (Array.isArray(groupBy)) {
      return groupBy.some((g) => typeof g === "string" && g === metricColumn);
    }
    return false;
  }
  if (step.tool === "breakdown_ranking") {
    return (
      (step.args as { breakdownColumn?: unknown })?.breakdownColumn === metricColumn
    );
  }
  return false;
}

/**
 * WPF2 · Add the metric column to the step's groupBy (for cross-metric
 * questions). Mutates step.args. Returns true when the column was added,
 * false when no addable target existed (silent no-op for tools without
 * a groupBy concept).
 */
function addMetricToGroupBy(step: PlanStep, metricColumn: string): boolean {
  if (step.tool === "execute_query_plan") {
    const plan = (step.args as Record<string, unknown>)?.plan as
      | Record<string, unknown>
      | undefined;
    if (!plan) return false;
    const groupBy = Array.isArray(plan.groupBy) ? [...(plan.groupBy as unknown[])] : [];
    if (groupBy.some((g) => typeof g === "string" && g === metricColumn)) return false;
    groupBy.unshift(metricColumn);
    plan.groupBy = groupBy;
    return true;
  }
  // breakdown_ranking only supports a single breakdownColumn — replacing it
  // with metric would change the question, so we don't auto-expand here.
  return false;
}

export interface CompoundMetricGuardResult {
  /** Metric values injected as a dimensionFilter. */
  injectedFilter?: string[];
  /** True when the metric column was added to groupBy for cross-metric intent. */
  expandedGroupBy?: boolean;
  /** When no value-column touch / no compound shape / metric already handled — empty no-op. */
  reason?:
    | "not_compound"
    | "no_value_touch"
    | "no_filter_host"
    | "metric_filter_already_present"
    | "metric_in_group_by"
    | "no_metrics_known"
    | "matched_zero_distinct_values";
  /** When matched=0 and we fell back to the value-sales heuristic. */
  fallbackUsed?: boolean;
}

/**
 * WPF2 · Inject a deterministic Metric-column filter (or expand groupBy by
 * the Metric column for cross-metric intent) on compound-shape datasets.
 *
 * Mirrors the H3 dimension-hierarchy injection pattern. Runs in `planner.ts`
 * right after `injectRollupExcludeFilters`.
 *
 * Why: compound-shape long-form datasets have a `Metric` column whose values
 * (e.g. value_sales / volume) describe what the `Value` column means. Any
 * SUM(Value) without a Metric filter mixes incompatible units → garbage.
 *
 * Decision tree (per step):
 *   1. Not compound shape OR step doesn't touch valueColumn → no-op.
 *   2. dimensionFilters already include a filter on metricColumn → no-op.
 *   3. groupBy already includes metricColumn → user wants cross-metric breakdown → no-op.
 *   4. Question keywords match ≥2 distinct metric values → expand groupBy
 *      by metricColumn (cross-metric).
 *   5. Question keywords match exactly 1 metric value → inject `metric IN [v]`.
 *   6. No keyword match → fall back to the value_sales family by regex; if
 *      none exists, mark `no_metrics_known` (caller logs and proceeds — better
 *      than silent corruption, but not an outright abort).
 */
export function injectCompoundShapeMetricGuard(
  step: PlanStep,
  wideFormatTransform: WideFormatTransform | undefined,
  userQuestion: string | undefined,
  distinctMetricValues: ReadonlyArray<string>
): CompoundMetricGuardResult {
  if (
    !wideFormatTransform?.detected ||
    wideFormatTransform.shape !== "compound" ||
    !wideFormatTransform.metricColumn
  ) {
    return { reason: "not_compound" };
  }
  const metricCol = wideFormatTransform.metricColumn;
  const valueCol = wideFormatTransform.valueColumn;

  if (!stepTouchesValueColumn(step, valueCol)) {
    return { reason: "no_value_touch" };
  }
  const host = dimensionFilterHost(step);
  if (!host) return { reason: "no_filter_host" };

  const existing = Array.isArray(host.dimensionFilters)
    ? (host.dimensionFilters as Array<Record<string, unknown>>)
    : [];
  if (existing.some((f) => typeof f?.column === "string" && f.column === metricCol)) {
    return { reason: "metric_filter_already_present" };
  }
  if (stepGroupsByMetric(step, metricCol)) {
    return { reason: "metric_in_group_by" };
  }

  const matched = resolveMetricFromQuestion(userQuestion, distinctMetricValues);

  if (matched.length >= 2) {
    const expanded = addMetricToGroupBy(step, metricCol);
    return { expandedGroupBy: expanded };
  }

  let toFilter: string[] = matched;
  let fallbackUsed = false;
  if (toFilter.length === 0) {
    // Heuristic default for FMCG: prefer value-sales family.
    const fallback = distinctMetricValues.find((m) =>
      /value[\s_-]*sales|sales[\s_-]*value|revenue|^sales$/i.test(m)
    );
    if (!fallback) {
      if (!distinctMetricValues.length) return { reason: "no_metrics_known" };
      // No vocab match and no value-sales alias — pick the first distinct metric.
      // Better than letting the SUM mix everything, even if a misroute is possible.
      toFilter = [distinctMetricValues[0]];
      fallbackUsed = true;
    } else {
      toFilter = [fallback];
      fallbackUsed = true;
    }
  }

  if (toFilter.length === 0) return { reason: "matched_zero_distinct_values" };

  host.dimensionFilters = [
    ...existing,
    {
      column: metricCol,
      op: "in",
      values: toFilter,
      match: "case_insensitive",
    },
  ];
  return { injectedFilter: toFilter, fallbackUsed };
}

/**
 * WPF2 · Extract the distinct values of the metric column from the dataset.
 * Used by `injectCompoundShapeMetricGuard` so the planner can build a
 * concrete `metric IN [...]` filter rather than guessing from training data.
 *
 * Reads from a sample (caller passes ctx.data, which is already capped by
 * the agent loop) so this is O(rows) — no full-table scan required when the
 * caller has only a sample. For accuracy in production callers should pass
 * `dataSummary.columns[metricColumn].topValues` (canonical from upload-time
 * profiling) when available; this helper is a fallback.
 */
export function extractDistinctMetricValues(
  rows: ReadonlyArray<Record<string, unknown>>,
  metricColumn: string,
  cap = 32
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    const v = r[metricColumn];
    if (typeof v !== "string") continue;
    const norm = v.trim();
    if (!norm) continue;
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * Pure check used by the verifier backstop: returns the names of inferred
 * filter columns that are absent from every step that could accept them.
 * Empty array means all inferred filters are represented somewhere in the
 * plan (or no inferred filters exist).
 */
export function checkMissingInferredFilters(
  steps: PlanStep[],
  inferredFilters: InferredFilter[] | undefined
): string[] {
  if (!inferredFilters?.length) return [];
  const covered = new Set<string>();
  const applicableStepCount = steps.reduce(
    (n, s) => n + (dimensionFilterHost(s) ? 1 : 0),
    0
  );
  if (applicableStepCount === 0) return [];
  for (const s of steps) {
    const host = dimensionFilterHost(s);
    if (!host) continue;
    const filters = Array.isArray(host.dimensionFilters)
      ? (host.dimensionFilters as Array<Record<string, unknown>>)
      : [];
    for (const f of filters) {
      if (!f || typeof f !== "object") continue;
      if (typeof f.column === "string") covered.add(f.column);
    }
  }
  return inferredFilters
    .map((f) => f.column)
    .filter((col) => !covered.has(col));
}

/**
 * Repairs common planner schema drift for execute_query_plan.
 *
 * Current observed failure:
 * - dimensionFilters: [{ column: "...", values: ["..."] }]
 * - missing required field: dimensionFilters[].op ("in" | "not_in")
 *
 * We default op to "in" when it's missing/undefined so the plan can pass
 * Zod validation and reach tool execution.
 */
export function repairExecuteQueryPlanDimensionFilters(step: PlanStep): void {
  if (step.tool !== "execute_query_plan") return;

  const plan = step.args?.plan;
  if (!plan || typeof plan !== "object") return;

  const dimensionFilters = (plan as any).dimensionFilters;
  if (!Array.isArray(dimensionFilters)) return;

  for (const d of dimensionFilters) {
    if (!d || typeof d !== "object") continue;

    const op = (d as any).op;
    const operator = (d as any).operator;
    if (op == null && typeof operator === "string") {
      // LLM sometimes uses operator instead of op.
      (d as any).op = operator;
    }

    if (typeof (d as any).op !== "string") {
      // Schema requires op, so choose a conservative default.
      (d as any).op = "in";
    } else if ((d as any).op !== "in" && (d as any).op !== "not_in") {
      // Invalid enum => default to "in" to avoid rejecting whole plan.
      (d as any).op = "in";
    }

    const values = (d as any).values;
    if (!Array.isArray(values)) {
      if (typeof values === "string") (d as any).values = [values];
      else if (values == null) (d as any).values = [];
      else (d as any).values = [String(values)];
    } else {
      (d as any).values = values.map((v: unknown) => (typeof v === "string" ? v : String(v)));
    }
  }
}

/**
 * Repairs execute_query_plan.sort schema drift.
 *
 * Observed failures:
 * - sort: [{ column: "..." }] (missing direction)
 * - sort: [{ field: "...", order: "ascending" }] (alias keys/values)
 *
 * Behavior:
 * - Normalize aliases (`field` -> `column`, `order` -> `direction`)
 * - Default/normalize direction to "asc" when missing or invalid
 * - Drop entries that still do not have a valid non-empty column name
 */
export function repairExecuteQueryPlanSort(step: PlanStep): void {
  if (step.tool !== "execute_query_plan") return;

  const plan = step.args?.plan;
  if (!plan || typeof plan !== "object") return;

  const sort = (plan as any).sort;
  if (!Array.isArray(sort)) return;

  const normalized: Array<{ column: string; direction: "asc" | "desc" }> = [];
  for (const raw of sort) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;

    const candidateColumn =
      (typeof item.column === "string" && item.column) ||
      (typeof item.field === "string" && item.field) ||
      "";
    const column = candidateColumn.trim();
    if (!column) continue;

    const rawDir =
      (typeof item.direction === "string" && item.direction) ||
      (typeof item.order === "string" && item.order) ||
      "";
    const dir = rawDir.trim().toLowerCase();
    const direction: "asc" | "desc" =
      dir === "desc" || dir === "descending" ? "desc" : "asc";

    normalized.push({ column, direction });
  }

  (plan as any).sort = normalized;
}

// ---------------------------------------------------------------------------
// RNK1 · Ranking / leaderboard / entity-max question intent extraction +
// deterministic plan-shape enforcement.
//
// User report: questions like "who are the top 300 salespeople" /
// "who has the maximum leaves this month" / "who has the highest
// absenteeism" / "list the products" used to produce wrong or truncated
// answers because (a) breakdown_ranking silently capped topN at 50,
// (b) the planner had no explicit rule to emit groupBy + sort + limit
// for these shapes, (c) full-row results were embedded inside the
// observation summary string and truncated by the 40k/20k char caps
// before reaching the narrator. RNK1.1+RNK1.5 fix (a) and (c); the
// helpers below fix (b) deterministically so the LLM can't drop the
// shape on the floor.
// ---------------------------------------------------------------------------

/** Shape of a user-question ranking intent, when one is recognised. */
export type RankingIntentKind = "topN" | "extremum" | "entityList";

export interface RankingIntent {
  kind: RankingIntentKind;
  /** Number of rows the user asked for (1 for `extremum`, undefined for `entityList`). */
  n?: number;
  /** Sort direction implied by the question wording (desc by default). */
  direction: "desc" | "asc";
  /** Aggregation hint for `extremum` ("max"/"min"). Not used for `topN`/`entityList`. */
  agg?: "max" | "min";
  /** Resolved entity (categorical) column from the schema. */
  entityColumn: string;
  /** Resolved metric (numeric) column from the schema. May be undefined for `entityList`. */
  metricColumn?: string;
  /** Verbatim phrase that triggered the intent (for logging / tests). */
  matchedPhrase: string;
}

const TOP_N_RE =
  /\b(top|best|leading)\s+(\d{1,7})\b/i;
const BOTTOM_N_RE =
  /\b(bottom|worst)\s+(\d{1,7})\b/i;
const EXTREMUM_MAX_RE =
  /\bwho\s+(?:has|have|had|is|are)\s+(?:the\s+)?(highest|maximum|max|most|largest|greatest|biggest)\b/i;
const EXTREMUM_MIN_RE =
  /\bwho\s+(?:has|have|had|is|are)\s+(?:the\s+)?(lowest|minimum|min|least|smallest|fewest|worst)\b/i;
const ENTITY_LIST_RE =
  /\b(who\s+are|list\s+(?:all\s+)?(?:the\s+)?|show\s+me\s+(?:all\s+)?(?:the\s+)?)\b/i;

/** Tokens we strip / ignore when extracting candidate nouns from the question. */
const STOPWORDS = new Set([
  "a","an","the","of","in","on","at","by","for","with","from","to","is","are","was","were","be","been",
  "and","or","but","not","this","that","these","those","my","your","our","their","its","it","they",
  "we","you","i","me","he","she","him","her","his","hers","theirs","ours","yours","myself","yourself",
  "what","which","who","whom","whose","when","where","why","how","do","does","did","done","can","could",
  "would","should","may","might","will","shall","have","has","had","having","top","bottom","best","worst",
  "highest","lowest","maximum","minimum","max","min","most","least","largest","smallest","greatest","biggest",
  "fewest","leading","ranked","ranking","sorted","sort","by","over","across","this","last","next","each",
  "all","every","any","some","many","few","such","than","then","also","just","very","really","quite",
  "only","even","still","ever","never","always","often","sometimes","rarely","one","two","three","four","five",
  "list","show","me","please","tell","find","get","give","display","return","print","output","report",
]);

/**
 * Extract candidate nouns from the user question for entity-column matching.
 * Strips numbers and stop-words; preserves order so the most prominent noun
 * wins ties. Always returns lowercased tokens.
 */
function questionNouns(question: string): string[] {
  return question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
}

/**
 * Resolve an entity (categorical) column from the question. We prefer columns
 * whose name shares a noun with the question. When `allowFallback` is true
 * (extremum / topN intents — "who has highest X" / "top 50") and no noun
 * matches, we fall back to the first plausible categorical column so the
 * planner can still emit a per-entity groupBy. For `entityList` intent we
 * never fall back: the user must name the entity ("list the products"),
 * otherwise the question is ambiguous.
 */
function resolveEntityColumn(
  question: string,
  summary: DataSummary,
  allowFallback: boolean
): string | null {
  const numericSet = new Set(summary.numericColumns ?? []);
  const dateSet = new Set(summary.dateColumns ?? []);
  const wideValueCol = summary.wideFormatTransform?.valueColumn;
  const wideMetricCol = summary.wideFormatTransform?.metricColumn;
  const widePeriodCol = summary.wideFormatTransform?.periodColumn;
  const widePeriodIsoCol = summary.wideFormatTransform?.periodIsoColumn;
  const isCategorical = (name: string): boolean => {
    if (numericSet.has(name)) return false;
    if (dateSet.has(name)) return false;
    if (wideValueCol && name === wideValueCol) return false;
    if (wideMetricCol && name === wideMetricCol) return false;
    if (widePeriodCol && name === widePeriodCol) return false;
    if (widePeriodIsoCol && name === widePeriodIsoCol) return false;
    return true;
  };
  const categorical = (summary.columns ?? [])
    .map((c) => c.name)
    .filter((n) => typeof n === "string" && isCategorical(n));
  if (categorical.length === 0) return null;

  // First pass: prefer a column whose name matches a noun in the question.
  const nouns = questionNouns(question);
  for (const noun of nouns) {
    const match = findMatchingColumn(noun, categorical, {
      wideFormatTransform: summary.wideFormatTransform,
    });
    if (match) return match;
  }
  // Second pass: explicit plural-stripped lookups for common entity shapes
  // ("salespeople" → "salesperson", "employees" → "employee").
  for (const noun of nouns) {
    if (noun.length < 5) continue;
    let stem: string | null = null;
    if (noun.endsWith("people")) stem = noun.replace(/people$/, "person");
    else if (noun.endsWith("ies")) stem = noun.slice(0, -3) + "y";
    else if (noun.endsWith("es")) stem = noun.slice(0, -2);
    else if (noun.endsWith("s")) stem = noun.slice(0, -1);
    if (!stem) continue;
    const match = findMatchingColumn(stem, categorical, {
      wideFormatTransform: summary.wideFormatTransform,
    });
    if (match) return match;
  }
  // Third pass: nothing in the question maps to a column.
  //  - For entityList intent ("list the X"), the user MUST have named X —
  //    return null and let the LLM handle ambiguity.
  //  - For extremum / topN intent ("who has the highest X" / "top 5 by X"),
  //    "who" / the bare ranking phrase is an implicit reference to the
  //    dataset's primary entity; default to the first categorical column
  //    so the planner can still emit per-entity grouping.
  if (allowFallback && categorical.length > 0) {
    return categorical[0];
  }
  return null;
}

/**
 * Resolve a metric (numeric) column from the question. Looks for "by <noun>"
 * / "of <noun>" / "<noun>" patterns matching a numeric column. Returns null
 * when no numeric column is named — caller can leave the LLM's choice intact
 * (or, for the wide-format `valueColumn`, plug it in as the canonical metric).
 */
function resolveMetricColumn(
  question: string,
  summary: DataSummary
): string | null {
  const numericCols = summary.numericColumns ?? [];
  if (numericCols.length === 0) return null;
  const wideValueCol = summary.wideFormatTransform?.valueColumn;
  // Strip the wide-format hidden _rowCount/_numericCount surrogates.
  const candidates = numericCols.filter((c) => !c.startsWith("_"));
  if (candidates.length === 0) return null;

  // "by <metric>" / "of <metric>" / "for <metric>" patterns are strongest.
  const byMatch = question.match(
    /\b(?:by|of|for|in|on)\s+([a-zA-Z][a-zA-Z0-9_\s-]{1,40})/i
  );
  if (byMatch) {
    const phrase = byMatch[1].trim();
    const match = findMatchingColumn(phrase, candidates, {
      wideFormatTransform: summary.wideFormatTransform,
    });
    if (match) return match;
  }
  // Fall back to scanning question nouns against numeric columns.
  const nouns = questionNouns(question);
  for (const noun of nouns) {
    const match = findMatchingColumn(noun, candidates, {
      wideFormatTransform: summary.wideFormatTransform,
    });
    if (match) return match;
  }
  // Wide-format datasets keep the metric in `valueColumn`; if the question
  // didn't name another numeric column, the wide value column is the right
  // default.
  if (wideValueCol && candidates.includes(wideValueCol)) return wideValueCol;
  return null;
}

/**
 * Inspect the user question and return a structured ranking intent if the
 * phrasing matches one of the supported shapes. Returns null when no shape
 * fires — non-ranking analytical questions (trends, drivers, comparisons)
 * pass through untouched.
 */
export function extractRankingIntent(
  question: string | undefined,
  summary: DataSummary
): RankingIntent | null {
  const q = (question ?? "").trim();
  if (!q) return null;

  // Order matters: extremum and topN are more specific than entityList
  // (which would otherwise eat "list the top 10 products"). Bottom/worst
  // patterns are checked before extremum-min so "bottom 5" beats "lowest"
  // when both could match.
  const topMatch = TOP_N_RE.exec(q);
  const bottomMatch = BOTTOM_N_RE.exec(q);
  const extremumMaxMatch = EXTREMUM_MAX_RE.exec(q);
  const extremumMinMatch = EXTREMUM_MIN_RE.exec(q);
  const entityListMatch = ENTITY_LIST_RE.exec(q);

  let kind: RankingIntentKind | null = null;
  let n: number | undefined;
  let direction: "desc" | "asc" = "desc";
  let agg: "max" | "min" | undefined;
  let matchedPhrase = "";

  if (topMatch) {
    kind = "topN";
    n = Number(topMatch[2]);
    direction = "desc";
    matchedPhrase = topMatch[0];
  } else if (bottomMatch) {
    kind = "topN";
    n = Number(bottomMatch[2]);
    direction = "asc";
    matchedPhrase = bottomMatch[0];
  } else if (extremumMaxMatch) {
    kind = "extremum";
    n = 1;
    direction = "desc";
    agg = "max";
    matchedPhrase = extremumMaxMatch[0];
  } else if (extremumMinMatch) {
    kind = "extremum";
    n = 1;
    direction = "asc";
    agg = "min";
    matchedPhrase = extremumMinMatch[0];
  } else if (entityListMatch) {
    kind = "entityList";
    direction = "desc";
    matchedPhrase = entityListMatch[0];
  }

  if (!kind) return null;
  if (n !== undefined && (!Number.isFinite(n) || n < 1)) return null;

  // Fallback to "first categorical column" is only safe for `extremum`
  // intent — there "who" already implies the dataset's primary entity, so
  // a default lookup won't surprise the user. For `topN` ("top 10 rocket
  // scientists") and `entityList` ("list the rocket scientists") the user
  // explicitly named an entity; failing to find one means we should bail
  // rather than silently substitute Salesperson.
  const allowEntityFallback = kind === "extremum";
  const entityColumn = resolveEntityColumn(q, summary, allowEntityFallback);
  if (!entityColumn) return null;

  const metricColumn =
    kind === "entityList" ? undefined : resolveMetricColumn(q, summary) ?? undefined;
  if (kind !== "entityList" && !metricColumn) {
    // No numeric column named, no wide-format value column to default to —
    // we can't responsibly emit groupBy+sort+limit without a metric. Leave
    // intent null so the LLM's plan stands; the prompt block (RNK1.4) still
    // nudges the LLM toward the right shape.
    return null;
  }

  return {
    kind,
    n,
    direction,
    agg,
    entityColumn,
    metricColumn,
    matchedPhrase,
  };
}

/** Tools whose plan-shape we deterministically enforce for ranking intent. */
const RANKING_TOOLS = new Set(["execute_query_plan", "breakdown_ranking"]);

export interface EnforceRankingResult {
  /** True when at least one repair fired on the step. */
  changed: boolean;
  /** Short summary of the repair (for logging). */
  reason?: string;
}

/**
 * Coerce `args.aggregation` for breakdown_ranking from the intent. We only
 * touch the args when the planner left them inconsistent with the question.
 */
function applyToBreakdownRanking(
  step: PlanStep,
  intent: RankingIntent
): EnforceRankingResult {
  const args = (step.args ?? {}) as Record<string, unknown>;
  const before = JSON.stringify(args);

  // Force entity column when the planner picked something that doesn't
  // match the question's noun (LLMs frequently fall back to the first
  // categorical column).
  if (
    typeof args.breakdownColumn !== "string" ||
    args.breakdownColumn !== intent.entityColumn
  ) {
    args.breakdownColumn = intent.entityColumn;
  }
  if (intent.metricColumn) {
    if (
      typeof args.metricColumn !== "string" ||
      args.metricColumn !== intent.metricColumn
    ) {
      args.metricColumn = intent.metricColumn;
    }
  }
  if (intent.kind === "topN" && intent.n !== undefined) {
    const cur = typeof args.topN === "number" ? args.topN : 0;
    if (cur < intent.n) args.topN = intent.n;
  } else if (intent.kind === "extremum") {
    args.topN = 1;
    if (intent.agg === "max") {
      // Default aggregation already "sum"; for "who has highest", sum is
      // appropriate when row-per-entity isn't guaranteed and "max" is
      // appropriate when it is. Leave aggregation alone — the planner /
      // user can refine if needed; sort direction (handled by tool) is
      // what really matters.
    }
  }
  args.direction = intent.direction;
  step.args = args;
  return {
    changed: JSON.stringify(args) !== before,
    reason: `breakdown_ranking shape coerced to ${intent.kind} on ${intent.entityColumn}${intent.metricColumn ? ` × ${intent.metricColumn}` : ""}`,
  };
}

/**
 * Coerce execute_query_plan args so groupBy includes the entity column,
 * sort is set on the metric agg with the right direction, and limit is set
 * to the intent's N. For `entityList` intent we leave aggregations empty
 * and skip `limit`.
 */
function applyToExecuteQueryPlan(
  step: PlanStep,
  intent: RankingIntent
): EnforceRankingResult {
  const args = (step.args ?? {}) as Record<string, unknown>;
  let plan = args.plan as Record<string, unknown> | undefined;
  if (!plan || typeof plan !== "object") {
    plan = {};
    args.plan = plan;
  }
  const before = JSON.stringify(plan);

  // groupBy must include the entity column in front (so grouping is per-
  // entity, not lost as a tail dimension).
  const groupBy = Array.isArray(plan.groupBy)
    ? (plan.groupBy as unknown[]).filter(
        (g): g is string => typeof g === "string" && g !== intent.entityColumn
      )
    : [];
  plan.groupBy = [intent.entityColumn, ...groupBy];

  if (intent.kind === "entityList") {
    // Listing intent: distinct entities only. Strip aggregations and any
    // numeric sort/limit so the planner doesn't accidentally rank.
    plan.aggregations = [];
    delete plan.sort;
    delete plan.limit;
  } else if (intent.metricColumn) {
    // Ensure an aggregation on the metric column exists. Choose `max` for
    // extremum-style questions where the planner explicitly indicated max,
    // otherwise prefer `sum` (FMCG pragmatism — totals dominate).
    const aggs = Array.isArray(plan.aggregations)
      ? (plan.aggregations as Array<Record<string, unknown>>)
      : [];
    const wantOp =
      intent.kind === "extremum"
        ? intent.agg === "min"
          ? "min"
          : "max"
        : "sum";
    let aggOnMetric = aggs.find(
      (a) => typeof a?.column === "string" && a.column === intent.metricColumn
    );
    if (!aggOnMetric) {
      aggOnMetric = { column: intent.metricColumn, operation: wantOp };
      aggs.push(aggOnMetric);
    } else if (typeof aggOnMetric.operation !== "string") {
      aggOnMetric.operation = wantOp;
    }
    plan.aggregations = aggs;

    const sortKey = `${intent.metricColumn}_${aggOnMetric.operation}`;
    plan.sort = [{ column: sortKey, direction: intent.direction }];
    plan.limit = intent.n;
  }

  args.plan = plan;
  step.args = args;
  return {
    changed: JSON.stringify(plan) !== before,
    reason: `execute_query_plan coerced to ${intent.kind} on ${intent.entityColumn}${intent.metricColumn ? ` × ${intent.metricColumn}` : ""}`,
  };
}

/**
 * Apply ranking-intent repairs to a step. Wired in `planner.ts` immediately
 * after `injectRollupExcludeFilters` so it runs after column resolution but
 * before zod validation. No-op for tools outside `RANKING_TOOLS` and for
 * steps whose tool the LLM picked correctly but with mismatched args.
 *
 * NOTE: this purposefully overrides the LLM's choice of breakdown column /
 * metric column / topN when they conflict with the deterministic intent —
 * the LLM gets the question wrong here often enough that the deterministic
 * extractor is the right source of truth. The LLM still chooses the tool
 * (breakdown_ranking vs execute_query_plan) and any dimensionFilters /
 * temporal facets layered on top.
 */
export function enforceRankingPlanShape(
  step: PlanStep,
  intent: RankingIntent | null
): EnforceRankingResult {
  if (!intent) return { changed: false };
  if (!RANKING_TOOLS.has(step.tool)) return { changed: false };
  if (step.tool === "breakdown_ranking") {
    return applyToBreakdownRanking(step, intent);
  }
  if (step.tool === "execute_query_plan") {
    return applyToExecuteQueryPlan(step, intent);
  }
  return { changed: false };
}
