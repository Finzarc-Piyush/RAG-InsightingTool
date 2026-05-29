import type { PlanStep } from "./types.js";
import type { InferredFilter } from "../utils/inferFiltersFromQuestion.js";
import type {
  DataSummary,
  DimensionHierarchy,
  WideFormatTransform,
} from "../../../shared/schema.js";
import { findMatchingColumn } from "../utils/columnMatcher.js";
import {
  facetColumnKey,
  parseTemporalFacetDisplayKey,
} from "../../temporalFacetColumns.js";
import type { TemporalFacetGrain } from "../../temporalFacetColumns.js";

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
// RD2 · exclusion-intent override: when the user mentions the rollup name AND
// pairs it with an exclusion verb within EXCLUDE_PROXIMITY_WINDOW chars, OR
// when the question contains an explainer ("X is the entire category"), the
// rollup-exclude filter MUST fire — the user is asking *to remove* the rollup,
// not asking about it. Without this, "omit FEMALE SHOWER GEL" was treated the
// same as "tell me about FEMALE SHOWER GEL" and the rollup stayed in the data.
const EXCLUDE_VERB_RE_G =
  /\b(omit|exclud(?:e|es|ed|ing)|without|except|leav(?:e|ing)\s+out|drop(?:s|ped|ping)?|remov(?:e|es|ed|ing)|skip(?:s|ped|ping)?|ignor(?:e|es|ed|ing)|aside\s+from|apart\s+from|other\s+than|don'?t\s+include|do\s+not\s+include|not\s+including|minus)\b/gi;
const ROLLUP_EXPLAINER_RE =
  /\b(?:is|are|=|equals)\s+(?:the\s+)?(?:entire|whole|full|total|grand\s+total|overall|aggregate|sum|category|parent|rollup|roll[\s-]?up)\b/i;
const EXCLUDE_PROXIMITY_WINDOW = 60;

export function shouldSkipRollupExclude(
  userQuestion: string | undefined,
  hierarchy: DimensionHierarchy
): { skip: boolean; reason: "mention" | "share-of-category" | null } {
  const q = (userQuestion ?? "").trim();
  if (!q) return { skip: false, reason: null };
  const qLower = q.toLowerCase();
  const rollupLower = hierarchy.rollupValue.toLowerCase();
  if (rollupLower && qLower.includes(rollupLower)) {
    // RD2 · check exclusion-intent override before honoring the mention.
    const rollupIdx = qLower.indexOf(rollupLower);
    const rollupEnd = rollupIdx + rollupLower.length;
    for (const m of qLower.matchAll(EXCLUDE_VERB_RE_G)) {
      const verbStart = m.index ?? 0;
      const verbEnd = verbStart + m[0].length;
      const distance =
        verbEnd <= rollupIdx
          ? rollupIdx - verbEnd
          : rollupEnd <= verbStart
            ? verbStart - rollupEnd
            : 0;
      if (distance <= EXCLUDE_PROXIMITY_WINDOW) {
        return { skip: false, reason: null };
      }
    }
    if (ROLLUP_EXPLAINER_RE.test(qLower)) {
      return { skip: false, reason: null };
    }
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

    // CMP1 · accept the extended op set (eq/neq/lt/lte/gt/gte/between)
    // alongside categorical in/not_in. Default to "in" only when the planner
    // emitted nothing usable.
    const VALID_OPS = new Set([
      "in",
      "not_in",
      "eq",
      "neq",
      "lt",
      "lte",
      "gt",
      "gte",
      "between",
    ]);
    if (typeof (d as any).op !== "string") {
      // Schema requires op, so choose a conservative default.
      (d as any).op = "in";
    } else if (!VALID_OPS.has((d as any).op)) {
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

// =============================================================================
// PD1 · "per X" rate-intent detection + deterministic plan repair
// =============================================================================
//
// User asks "What is the average number of compliance visits per day across
// clusters?" → the agent today emits a single-pass `mean(Compliance Visit)
// GROUP BY Cluster`, which averages RAW ROWS. When each row is already a
// per-employee-per-day count, that's the wrong number — the user wanted
// per-cluster daily totals averaged across days. PD1 detects this intent
// from question phrasing and rewrites the plan to use the new
// `aggregations[].perDimension` primitive (executed as a derived-table
// subquery: SUM per (cluster, day) inside, AVG across days outside).
//
// Mirrors the H3 / WPF2 / RNK1 deterministic-repair pattern: regex-gated
// detection, override-by-mention, idempotent rewrite, called from planner.ts
// right after `injectCompoundShapeMetricGuard`.

type PerXOuterOp = "mean" | "sum" | "min" | "max";

const PER_X_OUTER_OP_MAP: Record<string, PerXOuterOp> = {
  average: "mean",
  avg: "mean",
  mean: "mean",
  total: "sum",
  sum: "sum",
  max: "max",
  maximum: "max",
  highest: "max",
  min: "min",
  minimum: "min",
  lowest: "min",
};

const PER_TEMPORAL_UNIT_TO_GRAIN: Record<
  string,
  "date" | "week" | "month" | "quarter" | "year"
> = {
  day: "date",
  daily: "date",
  date: "date",
  week: "week",
  weekly: "week",
  month: "month",
  monthly: "month",
  quarter: "quarter",
  quarterly: "quarter",
  year: "year",
  yearly: "year",
  annual: "year",
  annually: "year",
};

/**
 * PD1 · Detect "<outerOp> X per Y" intent in the user's question. Returns
 * null for non-rate questions. The match is strict by design: requires a
 * recognised aggregation verb followed (within 40 chars) by `per <unit>`
 * OR an adverbial form (`daily average`, `weekly total`, `per-day`).
 *
 * Resolution of the captured "X" (perDimension):
 *   - Temporal unit (day/week/month/quarter/year) → corresponding temporal
 *     facet column (`Day · <strongestDateColumn>`, etc.) using the first
 *     entry of `dataSummary.dateColumns`.
 *   - Otherwise: fuzzy-match against `dataSummary.columns[].name`. Only
 *     accept matches with cardinality ≤ 5000 to keep nested-aggregation
 *     SQL bounded.
 *
 * The "innerColumn" (the metric being aggregated) is NOT extracted here —
 * the injector reads it from the planner's existing aggregation entries.
 * Decoupling intent detection from column resolution means the planner can
 * still get the metric column wrong without breaking the detector.
 */
export interface PerXIntent {
  outerOp: PerXOuterOp;
  perDimension: string;
  perDimensionKind: "temporal" | "dimension";
  rawCapture: string;
  /**
   * PD2 · For temporal intents, the source date column the perDimension
   * facet derives from (e.g. perDimension="Day · Date" → sourceColumn="Date").
   * Used by the injector to detect when the planner has ALREADY decomposed
   * by the same temporal axis (via groupBy of the raw column or any other
   * facet over the same source). Undefined for non-temporal intents.
   */
  sourceColumn?: string;
}

const PER_X_REGEX =
  /\b(average|avg|mean|total|sum|max|maximum|highest|min|minimum|lowest)\b[^.?!]{0,40}?\bper\s+([A-Za-z][\w\s·\-]{0,40}?)(?:\s|[.,?!]|$)/i;

const ADVERBIAL_REGEX =
  /\b(daily|weekly|monthly|quarterly|yearly|annual|annually)\s+(average|avg|mean|total|sum|max|maximum|min|minimum)\b/i;

const PER_HYPHEN_REGEX =
  /\bper-(day|week|month|quarter|year)\b/i;

export function detectPerXIntent(
  question: string | undefined,
  dataSummary: Pick<DataSummary, "columns" | "dateColumns">
): PerXIntent | null {
  const q = (question ?? "").trim();
  if (!q) return null;

  // Branch 1 — primary "<verb> ... per X" pattern.
  const m = PER_X_REGEX.exec(q);
  let outerOpWord: string | null = null;
  let rawCapture: string | null = null;
  if (m) {
    outerOpWord = m[1]!.toLowerCase();
    rawCapture = m[2]!.trim();
  }

  // Branch 2 — adverbial "daily average" / "weekly total" — implicitly
  // per-temporal. Only fires when branch 1 didn't already match.
  if (!outerOpWord) {
    const a = ADVERBIAL_REGEX.exec(q);
    if (a) {
      const adverb = a[1]!.toLowerCase();
      outerOpWord = a[2]!.toLowerCase();
      rawCapture = adverb.replace(/ly$|al$|ally$/, ""); // "daily"→"da", we fix below
      // Use the explicit mapping instead of regex stripping.
      const adverbToUnit: Record<string, string> = {
        daily: "day",
        weekly: "week",
        monthly: "month",
        quarterly: "quarter",
        yearly: "year",
        annual: "year",
        annually: "year",
      };
      rawCapture = adverbToUnit[adverb] ?? adverb;
    }
  }

  // Branch 3 — "per-day" / "per-week" hyphenated. Implies an outer op
  // upstream — only fires when paired with a verb in branch 1's window.
  // We'll redetect via combining with an existing verb match if any.
  if (!outerOpWord) {
    const h = PER_HYPHEN_REGEX.exec(q);
    if (h) {
      // Try to pull an outer-op verb from earlier in the same question.
      const verbBefore = /\b(average|avg|mean|total|sum|max|maximum|highest|min|minimum|lowest)\b/i.exec(
        q.slice(0, h.index)
      );
      if (verbBefore) {
        outerOpWord = verbBefore[1]!.toLowerCase();
        rawCapture = h[1]!.toLowerCase();
      }
    }
  }

  if (!outerOpWord || !rawCapture) return null;
  const outerOp = PER_X_OUTER_OP_MAP[outerOpWord];
  if (!outerOp) return null;

  // Block runaway: "per row" / "per row id" / "per record" / "per entry"
  // are useless denominators (cardinality === row count) and signal
  // misclassification.
  if (/^row(\s*id)?$|^records?$|^entries?$|^row\s*number$/i.test(rawCapture)) {
    return null;
  }

  // Temporal-unit resolution first.
  const grain = PER_TEMPORAL_UNIT_TO_GRAIN[rawCapture.toLowerCase()];
  if (grain) {
    const strongestDateCol = (dataSummary.dateColumns ?? [])[0];
    if (!strongestDateCol) return null; // no date column → can't bucket per-day
    return {
      outerOp,
      perDimension: facetColumnKey(strongestDateCol, grain),
      perDimensionKind: "temporal",
      rawCapture,
      sourceColumn: strongestDateCol,
    };
  }

  // Dimension column resolution via fuzzy matcher. Accept only when
  // cardinality is moderate — "per customer" with 50 000 customers blows
  // up both SQL and chart.
  const colNames = (dataSummary.columns ?? []).map((c) => c.name);
  const matched = findMatchingColumn(rawCapture, colNames);
  if (!matched) return null;
  const colMeta = (dataSummary.columns ?? []).find((c) => c.name === matched);
  // ColumnInfo.uniqueCount may not always be populated; use topValues
  // length as a lower bound + bail on suspiciously high column types.
  const uniqueCount = (colMeta as { uniqueCount?: number } | undefined)?.uniqueCount;
  if (typeof uniqueCount === "number" && uniqueCount > 5000) return null;

  return {
    outerOp,
    perDimension: matched,
    perDimensionKind: "dimension",
    rawCapture,
  };
}

/**
 * Wave W2 · Rolling-window / cumulative intent.
 *
 * Detects user phrasings that map naturally to a `windowAggregations`
 * shape (introduced in Wave W1) rather than `perDimension` nested
 * aggregation. Examples we want to catch:
 *   - "rolling 4-week average sales"
 *   - "4-week rolling average of revenue"
 *   - "trailing 7-day mean"
 *   - "moving average over last 30 days"
 *   - "cumulative sales by brand"
 *   - "running total of revenue"
 *   - "year-to-date revenue" → cumulative WITHIN year partition
 *
 * Returns a partial `WindowAggregation` minus the orderBy date column
 * (caller resolves the strongest date column from `dataSummary`). When
 * `null`, the question isn't a rolling/cumulative shape — caller falls
 * through to `detectPerXIntent` and the normal planner path.
 *
 * Conservative regex — anything ambiguous (e.g. "compare rolling avg
 * to last year" — that's a comparison shape, not a window) returns
 * `null` and the question goes to the full planner.
 */
export type RollingWindowOp = "sum" | "mean" | "min" | "max" | "count";
export interface RollingWindowIntent {
  /** Window operation derived from the user's verb. */
  operation: RollingWindowOp;
  /** Frame: rolling window of N periods OR cumulative (unbounded preceding). */
  frame: { rows: number } | { range: "unbounded_preceding" };
  /** Temporal unit detected — caller uses it to derive grain + temporal facet. */
  temporalUnit: "day" | "week" | "month" | "quarter" | "year";
  /** Substring caught by the matcher — useful for telemetry / repair logging. */
  rawCapture: string;
}

const VERB_TO_ROLLING_OP: Record<string, RollingWindowOp> = {
  average: "mean",
  avg: "mean",
  mean: "mean",
  total: "sum",
  sum: "sum",
  max: "max",
  maximum: "max",
  min: "min",
  minimum: "min",
};

const ROLLING_TEMPORAL_TO_UNIT: Record<string, RollingWindowIntent["temporalUnit"]> = {
  day: "day",
  days: "day",
  week: "week",
  weeks: "week",
  month: "month",
  months: "month",
  quarter: "quarter",
  quarters: "quarter",
  year: "year",
  years: "year",
};

// "rolling N-<unit> <verb>" or "N-<unit> rolling <verb>" or "trailing N-<unit> <verb>".
// Cumulative phrasings handled separately below.
const ROLLING_N_UNIT_VERB_REGEX =
  /\b(?:rolling|trailing|moving)\s+(\d{1,3})[-\s](day|days|week|weeks|month|months|quarter|quarters|year|years)\s+(average|avg|mean|total|sum|max|maximum|min|minimum)\b/i;
const N_UNIT_ROLLING_VERB_REGEX =
  /\b(\d{1,3})[-\s](day|days|week|weeks|month|months|quarter|quarters|year|years)\s+rolling\s+(average|avg|mean|total|sum|max|maximum|min|minimum)\b/i;
const MOVING_OVER_LAST_N_REGEX =
  /\bmoving\s+(average|avg|mean|total|sum|max|maximum|min|minimum)\s+over\s+(?:the\s+)?(?:last\s+|past\s+|previous\s+)(\d{1,3})[-\s](day|days|week|weeks|month|months|quarter|quarters|year|years)\b/i;

// Cumulative / running-total / year-to-date.
const CUMULATIVE_REGEX =
  /\b(?:cumulative|running\s+total|running\s+sum|to[-\s]date)\b/i;
const YEAR_TO_DATE_REGEX = /\b(?:ytd|year[-\s]to[-\s]date)\b/i;
const QUARTER_TO_DATE_REGEX = /\b(?:qtd|quarter[-\s]to[-\s]date)\b/i;
const MONTH_TO_DATE_REGEX = /\b(?:mtd|month[-\s]to[-\s]date)\b/i;

export function detectRollingWindowIntent(
  question: string | undefined
): RollingWindowIntent | null {
  const q = (question ?? "").trim();
  if (!q) return null;

  // Branch 1 — "rolling/trailing/moving N-<unit> <verb>"
  let m = ROLLING_N_UNIT_VERB_REGEX.exec(q);
  if (m) {
    const n = parseInt(m[1]!, 10);
    const unitWord = m[2]!.toLowerCase();
    const verbWord = m[3]!.toLowerCase();
    const op = VERB_TO_ROLLING_OP[verbWord];
    const unit = ROLLING_TEMPORAL_TO_UNIT[unitWord];
    if (op && unit && n > 0 && n <= 365) {
      return {
        operation: op,
        frame: { rows: n },
        temporalUnit: unit,
        rawCapture: m[0]!,
      };
    }
  }

  // Branch 2 — "N-<unit> rolling <verb>" (e.g. "4-week rolling average")
  m = N_UNIT_ROLLING_VERB_REGEX.exec(q);
  if (m) {
    const n = parseInt(m[1]!, 10);
    const unitWord = m[2]!.toLowerCase();
    const verbWord = m[3]!.toLowerCase();
    const op = VERB_TO_ROLLING_OP[verbWord];
    const unit = ROLLING_TEMPORAL_TO_UNIT[unitWord];
    if (op && unit && n > 0 && n <= 365) {
      return {
        operation: op,
        frame: { rows: n },
        temporalUnit: unit,
        rawCapture: m[0]!,
      };
    }
  }

  // Branch 3 — "moving <verb> over last N <unit>"
  m = MOVING_OVER_LAST_N_REGEX.exec(q);
  if (m) {
    const verbWord = m[1]!.toLowerCase();
    const n = parseInt(m[2]!, 10);
    const unitWord = m[3]!.toLowerCase();
    const op = VERB_TO_ROLLING_OP[verbWord];
    const unit = ROLLING_TEMPORAL_TO_UNIT[unitWord];
    if (op && unit && n > 0 && n <= 365) {
      return {
        operation: op,
        frame: { rows: n },
        temporalUnit: unit,
        rawCapture: m[0]!,
      };
    }
  }

  // Branch 4 — specific period-to-date phrasings BEFORE the generic
  // cumulative branch (otherwise "month-to-date" would match the
  // CUMULATIVE_REGEX's `to-date` token and default to year grain).
  if (YEAR_TO_DATE_REGEX.test(q)) {
    return {
      operation: "sum",
      frame: { range: "unbounded_preceding" },
      temporalUnit: "year",
      rawCapture: YEAR_TO_DATE_REGEX.exec(q)![0]!,
    };
  }
  if (QUARTER_TO_DATE_REGEX.test(q)) {
    return {
      operation: "sum",
      frame: { range: "unbounded_preceding" },
      temporalUnit: "quarter",
      rawCapture: QUARTER_TO_DATE_REGEX.exec(q)![0]!,
    };
  }
  if (MONTH_TO_DATE_REGEX.test(q)) {
    return {
      operation: "sum",
      frame: { range: "unbounded_preceding" },
      temporalUnit: "month",
      rawCapture: MONTH_TO_DATE_REGEX.exec(q)![0]!,
    };
  }

  // Branch 5 — generic cumulative / running total. Picks "year" as the
  // default grain because the most common usage is annual cumulative;
  // callers can override via groupBy if they need a different partition.
  if (CUMULATIVE_REGEX.test(q)) {
    return {
      operation: "sum",
      frame: { range: "unbounded_preceding" },
      temporalUnit: "year",
      rawCapture: CUMULATIVE_REGEX.exec(q)![0]!,
    };
  }

  return null;
}

/**
 * PD1 · Injector. For an `execute_query_plan` step whose aggregations are
 * single-pass and match the detected outer op + numeric column, rewrite
 * each matching aggregation to add `perDimension` + `innerOperation: "sum"`.
 * Idempotent: skips aggs that already have perDimension. Also skips when
 * the perDimension already appears in the plan's `groupBy` (the agent did
 * the decomposition itself; no need to rewrite).
 *
 * Returns the column names of aggregations that were rewritten. Logs the
 * decision (`injected` / `skipped_<reason>`) via the caller.
 */
export interface InjectPerDimensionResult {
  rewrittenAggColumns: string[];
  skipReason?:
    | "no_intent"
    | "not_execute_query_plan"
    | "no_plan"
    | "no_aggregations"
    | "already_in_group_by"
    | "already_decomposed_semantically"
    | "no_matching_aggregation"
    | "already_nested";
}

/**
 * PD2 · Returns the set of column names that are semantically equivalent to
 * decomposing by `intent.perDimension`. For temporal intents, this includes
 * the perDimension itself, the source date column, AND every facet over that
 * source (Day · X / Week · X / Month · X / Quarter · X / Half-year · X /
 * Year · X). For non-temporal intents, just the perDimension itself.
 *
 * Used by the injector: if the planner's groupBy intersects this set, the
 * plan is already semantically decomposed and rewriting would either be
 * redundant (1:1 inner bucket) or actively wrong (different temporal axis
 * → double-grouping).
 */
export function semanticDecompositionAliases(
  intent: PerXIntent
): Set<string> {
  const set = new Set<string>([intent.perDimension]);
  if (intent.perDimensionKind === "temporal" && intent.sourceColumn) {
    set.add(intent.sourceColumn);
    const grains: TemporalFacetGrain[] = [
      "date",
      "week",
      "month",
      "quarter",
      "half_year",
      "year",
    ];
    for (const g of grains) {
      set.add(facetColumnKey(intent.sourceColumn, g));
    }
  }
  return set;
}

export function injectPerDimensionForRateIntent(
  step: PlanStep,
  intent: PerXIntent | null
): InjectPerDimensionResult {
  if (!intent) return { rewrittenAggColumns: [], skipReason: "no_intent" };
  if (step.tool !== "execute_query_plan") {
    return { rewrittenAggColumns: [], skipReason: "not_execute_query_plan" };
  }
  const plan = step.args?.plan;
  if (!plan || typeof plan !== "object") {
    return { rewrittenAggColumns: [], skipReason: "no_plan" };
  }
  const planObj = plan as Record<string, unknown>;
  const aggs = Array.isArray(planObj.aggregations)
    ? (planObj.aggregations as Array<Record<string, unknown>>)
    : null;
  if (!aggs || !aggs.length) {
    return { rewrittenAggColumns: [], skipReason: "no_aggregations" };
  }

  const groupBy = Array.isArray(planObj.groupBy)
    ? (planObj.groupBy as string[]).map(String)
    : [];

  // PD2 · Semantic check: the planner may have already decomposed the
  // temporal axis via the raw date column (groupBy: ["Cluster Name",
  // "Date"]) or any other facet over the same source ("Week · Date" /
  // "Month · Date" / etc). In all these cases, adding perDimension would
  // either be redundant (1:1 with the existing groupBy bucket) or create
  // a doubly-grouped subquery that references a possibly-unmaterialized
  // facet column. Skip the rewrite.
  //
  // For temporal intent: alias set = { Day·X, X, Week·X, Month·X, Quarter·X,
  // Half-year·X, Year·X } where X is sourceColumn.
  // For non-temporal intent: alias set = { perDimension } (literal match).
  const aliasSet = semanticDecompositionAliases(intent);
  for (const g of groupBy) {
    if (aliasSet.has(g)) {
      // Distinguish literal vs semantic for log clarity.
      const skipReason: InjectPerDimensionResult["skipReason"] =
        g === intent.perDimension
          ? "already_in_group_by"
          : "already_decomposed_semantically";
      return { rewrittenAggColumns: [], skipReason };
    }
  }

  // Identify the aggregations to rewrite. For each, the existing operation
  // must be compatible with the detected outer op (avg/mean match for mean
  // intent; sum/total match for sum intent; etc.). A mismatch (e.g. the
  // planner emitted SUM but the user asked for MAX per day) means the
  // planner got the outer op wrong — we don't second-guess that; we leave
  // it alone so the user's wording acts as a tie-breaker.
  const rewritten: string[] = [];
  let anyAlreadyNested = false;
  for (const a of aggs) {
    const currentOp = typeof a?.operation === "string" ? a.operation.toLowerCase() : "";
    if (a?.perDimension) {
      anyAlreadyNested = true;
      continue;
    }
    // mean intent matches existing mean/avg only
    const opOk =
      (intent.outerOp === "mean" && (currentOp === "mean" || currentOp === "avg")) ||
      (intent.outerOp === "sum" && currentOp === "sum") ||
      (intent.outerOp === "min" && currentOp === "min") ||
      (intent.outerOp === "max" && currentOp === "max");
    if (!opOk) continue;
    // (countIf/sumIf can't reach this point — opOk only passes for
    // mean/avg/sum/min/max. The schema superRefine also rejects
    // predicate + perDimension, so we double-check anyway.)
    if (Array.isArray(a.predicate) && a.predicate.length > 0) continue;

    a.perDimension = intent.perDimension;
    a.innerOperation = "sum";
    rewritten.push(typeof a.column === "string" ? a.column : "<unknown>");
  }

  if (!rewritten.length) {
    return {
      rewrittenAggColumns: [],
      skipReason: anyAlreadyNested
        ? "already_nested"
        : "no_matching_aggregation",
    };
  }

  return { rewrittenAggColumns: rewritten };
}

// =============================================================================
// PD3 · Multi-per intent — "<agg> X per Y per Z" / "<agg> X per Y by Z"
// =============================================================================
//
// English reading: "average compliance visits PER DAY PER CLUSTER" means
// "for each cluster, the average daily total of compliance visits". Y (first
// per-target, usually temporal) is the RATE DENOMINATOR. Z (subsequent
// per/by-targets) is the ANSWER DIMENSION the result is grouped by.
//
// Single-per PD1 detection treats the first `per` clause as a rate; PD2's
// semantic-skip prevents over-rewriting when the planner already
// decomposed by date. But for multi-per, the planner OFTEN puts BOTH Y and
// Z in groupBy, picking the trend-with-breakdown interpretation. PD3
// recognises this and ACTIVELY MOVES the rate denominator out of groupBy
// into perDimension — turning the wrong-interpretation plan into the
// right-interpretation plan deterministically.

export interface MultiPerIntent {
  outerOp: PerXOuterOp;
  /** First (or only) temporal per-clause; the canonical rate denominator. */
  rateDenominator: {
    column: string; // e.g. "Day · Date"
    sourceColumn: string; // e.g. "Date"
    grain: TemporalFacetGrain;
  };
  /** Subsequent per-clauses (non-temporal) that act as group dimensions. */
  groupColumns: string[];
  /** Raw question fragments for log readability. */
  rawCaptures: string[];
}

const PER_ANY_REGEX_GLOBAL =
  /\bper\s+([A-Za-z][\w\s·\-]{0,40}?)(?=\s|[.,?!]|$)/gi;

/**
 * PD3 · Strict multi-per detector. Returns a MultiPerIntent ONLY when the
 * question has both a temporal per-clause (rate denominator) AND at least
 * one other resolvable dimension per-clause (group). Otherwise null —
 * single-per cases fall through to PD1's existing detector.
 *
 * Adverbial forms ("daily average X by region", "weekly total Y per cluster")
 * also fire: the adverb provides the rate denominator, the per/by clause
 * provides the group dimension.
 */
export function detectMultiPerIntent(
  question: string | undefined,
  dataSummary: Pick<DataSummary, "columns" | "dateColumns">
): MultiPerIntent | null {
  const q = (question ?? "").trim();
  if (!q) return null;

  // Outer-op verb (any form). Reuse PD1's mapping.
  let outerOpWord: string | null = null;
  const verbMatch = q.match(
    /\b(average|avg|mean|total|sum|max|maximum|highest|min|minimum|lowest)\b/i
  );
  if (verbMatch) outerOpWord = verbMatch[1]!.toLowerCase();

  // Adverbial rate carrier: "daily" / "weekly" / etc.
  const adverbMatch = q.match(
    /\b(daily|weekly|monthly|quarterly|yearly|annual|annually)\b/i
  );

  // Scan all `per <token>` clauses.
  const perClauses: string[] = [];
  PER_ANY_REGEX_GLOBAL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PER_ANY_REGEX_GLOBAL.exec(q)) !== null) {
    perClauses.push(m[1]!.trim());
  }
  // Per-hyphen form contributes a temporal clause.
  const hyphenMatch = q.match(/\bper-(day|week|month|quarter|year)\b/i);
  if (hyphenMatch) perClauses.push(hyphenMatch[1]!.toLowerCase());

  // ALSO consider "by <X>" and "across <X>" as group dimensions when paired
  // with a rate clause. Stay conservative: only single-word capture.
  const byClauses: string[] = [];
  const byRegex = /\b(?:by|across|for\s+each)\s+([A-Za-z][\w\s·\-]{0,40}?)(?=\s|[.,?!]|$)/gi;
  let b: RegExpExecArray | null;
  while ((b = byRegex.exec(q)) !== null) {
    byClauses.push(b[1]!.trim());
  }

  if (!outerOpWord) return null;
  const outerOp = PER_X_OUTER_OP_MAP[outerOpWord];
  if (!outerOp) return null;

  // Classify each clause: temporal vs dimension.
  type Resolved =
    | { kind: "temporal"; column: string; sourceColumn: string; grain: TemporalFacetGrain; raw: string }
    | { kind: "dimension"; column: string; raw: string };
  const resolved: Resolved[] = [];

  const colNames = (dataSummary.columns ?? []).map((c) => c.name);
  const strongestDateCol = (dataSummary.dateColumns ?? [])[0];

  for (const raw of perClauses) {
    if (/^row(\s*id)?$|^records?$|^entries?$|^row\s*number$/i.test(raw)) {
      continue;
    }
    const grain = PER_TEMPORAL_UNIT_TO_GRAIN[raw.toLowerCase()];
    if (grain) {
      if (strongestDateCol) {
        resolved.push({
          kind: "temporal",
          column: facetColumnKey(strongestDateCol, grain),
          sourceColumn: strongestDateCol,
          grain,
          raw,
        });
      }
      continue;
    }
    const matched = findMatchingColumn(raw, colNames);
    if (matched) {
      const colMeta = (dataSummary.columns ?? []).find((c) => c.name === matched);
      const uniqueCount = (colMeta as { uniqueCount?: number } | undefined)?.uniqueCount;
      if (typeof uniqueCount === "number" && uniqueCount > 5000) continue;
      resolved.push({ kind: "dimension", column: matched, raw });
    }
  }

  // Adverbial rate (daily/weekly/monthly): contributes a synthetic temporal
  // clause if not already present.
  if (adverbMatch && strongestDateCol) {
    const adv = adverbMatch[1]!.toLowerCase();
    const adverbToUnit: Record<string, string> = {
      daily: "day",
      weekly: "week",
      monthly: "month",
      quarterly: "quarter",
      yearly: "year",
      annual: "year",
      annually: "year",
    };
    const advRaw = adverbToUnit[adv] ?? adv;
    const grain = PER_TEMPORAL_UNIT_TO_GRAIN[advRaw];
    const alreadyHasTemporal = resolved.some((r) => r.kind === "temporal");
    if (grain && !alreadyHasTemporal) {
      resolved.push({
        kind: "temporal",
        column: facetColumnKey(strongestDateCol, grain),
        sourceColumn: strongestDateCol,
        grain,
        raw: adv,
      });
    }
  }

  // `by` / `across` clauses contribute additional group dimensions.
  for (const raw of byClauses) {
    if (/^row(\s*id)?$|^records?$|^entries?$/i.test(raw)) continue;
    const matched = findMatchingColumn(raw, colNames);
    if (!matched) continue;
    // Don't duplicate; don't conflict with temporal.
    if (resolved.some((r) => r.column === matched)) continue;
    const colMeta = (dataSummary.columns ?? []).find((c) => c.name === matched);
    const uniqueCount = (colMeta as { uniqueCount?: number } | undefined)?.uniqueCount;
    if (typeof uniqueCount === "number" && uniqueCount > 5000) continue;
    resolved.push({ kind: "dimension", column: matched, raw });
  }

  // PD3 fires ONLY when we have AT LEAST ONE temporal AND AT LEAST ONE
  // dimension. Single-temporal questions fall through to PD1. Multiple
  // temporals are ambiguous (which is the rate? which is the bucket?) —
  // also fall through to PD1's first-match behaviour.
  const temporals = resolved.filter((r) => r.kind === "temporal");
  const dimensions = resolved.filter((r) => r.kind === "dimension");
  if (temporals.length === 0 || dimensions.length === 0) return null;
  if (temporals.length > 1) return null;

  const rate = temporals[0]! as Extract<Resolved, { kind: "temporal" }>;
  return {
    outerOp,
    rateDenominator: {
      column: rate.column,
      sourceColumn: rate.sourceColumn,
      grain: rate.grain,
    },
    groupColumns: dimensions.map((d) => d.column),
    rawCaptures: resolved.map((r) => r.raw),
  };
}

export interface InjectMultiPerResult {
  /** Columns rewritten on the aggregations (perDimension added). */
  rewrittenAggColumns: string[];
  /** Columns REMOVED from plan.groupBy (the rate denominator that was incorrectly placed there). */
  removedFromGroupBy: string[];
  skipReason?:
    | "no_intent"
    | "not_execute_query_plan"
    | "no_plan"
    | "no_aggregations"
    | "rate_not_in_group_by"
    | "no_matching_aggregation"
    | "already_nested";
}

/**
 * PD3 · Aggressive multi-per repair. When the planner emitted
 * `groupBy: [groupDim, rateDim]` (the trend-with-breakdown reading of a
 * multi-per question), MOVE the rate denominator OUT of groupBy and into
 * the aggregation's `perDimension` field. The result is the rate-per-group
 * shape: one row per groupDim, value = outer(<innerOp>(metric) per
 * rateDim_bucket).
 *
 * Only fires when:
 *  - intent is a `MultiPerIntent` (≥1 temporal + ≥1 dimension)
 *  - plan.groupBy contains the rate denominator (or its source/facet)
 *  - the matching aggregation's operation aligns with the intent's outerOp
 *  - the aggregation isn't already nested
 *
 * Idempotent: re-running on an already-corrected plan is a no-op.
 */
export function injectMultiPerIntent(
  step: PlanStep,
  intent: MultiPerIntent | null
): InjectMultiPerResult {
  if (!intent) {
    return { rewrittenAggColumns: [], removedFromGroupBy: [], skipReason: "no_intent" };
  }
  if (step.tool !== "execute_query_plan") {
    return {
      rewrittenAggColumns: [],
      removedFromGroupBy: [],
      skipReason: "not_execute_query_plan",
    };
  }
  const plan = step.args?.plan;
  if (!plan || typeof plan !== "object") {
    return { rewrittenAggColumns: [], removedFromGroupBy: [], skipReason: "no_plan" };
  }
  const planObj = plan as Record<string, unknown>;
  const aggs = Array.isArray(planObj.aggregations)
    ? (planObj.aggregations as Array<Record<string, unknown>>)
    : null;
  if (!aggs || !aggs.length) {
    return {
      rewrittenAggColumns: [],
      removedFromGroupBy: [],
      skipReason: "no_aggregations",
    };
  }

  const groupBy = Array.isArray(planObj.groupBy)
    ? (planObj.groupBy as string[]).map(String)
    : [];

  // Build equivalence set for the rate denominator (perDim + source + all
  // facets over source). Same idea as PD2's semanticDecompositionAliases,
  // but here we WANT a match — to move the column out of groupBy.
  const rateAliases = new Set<string>([intent.rateDenominator.column]);
  rateAliases.add(intent.rateDenominator.sourceColumn);
  const grains: TemporalFacetGrain[] = [
    "date",
    "week",
    "month",
    "quarter",
    "half_year",
    "year",
  ];
  for (const g of grains) {
    rateAliases.add(facetColumnKey(intent.rateDenominator.sourceColumn, g));
  }

  // Find which group-by entries (if any) match the rate denominator.
  const matchingRateEntries: string[] = [];
  const survivingGroupBy: string[] = [];
  for (const g of groupBy) {
    if (rateAliases.has(g)) {
      matchingRateEntries.push(g);
    } else {
      survivingGroupBy.push(g);
    }
  }

  if (matchingRateEntries.length === 0) {
    return {
      rewrittenAggColumns: [],
      removedFromGroupBy: [],
      skipReason: "rate_not_in_group_by",
    };
  }

  // Find aggregations that match the outer op and aren't already nested.
  const rewritten: string[] = [];
  let anyAlreadyNested = false;
  for (const a of aggs) {
    const currentOp = typeof a?.operation === "string" ? a.operation.toLowerCase() : "";
    if (a?.perDimension) {
      anyAlreadyNested = true;
      continue;
    }
    const opOk =
      (intent.outerOp === "mean" && (currentOp === "mean" || currentOp === "avg")) ||
      (intent.outerOp === "sum" && currentOp === "sum") ||
      (intent.outerOp === "min" && currentOp === "min") ||
      (intent.outerOp === "max" && currentOp === "max");
    if (!opOk) continue;
    if (Array.isArray(a.predicate) && a.predicate.length > 0) continue;

    a.perDimension = intent.rateDenominator.column;
    a.innerOperation = "sum";
    rewritten.push(typeof a.column === "string" ? a.column : "<unknown>");
  }

  if (rewritten.length === 0) {
    return {
      rewrittenAggColumns: [],
      removedFromGroupBy: [],
      skipReason: anyAlreadyNested ? "already_nested" : "no_matching_aggregation",
    };
  }

  // ONLY commit the groupBy mutation when we actually rewrote an
  // aggregation. Otherwise we'd strip the rate column without nesting,
  // changing the plan's semantics for the worse.
  planObj.groupBy = survivingGroupBy;

  return {
    rewrittenAggColumns: rewritten,
    removedFromGroupBy: matchingRateEntries,
  };
}

// =============================================================================
// Wave QL2 · Aggregation-intent floor
// =============================================================================
//
// Background: the planner LLM CAN miss aggregation questions. The Marico-VN
// "What is the average number of compliance visits per day across all
// clusters?" case generated 5 hypotheses but zero `execute_query_plan` steps,
// causing the narrator to emit "not computable" despite the dataset having
// the literal columns the question names. Existing PD1 / PD3 repair passes
// only fix bad plans — they need the LLM to emit ONE step first.
//
// This floor synthesizes a deterministic `execute_query_plan` step when the
// question matches an aggregation shape and the LLM emitted zero (or only
// non-analytical) steps. The synthesized step is prepended to the plan and
// flows through the existing repair pipeline like any LLM-emitted step.

export type AggregationSynthReason =
  | "multi_per_intent"
  | "per_x_with_answer_dim"
  | "per_x_no_answer_dim"
  | "simple_aggregation";

export interface SynthesizedAggregationStep {
  /** Ready-to-run `execute_query_plan` step. */
  step: PlanStep;
  /** Why the synthesis fired (audit / log / test). */
  reason: AggregationSynthReason;
  /** Metric column resolved from the question. */
  metricColumn: string;
  /** Normalised outer aggregation operation. */
  outerOp: string;
  /** groupBy used (empty for ungrouped simple aggregations). */
  groupBy: string[];
}

/** Outer-op verb → canonical aggregation operation string. */
const SIMPLE_AGG_TO_OP: Record<string, string> = {
  average: "mean",
  avg: "mean",
  mean: "mean",
  total: "sum",
  sum: "sum",
  count: "count",
  max: "max",
  maximum: "max",
  highest: "max",
  min: "min",
  minimum: "min",
  lowest: "min",
};

const SIMPLE_AGG_VERB_RE =
  /\b(average|avg|mean|total|sum|count|max|maximum|highest|min|minimum|lowest)\b/i;

const ANSWER_DIM_RE =
  /\b(?:by|across|for\s+each|for\s+every|grouped\s+by|broken\s+down\s+by)\s+(?:all\s+|the\s+|each\s+|every\s+)?([A-Za-z][\w\s·\-]{0,40}?)(?=\s|[.,?!]|$)/gi;

/**
 * Wave QL2 · Resolve an answer-dimension column from "across X" / "by X" /
 * "for each X" clauses. Strips stop-words ("all", "the", "each", "every")
 * and applies a singular-fallback ("clusters" → "cluster") so plural
 * spoken English binds to singular column names.
 *
 * Returns the first matching non-date dimension column with reasonable
 * cardinality, or null when no clause resolves cleanly.
 */
export function resolveAnswerDimensionFromQuestion(
  question: string | undefined,
  dataSummary: Pick<DataSummary, "columns" | "dateColumns">,
  options?: { wideFormatTransform?: WideFormatTransform }
): string | null {
  const q = (question ?? "").trim();
  if (!q) return null;
  const colNames = (dataSummary.columns ?? []).map((c) => c.name);
  const dateSet = new Set(dataSummary.dateColumns ?? []);
  ANSWER_DIM_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ANSWER_DIM_RE.exec(q)) !== null) {
    const raw = m[1]!.trim();
    if (!raw) continue;
    if (/^(row|records?|entries?|things?|items?)\b/i.test(raw)) continue;
    let matched = findMatchingColumn(raw, colNames, {
      wideFormatTransform: options?.wideFormatTransform,
    });
    if (!matched && raw.length > 3 && raw.toLowerCase().endsWith("s")) {
      matched = findMatchingColumn(raw.slice(0, -1), colNames, {
        wideFormatTransform: options?.wideFormatTransform,
      });
    }
    if (!matched) continue;
    if (dateSet.has(matched)) continue;
    const colMeta = (dataSummary.columns ?? []).find((c) => c.name === matched);
    const uniqueCount = (colMeta as { uniqueCount?: number } | undefined)
      ?.uniqueCount;
    if (typeof uniqueCount === "number" && uniqueCount > 5000) continue;
    return matched;
  }
  return null;
}

/**
 * Wave QL2 · Resolve the metric column the user wants to aggregate. Scans
 * the question for a numeric-column mention via existing `findMatchingColumn`
 * (which already handles substring/reverse-substring matching). Prefers
 * non-identifier-looking numeric columns and applies a singular-fallback.
 *
 * Returns null when no numeric column matches — caller must skip synthesis
 * rather than guess.
 */
export function resolveMetricColumnFromQuestion(
  question: string | undefined,
  dataSummary: Pick<DataSummary, "columns" | "numericColumns">,
  options?: { wideFormatTransform?: WideFormatTransform }
): string | null {
  const q = (question ?? "").trim();
  if (!q) return null;
  const numericSet = new Set(dataSummary.numericColumns ?? []);
  const numericCols = (dataSummary.columns ?? []).filter((c) =>
    numericSet.has(c.name)
  );
  if (numericCols.length === 0) return null;
  const numericColNames = numericCols.map((c) => c.name);

  // 1) Exact substring match against full numeric column name (most reliable).
  //    Strip apostrophes so "Total Visited OL's" matches "total visited ol s".
  const qLower = q.toLowerCase();
  const qNormalized = qLower.replace(/[''`]/g, "");
  let best: { name: string; len: number } | null = null;
  for (const col of numericCols) {
    const nameLower = col.name.toLowerCase().replace(/[''`]/g, "");
    if (nameLower.length >= 3 && qNormalized.includes(nameLower)) {
      if (!best || nameLower.length > best.len) {
        best = { name: col.name, len: nameLower.length };
      }
    }
  }
  if (best) return best.name;

  // 2) Fuzzy match via question n-grams (1-3 words).
  const tokens = q.split(/[^\w]+/).filter((t) => t.length >= 3);
  const grams: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (i + 2 < tokens.length) {
      grams.push(`${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`);
    }
    if (i + 1 < tokens.length) {
      grams.push(`${tokens[i]} ${tokens[i + 1]}`);
    }
    grams.push(tokens[i]!);
  }
  for (const gram of grams) {
    const matched = findMatchingColumn(gram, numericColNames, {
      wideFormatTransform: options?.wideFormatTransform,
    });
    if (matched) return matched;
    if (gram.toLowerCase().endsWith("s") && gram.length > 3) {
      const singular = gram.slice(0, -1);
      const matchedSingular = findMatchingColumn(singular, numericColNames, {
        wideFormatTransform: options?.wideFormatTransform,
      });
      if (matchedSingular) return matchedSingular;
    }
  }
  return null;
}

function slugifyForAlias(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

interface BuildSynthStepInput {
  groupBy: string[];
  metric: string;
  outerOp: string;
  perDimension: string | null;
  /**
   * Wave QL7 · When set (and `outerOp === "mean"`), emit the simpler ratio
   * shape: `SUM(metric) / COUNT(DISTINCT denominatorSourceColumn) AS avg`.
   * One row per group, simple arithmetic, no nested aggregation. Set to
   * the SOURCE column of a temporal facet (e.g. "Date" for "Day · Date")
   * so the count is over distinct calendar days.
   *
   * When null, falls back to the legacy perDimension nested shape (or a
   * flat groupBy + agg if perDimension is also null).
   */
  denominatorSourceColumn?: string | null;
  idPrefix?: string;
  reason: AggregationSynthReason;
}

function buildSynthAggregationStep(
  input: BuildSynthStepInput
): SynthesizedAggregationStep {
  const {
    groupBy,
    metric,
    outerOp,
    perDimension,
    denominatorSourceColumn,
    idPrefix,
    reason,
  } = input;

  let plan: Record<string, unknown>;
  // Wave QL7 · Prefer the ratio shape for mean-rate questions with a
  // temporal denominator. Simpler than perDimension, one row per group,
  // and the planner LLM is far less likely to mis-emit it as a 2D grid.
  if (
    denominatorSourceColumn &&
    outerOp === "mean"
  ) {
    const metricSlug = slugifyForAlias(metric);
    const denomSlug = slugifyForAlias(denominatorSourceColumn);
    const sumAlias = `total_${metricSlug}`;
    const countAlias = `num_distinct_${denomSlug}`;
    const ratioAlias = `avg_${metricSlug}_per_${denomSlug}`;
    const aggregations: Record<string, unknown>[] = [
      { column: metric, operation: "sum", alias: sumAlias },
      {
        column: denominatorSourceColumn,
        operation: "count_distinct",
        alias: countAlias,
      },
    ];
    const computedAggregations = [
      {
        alias: ratioAlias,
        expression: `${sumAlias} / ${countAlias}`,
      },
    ];
    plan = { aggregations, computedAggregations };
  } else {
    const aggEntry: Record<string, unknown> = {
      column: metric,
      operation: outerOp,
      alias: `${outerOp}_${slugifyForAlias(metric)}`,
    };
    if (perDimension) {
      aggEntry.perDimension = perDimension;
      aggEntry.innerOperation = "sum";
    }
    plan = { aggregations: [aggEntry] };
  }
  if (groupBy.length > 0) plan.groupBy = [...groupBy];
  const suffix = Math.random().toString(36).slice(2, 8);
  return {
    step: {
      id: `${idPrefix ?? "ql2"}_synth_${suffix}`,
      tool: "execute_query_plan",
      args: { plan },
    },
    reason,
    metricColumn: metric,
    outerOp,
    groupBy: [...groupBy],
  };
}

/**
 * Wave QL2 · Aggregation-intent floor. Returns a synthetic
 * `execute_query_plan` step when the question matches an aggregation shape
 * and the metric column resolves unambiguously. Returns null otherwise
 * (caller falls through to the existing empty-plan retry path).
 *
 * Priority of intent shapes:
 *   1. Multi-per (PD3): "<agg> X per Y per Z" / "<agg> X per Y across Z" / etc.
 *      Uses Y as rate denominator, Z as answer dimension.
 *   2. Single-per (PD1) + standalone answer dim from "across/by X".
 *      Uses Y as rate denominator, X as answer dimension.
 *   3. Single-per (PD1) alone — synthesizes a one-row rate aggregation.
 *   4. Simple aggregation ("What is the average X" / "Total X by Y") with no
 *      per-clause — synthesizes a flat groupBy aggregation.
 *
 * Returns null when:
 *   - The question matches no aggregation verb.
 *   - The metric column can't be resolved from the question.
 *   - All intent shapes failed to produce a concrete plan.
 */
export function synthesizeAggregationStep(
  question: string | undefined,
  dataSummary: Pick<
    DataSummary,
    "columns" | "dateColumns" | "numericColumns"
  > & { wideFormatTransform?: WideFormatTransform },
  perXIntent: PerXIntent | null,
  multiPerIntent: MultiPerIntent | null,
  options?: { idPrefix?: string }
): SynthesizedAggregationStep | null {
  const q = (question ?? "").trim();
  if (!q) return null;
  const wf = dataSummary.wideFormatTransform;

  // Branch 1 · multi-per intent has both rate denominator and group dim.
  if (multiPerIntent && multiPerIntent.groupColumns.length > 0) {
    const metric = resolveMetricColumnFromQuestion(q, dataSummary, {
      wideFormatTransform: wf,
    });
    if (!metric) return null;
    return buildSynthAggregationStep({
      groupBy: multiPerIntent.groupColumns,
      metric,
      outerOp: multiPerIntent.outerOp,
      perDimension: multiPerIntent.rateDenominator.column,
      // Wave QL7 · multiPerIntent.rateDenominator always carries the source
      // column (it's a temporal facet by construction). Use it for the
      // simpler ratio shape.
      denominatorSourceColumn: multiPerIntent.rateDenominator.sourceColumn,
      idPrefix: options?.idPrefix,
      reason: "multi_per_intent",
    });
  }

  // Branch 2/3 · single-per intent (PD1) — try to find a standalone answer dim.
  if (perXIntent) {
    const metric = resolveMetricColumnFromQuestion(q, dataSummary, {
      wideFormatTransform: wf,
    });
    if (!metric) return null;
    const answerDim = resolveAnswerDimensionFromQuestion(q, dataSummary, {
      wideFormatTransform: wf,
    });
    // Wave QL9.B · Suppress synthesis for the degenerate scalar case:
    // "average X per <temporal unit>" with NO answer dimension. The LLM's
    // exploratory step (typically a date-grouped trend) already gives the
    // user the breakdown that produces the scalar answer; adding the floor's
    // single-row [SUM, COUNT_DISTINCT, ratio] step on top produces a
    // confusing duplicate visualization for what should be one number.
    // Non-temporal per-clauses (per customer / per region) still go through
    // — the LLM has no natural denominator there and the floor's ratio
    // shape is the cleanest expression.
    // Multi-per intents (per day per cluster) fire from Branch 1 above
    // and are unaffected by this guard — the floor is load-bearing there.
    if (!answerDim && perXIntent.perDimensionKind === "temporal") {
      return null;
    }
    return buildSynthAggregationStep({
      groupBy: answerDim ? [answerDim] : [],
      metric,
      outerOp: perXIntent.outerOp,
      perDimension: perXIntent.perDimension,
      // Wave QL7 · Only temporal perDimensions translate cleanly to ratio
      // shape (COUNT(DISTINCT date) makes sense; COUNT(DISTINCT region)
      // doesn't have the same physical meaning per row). Non-temporal
      // perDimensions fall through to the legacy nested shape.
      denominatorSourceColumn:
        perXIntent.perDimensionKind === "temporal"
          ? perXIntent.sourceColumn ?? null
          : null,
      idPrefix: options?.idPrefix,
      reason: answerDim ? "per_x_with_answer_dim" : "per_x_no_answer_dim",
    });
  }

  // Branch 4 · simple aggregation with no per-clause ("What is the total X by Y").
  const verbMatch = q.match(SIMPLE_AGG_VERB_RE);
  if (!verbMatch) return null;
  const outerOp = SIMPLE_AGG_TO_OP[verbMatch[1]!.toLowerCase()];
  if (!outerOp) return null;
  const metric = resolveMetricColumnFromQuestion(q, dataSummary, {
    wideFormatTransform: wf,
  });
  if (!metric) return null;
  // Refuse "count of <date>" — count on a date column is rarely what's asked;
  // it's typically a mis-extraction.
  const dateSet = new Set(dataSummary.dateColumns ?? []);
  if (outerOp === "count" && dateSet.has(metric)) return null;
  const answerDim = resolveAnswerDimensionFromQuestion(q, dataSummary, {
    wideFormatTransform: wf,
  });
  return buildSynthAggregationStep({
    groupBy: answerDim ? [answerDim] : [],
    metric,
    outerOp,
    perDimension: null,
    idPrefix: options?.idPrefix,
    reason: "simple_aggregation",
  });
}

/**
 * Wave QL2 · Idempotency check. Returns true when an existing
 * `execute_query_plan` step already covers the synthesized aggregation
 * (same outer op + same metric column + groupBy contains all answer dims).
 * When true, the caller should skip synthesis to avoid duplicate work.
 *
 * Wave QL8 · Stricter coverage semantics. If the LLM's groupBy includes the
 * synthesized step's rate denominator (the temporal column whose buckets we
 * average across, e.g. "Day · Date" / "Date" / "Week · Date"), then the
 * LLM has produced a TREND-WITH-BREAKDOWN grid (one row per cluster × date)
 * — that is a different intent from rate-per-group (one row per cluster).
 * The synth step is NOT covered; return false so synthesis fires and the
 * user gets the literal answer to their question alongside the LLM's
 * exploration.
 */
export function planAlreadyCoversAggregation(
  steps: ReadonlyArray<PlanStep>,
  synth: SynthesizedAggregationStep,
  options?: { dateColumns?: ReadonlyArray<string> }
): boolean {
  const targetOp = synth.outerOp.toLowerCase();
  const targetMetric = synth.metricColumn;

  // Wave QL8 · Derive the synth's rate denominator + its temporal aliases
  // ONCE. The denominator may surface as `perDimension` on an aggregation
  // (current shape) or as a `count_distinct`-op aggregation column (Wave
  // QL7 ratio shape). The alias set lets us reject "LLM grouped by Date"
  // when synth's perDimension is "Day · Date" — same source, different
  // facet, still the rate denominator semantically.
  const synthRateDenominatorAliases = collectRateDenominatorAliases(
    synth,
    options?.dateColumns
  );

  for (const step of steps) {
    if (step.tool !== "execute_query_plan") continue;
    const plan = (step.args as Record<string, unknown>)?.plan;
    if (!plan || typeof plan !== "object") continue;
    const planObj = plan as Record<string, unknown>;
    const aggs = Array.isArray(planObj.aggregations)
      ? (planObj.aggregations as Array<Record<string, unknown>>)
      : [];
    const groupBy = Array.isArray(planObj.groupBy)
      ? (planObj.groupBy as unknown[]).map(String)
      : [];
    const hasMatchingAgg = aggs.some((a) => {
      const op =
        typeof a?.operation === "string" ? a.operation.toLowerCase() : "";
      const col = typeof a?.column === "string" ? a.column : "";
      return op === targetOp && col === targetMetric;
    });
    if (!hasMatchingAgg) continue;
    const groupByCovers = synth.groupBy.every((g) => groupBy.includes(g));
    if (!groupByCovers) continue;

    // Wave QL8 · Even if the answer dim is covered, reject when the LLM
    // ALSO grouped by the rate denominator — that's a different question
    // (trend-with-breakdown vs. rate-per-group). Synthesis must still
    // fire so the user sees the literal answer in the pivot.
    if (synthRateDenominatorAliases.size > 0) {
      const grabbedRateDim = groupBy.some((g) =>
        synthRateDenominatorAliases.has(g)
      );
      if (grabbedRateDim) {
        console.warn(
          `[planner] ql2_coverage_rejected reason=llm_groupby_includes_rate_denominator ` +
            `synthDenominator=${[...synthRateDenominatorAliases].join("|")} ` +
            `llmGroupBy=${groupBy.join(",")}`
        );
        continue;
      }
    }
    return true;
  }
  return false;
}

/**
 * Wave QL8 · Returns the set of column names that semantically represent
 * the synth's rate denominator — including the literal perDimension, its
 * temporal source column, and all temporal facets over that source. Empty
 * set when the synth has no rate denominator (e.g. simple-aggregation
 * shape with no per-clause).
 */
function collectRateDenominatorAliases(
  synth: SynthesizedAggregationStep,
  dateColumns?: ReadonlyArray<string>
): Set<string> {
  const out = new Set<string>();
  const knownDateCols = new Set(dateColumns ?? []);
  const plan = (synth.step.args as Record<string, unknown>)?.plan as
    | Record<string, unknown>
    | undefined;
  const aggs = Array.isArray(plan?.aggregations)
    ? (plan!.aggregations as Array<Record<string, unknown>>)
    : [];
  for (const a of aggs) {
    // Current shape: perDimension on a nested aggregation.
    if (typeof a?.perDimension === "string" && a.perDimension.trim()) {
      addRateAliases(out, a.perDimension, knownDateCols);
    }
    // Wave QL7 ratio shape: a count_distinct aggregation on a temporal
    // column IS the rate denominator.
    if (
      typeof a?.operation === "string" &&
      a.operation.toLowerCase() === "count_distinct" &&
      typeof a?.column === "string" &&
      a.column.trim()
    ) {
      addRateAliases(out, a.column, knownDateCols);
    }
  }
  return out;
}

function addRateAliases(
  out: Set<string>,
  column: string,
  knownDateCols: ReadonlySet<string>
): void {
  out.add(column);
  // Branch 1 · column IS a temporal facet display key like "Day · Date".
  const parsed = parseTemporalFacetDisplayKey(column);
  if (parsed) {
    addAllFacetsForSource(out, parsed.sourceColumn);
    return;
  }
  // Branch 2 · column is a raw date column (Wave QL7 ratio shape uses
  // count_distinct on the source column itself, not a facet). Expand to
  // all facet aliases so "LLM grouped by Week · Date" still trips QL8
  // when synth's count_distinct is on "Date".
  if (knownDateCols.has(column)) {
    addAllFacetsForSource(out, column);
  }
}

function addAllFacetsForSource(out: Set<string>, sourceColumn: string): void {
  out.add(sourceColumn);
  const grains: TemporalFacetGrain[] = [
    "date",
    "week",
    "month",
    "quarter",
    "half_year",
    "year",
  ];
  for (const g of grains) {
    out.add(facetColumnKey(sourceColumn, g));
  }
}
