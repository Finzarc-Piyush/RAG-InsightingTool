/**
 * ============================================================================
 * planArgRepairs.ts — self-healing plan/tool arguments before execution
 * ============================================================================
 * WHAT THIS FILE DOES
 *   When a user asks an analytical question, an LLM "planner" writes a PLAN: a
 *   short list of STEPS, where each step names a TOOL (e.g. `execute_query_plan`
 *   which runs a DuckDB SQL query, `breakdown_ranking`, `run_correlation`, …)
 *   plus the ARGUMENTS to call that tool with (which columns to group by, which
 *   to sum, which filters to apply, sort order, row limits, etc).
 *
 *   LLMs are fluent but imprecise. They routinely emit arguments that are
 *   slightly-to-badly wrong: a column name that doesn't exist, a missing
 *   required field, a sort entry with the wrong key, a filter the user clearly
 *   asked for but the model forgot, or — worst — an aggregation that quietly
 *   produces a WRONG NUMBER (e.g. summing across overlapping time periods, or
 *   mixing "value sales" rows with "volume" rows in one SUM).
 *
 *   This file is a large library of DETERMINISTIC "repair" functions. They run
 *   AFTER the planner produces a plan but BEFORE any tool actually executes.
 *   Each function inspects a step's args and, where it can be confident, fixes
 *   or normalizes them. "Deterministic" = plain code with regexes and lookups,
 *   no extra LLM call — so the behaviour is predictable, testable, and free.
 *
 *   Jargon used throughout:
 *     - dimensionFilters: a list of {column, op, values} filter clauses tools
 *       accept (op = "in" / "not_in" / "eq" / "gt" / …). Some tools nest them
 *       under `args.plan.dimensionFilters`; others take them at top level.
 *     - groupBy / aggregations / sort / limit: the SQL-ish shape of an
 *       execute_query_plan step.
 *     - rollup row: a "category total" row whose value is the sum of its
 *       children (e.g. FEMALE SHOWER GEL = MARICO + PURITE + …). Including it
 *       in a per-brand breakdown means "the parent always wins" — usually wrong.
 *     - wide-format / compound / pure_period shape: dataset layouts where one
 *       column says WHAT a value means (Metric column: value_sales vs volume)
 *       or WHEN (Period columns). Summing the value column without filtering
 *       these mixes incompatible units / overlapping periods → garbage.
 *     - temporal facet: a derived bucketing column like "Day · Date" / "Week ·
 *       Date" used to aggregate a raw date column by a chosen grain.
 *     - "per X" / rate intent: "average visits per day" means SUM per day FIRST,
 *       then AVG across days — a nested aggregation, not a flat average of rows.
 *
 * WHY IT MATTERS
 *   This layer is the single biggest reliability lever in the agentic loop.
 *   Instead of a tool throwing a Zod validation error (or, far worse, silently
 *   returning a plausible-but-wrong number), the plan is quietly corrected so
 *   the tool runs and returns a trustworthy answer. It lets the planner stay
 *   "roughly right" while these guards make it "exactly right".
 *
 * KEY PIECES (grouped by category — see the section dividers below)
 *   Filter injection / dimension hygiene:
 *     - ensureInferredFiltersOnStep   — fill in filters inferred from the
 *       question that the planner forgot to emit.
 *     - injectRollupExcludeFilters / shouldSkipRollupExclude — exclude
 *       category-total rows from breakdowns (unless the user wants them).
 *     - classifyHierarchyIntent       — label each hierarchy as peer-compare /
 *       rollup-mention / share-of-category for a planner prompt hint.
 *     - checkMissingInferredFilters   — verifier backstop: any inferred filter
 *       absent from every applicable step?
 *   Wide-format correctness guards:
 *     - injectCompoundShapeMetricGuard / resolveMetricFromQuestion /
 *       extractDistinctMetricValues — force a single Metric value (or expand
 *       groupBy by Metric) so SUM(Value) doesn't mix units.
 *     - injectPeriodAdditivityGuard   — pin one period so SUM(Value) isn't
 *       computed across overlapping, non-additive period rows.
 *   Schema-drift repairs (make plans pass Zod validation):
 *     - repairExecuteQueryPlanDimensionFilters — default/normalize filter `op`,
 *       coerce `values` to a string array, accept alias keys.
 *     - repairExecuteQueryPlanSort    — normalize sort alias keys/values,
 *       default direction, drop bad entries.
 *   Ranking-intent enforcement:
 *     - extractRankingIntent + enforceRankingPlanShape — recognise "top N" /
 *       "who has the highest X" / "list the products" and force groupBy + sort +
 *       limit so rankings aren't truncated or mis-shaped.
 *   Rate / nested-aggregation intent:
 *     - detectPerXIntent + injectPerDimensionForRateIntent — "avg X per day" →
 *       nested perDimension aggregation.
 *     - detectMultiPerIntent + injectMultiPerIntent — "avg X per day per
 *       cluster" → move the rate denominator out of groupBy into perDimension.
 *     - detectRollingWindowIntent     — "rolling 4-week average" / "YTD" /
 *       "running total" → a windowAggregations shape.
 *   Aggregation-intent floor:
 *     - synthesizeAggregationStep + planAlreadyCoversAggregation — when the
 *       planner emitted ZERO analytical steps for a clear aggregation question,
 *       synthesize one execute_query_plan step from scratch.
 *
 * HOW IT CONNECTS
 *   These helpers are called from the planner / act loop (see `planner.ts` —
 *   the function-level comments name the exact ordering: rollup excludes →
 *   ranking shape → compound metric guard → period guard → per-X / multi-per
 *   rewrites, with the aggregation floor synthesizing a step when the plan is
 *   empty).
 *   They lean on shared building blocks: `findMatchingColumn` (fuzzy column
 *   resolution, ../utils/columnMatcher.js), the temporal-facet helpers in
 *   ../../temporalFacetColumns.js, the period vocabulary in
 *   ../../wideFormat/periodVocabulary.js, and the DataSummary / wide-format
 *   metadata produced at upload time (../../../shared/schema.js).
 */
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
import { matchPeriod } from "../../wideFormat/periodVocabulary.js";
import { logger } from "../../logger.js";
import { VALUE_SALES_METRIC_RE } from "../../factsMetricResolver.js";

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
 * Returns true when the user's question is asking *about* the rollup row
 * rather than comparing peer items. In either case, the deterministic exclude
 * filter must NOT fire — the rollup row needs to be in the data (a) for direct
 * lookups ("show me FEMALE SHOWER GEL") and (b) so the LLM can use it as the
 * denominator for share-of-category questions ("MARICO's share of the
 * category").
 */
const SHARE_PATTERN_RE =
  /(?:\b(?:share|contribution|percentage|percent|fraction|portion|proportion)\b|%)\s+(?:of|in|to|within|out\s+of|relative\s+to|compared\s+to|vs\.?)\b/i;
const CATEGORY_PATTERN_RE =
  /\b(category|categor[iy]|total|grand\s+total|overall|whole|entire|full|everything|all)\b/i;
// Exclusion-intent override: when the user mentions the rollup name AND pairs
// it with an exclusion verb within EXCLUDE_PROXIMITY_WINDOW chars, OR when the
// question contains an explainer ("X is the entire category"), the
// rollup-exclude filter MUST fire — the user is asking *to remove* the rollup,
// not asking about it. Without this, "omit FEMALE SHOWER GEL" is treated the
// same as "tell me about FEMALE SHOWER GEL" and the rollup stays in the data.
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
    // Check exclusion-intent override before honoring the mention.
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
  // "MARICO's share of the category" / "% of total Products" / "what fraction
  // of the overall belongs to MARICO" — share-pattern combined with EITHER the
  // column name OR a generic category word means the user wants the rollup as
  // denominator. Skip the exclude so the rollup row stays in the data; let the
  // narrator + planner hint guide the LLM to use it as the denominator.
  if (SHARE_PATTERN_RE.test(qLower)) {
    const colLower = hierarchy.column.toLowerCase();
    if (qLower.includes(colLower) || CATEGORY_PATTERN_RE.test(qLower)) {
      return { skip: true, reason: "share-of-category" };
    }
  }
  return { skip: false, reason: null };
}

/**
 * Auto-inject `not_in` filters that exclude declared rollup values from the
 * dimensions a step is about to group/rank by. Without this, breakdowns like
 * "Total_Sales by Products" are dominated by the category-total row (e.g.
 * FEMALE SHOWER GEL = sum of MARICO + PURITE + ...) which is just "the parent
 * always wins".
 *
 * Skips injection when:
 *   - The user question explicitly mentions the rollup value (case-insensitive)
 *     — the user is asking *about* the rollup, not comparing peers.
 *   - The user question matches a "share/contribution/% of the category"
 *     pattern — the user wants the rollup AS the denominator.
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
    // Multi-level same-column hierarchies: the user can declare more than one
    // rollup per column (e.g. "World" AND "Asia" are both category totals in a
    // Geography column). Collect ALL rollup values for this column and decide
    // per-value whether to exclude.
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
 * For each declared hierarchy, classify how the user's question relates to it.
 * Used to surface a planner prompt hint that tells the LLM to use the rollup as
 * denominator for share-of-category questions.
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

// ---------------------------------------------------------------------------
// Wide-format correctness guards — compound (Metric column) datasets.
// ---------------------------------------------------------------------------

/**
 * Vocabulary mapping question keywords → metric value families.
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
    metricMatch: VALUE_SALES_METRIC_RE, // shared owner (factsMetricResolver)
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
 * Detect when a step touches the wide-format value column. Mirrors the
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
 * Whether the step's groupBy already includes the metric column, indicating the
 * user wants a cross-metric breakdown (no single-metric filter should be
 * injected — let each metric stay separable).
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
 * Add the metric column to the step's groupBy (for cross-metric questions).
 * Mutates step.args. Returns true when the column was added, false when no
 * addable target existed (silent no-op for tools without a groupBy concept).
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
 * Inject a deterministic Metric-column filter (or expand groupBy by the Metric
 * column for cross-metric intent) on compound-shape datasets.
 *
 * Mirrors the dimension-hierarchy injection pattern. Runs in `planner.ts` right
 * after `injectRollupExcludeFilters`.
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
    // Heuristic default for FMCG: prefer value-sales family (shared owner —
    // now also matches turnover/gmv, consistent with the pivot-defaults path).
    const fallback = distinctMetricValues.find((m) => VALUE_SALES_METRIC_RE.test(m));
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

export interface PeriodAdditivityGuardResult {
  injectedFilter?: { column: string; values: string[] };
  /** Human-readable note surfaced to the user (the chosen single period). */
  caveat?: string;
  reason?:
    | "not_pure_period"
    | "no_value_touch"
    | "no_filter_host"
    | "period_filter_already_present"
    | "period_in_group_by"
    | "no_period_catalog";
}

const PERIOD_COMPARATIVE_SUFFIX_RE = /-(?:YA|2YA|3YA)$/i;
// Canonical sortable calendar PeriodIso shapes (quarter/half/month/week/day/year).
const CALENDAR_ISO_RE =
  /^\d{4}(?:-(?:Q[1-4]|H[12]|W\d{2}|\d{2}(?:-\d{2})?))?$/;

/** 1–3 word n-grams from a question (trailing punctuation stripped per word). */
function questionPeriodNgrams(question: string): string[] {
  const words = question
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[?,.;:!]+$/, ""))
    .filter(Boolean);
  const grams: string[] = [];
  for (let n = 3; n >= 1; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      grams.push(words.slice(i, i + n).join(" "));
    }
  }
  return grams;
}

/**
 * Honor an explicitly-named calendar period (e.g. "Q1 2024") when it exists in
 * the catalog — the user named a concrete period, which must win over the
 * latest-12-months default. Comparative variants (…-YA) are never auto-picked.
 */
function resolveExplicitPeriodIso(
  question: string | undefined,
  periodIsoValues: ReadonlyArray<string>
): string | null {
  if (!question?.trim() || !periodIsoValues.length) return null;
  const catalog = new Map(periodIsoValues.map((v) => [v.toLowerCase(), v]));
  for (const g of questionPeriodNgrams(question)) {
    const m = matchPeriod(g);
    if (m && m.confidence >= 0.7 && !PERIOD_COMPARATIVE_SUFFIX_RE.test(m.iso)) {
      const hit = catalog.get(m.iso.toLowerCase());
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Default single period when the question names none: prefer the latest-12-months
 * rollup (the data's pre-computed answer), else the latest single calendar period
 * (PeriodIso is canonically sortable), else pin to one PeriodKind as a last resort.
 */
function pickDefaultPeriod(
  periodIsoValues: ReadonlyArray<string>,
  periodKindValues: ReadonlyArray<string>,
  isoCol: string,
  kindCol: string
): { column: string; value: string; caveat: string } | null {
  const rollup =
    periodIsoValues.find((v) => /^L12M$/i.test(v)) ??
    periodIsoValues.find((v) => /^L\d+M$/i.test(v)) ??
    periodIsoValues.find((v) => /^MAT\b/i.test(v));
  if (rollup) {
    return {
      column: isoCol,
      value: rollup,
      caveat: `Showing the latest 12 months (${rollup}) only — period rows are pre-computed overlapping totals and cannot be summed across grains.`,
    };
  }
  const calendar = periodIsoValues.filter((v) => CALENDAR_ISO_RE.test(v)).sort();
  if (calendar.length) {
    const latest = calendar[calendar.length - 1]!;
    return {
      column: isoCol,
      value: latest,
      caveat: `Showing the latest period (${latest}) only — period rows overlap and cannot be summed across grains.`,
    };
  }
  const kind =
    periodKindValues.find((k) => /latest_n/i.test(k)) ??
    periodKindValues.find((k) => /quarter/i.test(k)) ??
    periodKindValues[0];
  if (kind) {
    return {
      column: kindCol,
      value: kind,
      caveat: `Filtered to ${kind} periods only to avoid summing overlapping period types.`,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Wide-format correctness guards — pure_period (overlapping period rows).
// ---------------------------------------------------------------------------

/**
 * Inject a single-period dimensionFilter on pure_period (melted wide-format)
 * datasets so SUM(Value) is not computed across the NON-ADDITIVE, overlapping
 * period rows (L12M already = the latest 4 quarters; YTD overlaps quarters).
 *
 * Mirrors `injectCompoundShapeMetricGuard`. Runs in `planner.ts` (and the
 * quick-answer fast path) after the compound guard.
 *
 * Fires ONLY when: pure_period shape AND the step aggregates Value AND groupBy
 * does NOT include a period column AND no Period/PeriodIso/PeriodKind filter is
 * already present. (groupBy-on-period means each row is one period → summing
 * within groups is correct → no-op; this is the quarterly-trend escape hatch.)
 *
 * Default period (per product decision): the latest-12-months rollup
 * (PeriodIso='L12M'); an explicitly-named period in the question wins.
 */
export function injectPeriodAdditivityGuard(
  step: PlanStep,
  wideFormatTransform: WideFormatTransform | undefined,
  userQuestion: string | undefined,
  periodIsoValues: ReadonlyArray<string>,
  periodKindValues: ReadonlyArray<string>
): PeriodAdditivityGuardResult {
  if (
    !wideFormatTransform?.detected ||
    wideFormatTransform.shape !== "pure_period"
  ) {
    return { reason: "not_pure_period" };
  }
  const valueCol = wideFormatTransform.valueColumn;
  const periodCol = wideFormatTransform.periodColumn;
  const isoCol = wideFormatTransform.periodIsoColumn;
  const kindCol = wideFormatTransform.periodKindColumn;

  if (!stepTouchesValueColumn(step, valueCol)) return { reason: "no_value_touch" };
  const host = dimensionFilterHost(step);
  if (!host) return { reason: "no_filter_host" };

  const existing = Array.isArray(host.dimensionFilters)
    ? (host.dimensionFilters as Array<Record<string, unknown>>)
    : [];
  const periodCols = new Set([periodCol, isoCol, kindCol]);
  if (
    existing.some(
      (f) => typeof f?.column === "string" && periodCols.has(f.column as string)
    )
  ) {
    return { reason: "period_filter_already_present" };
  }
  if (collectGroupingDimensions(step).some((d) => periodCols.has(d))) {
    return { reason: "period_in_group_by" };
  }

  const explicitIso = resolveExplicitPeriodIso(userQuestion, periodIsoValues);
  const chosen = explicitIso
    ? {
        column: isoCol,
        value: explicitIso,
        caveat: `Showing ${explicitIso} only — period rows overlap and cannot be summed across grains.`,
      }
    : pickDefaultPeriod(periodIsoValues, periodKindValues, isoCol, kindCol);
  if (!chosen) return { reason: "no_period_catalog" };

  host.dimensionFilters = [
    ...existing,
    {
      column: chosen.column,
      op: "in",
      values: [chosen.value],
      match: "case_insensitive",
    },
  ];
  return {
    injectedFilter: { column: chosen.column, values: [chosen.value] },
    caveat: chosen.caveat,
  };
}

/**
 * Extract the distinct values of the metric column from the dataset.
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

// ---------------------------------------------------------------------------
// Schema-drift repairs — make a structurally-wrong plan pass Zod validation.
// ---------------------------------------------------------------------------

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

    // Accept the extended op set (eq/neq/lt/lte/gt/gte/between) alongside
    // categorical in/not_in. Default to "in" only when the planner emitted
    // nothing usable.
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
// Ranking / leaderboard / entity-max question intent extraction +
// deterministic plan-shape enforcement.
//
// Extracted to ./planArgRepairs/ranking.ts (Wave R31, behaviour-preserving
// re-export split). The symbols below are re-exported so every existing
// `from ".../planArgRepairs.js"` import keeps resolving unchanged. Questions
// like "who are the top 300 salespeople" / "who has the maximum leaves this
// month" / "list the products" are recognised there and forced into a clean
// groupBy + sort + limit shape.
// ---------------------------------------------------------------------------
export {
  extractRankingIntent,
  enforceRankingPlanShape,
} from "./planArgRepairs/ranking.js";
export type {
  RankingIntentKind,
  RankingIntent,
  EnforceRankingResult,
} from "./planArgRepairs/ranking.js";

// =============================================================================
// "per X" rate-intent detection + deterministic plan repair
// =============================================================================
//
// User asks "What is the average number of compliance visits per day across
// clusters?" → a naive plan emits a single-pass `mean(Compliance Visit)
// GROUP BY Cluster`, which averages RAW ROWS. When each row is already a
// per-employee-per-day count, that's the wrong number — the user wanted
// per-cluster daily totals averaged across days. We detect this intent from
// question phrasing and rewrite the plan to use the
// `aggregations[].perDimension` primitive (executed as a derived-table
// subquery: SUM per (cluster, day) inside, AVG across days outside).
//
// Mirrors the deterministic-repair pattern used above: regex-gated detection,
// override-by-mention, idempotent rewrite, called from planner.ts right after
// `injectCompoundShapeMetricGuard`.

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
 * Detect "<outerOp> X per Y" intent in the user's question. Returns
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
   * For temporal intents, the source date column the perDimension facet
   * derives from (e.g. perDimension="Day · Date" → sourceColumn="Date").
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
 * Rolling-window / cumulative intent.
 *
 * Detects user phrasings that map naturally to a `windowAggregations`
 * shape rather than `perDimension` nested aggregation. Examples we want
 * to catch:
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
 * Injector. For an `execute_query_plan` step whose aggregations are
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
 * Returns the set of column names that are semantically equivalent to
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

  // Semantic check: the planner may have already decomposed the temporal axis
  // via the raw date column (groupBy: ["Cluster Name",
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
// Multi-per intent — "<agg> X per Y per Z" / "<agg> X per Y by Z"
// =============================================================================
//
// English reading: "average compliance visits PER DAY PER CLUSTER" means
// "for each cluster, the average daily total of compliance visits". Y (first
// per-target, usually temporal) is the RATE DENOMINATOR. Z (subsequent
// per/by-targets) is the ANSWER DIMENSION the result is grouped by.
//
// Single-per detection treats the first `per` clause as a rate; the semantic-
// skip prevents over-rewriting when the planner already decomposed by date.
// But for multi-per, the planner OFTEN puts BOTH Y and Z in groupBy, picking
// the trend-with-breakdown interpretation. This pass recognises that and
// ACTIVELY MOVES the rate denominator out of groupBy into perDimension —
// turning the wrong-interpretation plan into the right-interpretation plan
// deterministically.

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
 * Strict multi-per detector. Returns a MultiPerIntent ONLY when the question
 * has both a temporal per-clause (rate denominator) AND at least one other
 * resolvable dimension per-clause (group). Otherwise null — single-per cases
 * fall through to the single-per detector (`detectPerXIntent`).
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

  // Outer-op verb (any form). Reuse the single-per detector's mapping.
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

  // Fire ONLY when we have AT LEAST ONE temporal AND AT LEAST ONE dimension.
  // Single-temporal questions fall through to the single-per detector. Multiple
  // temporals are ambiguous (which is the rate? which is the bucket?) — also
  // fall through to the single-per detector's first-match behaviour.
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
 * Aggressive multi-per repair. When the planner emitted
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
  // facets over source). Same idea as semanticDecompositionAliases, but here
  // we WANT a match — to move the column out of groupBy.
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
// Aggregation-intent floor
// =============================================================================
//
// Background: the planner LLM CAN miss aggregation questions entirely. A
// question like "What is the average number of compliance visits per day across
// all clusters?" can generate hypotheses but zero `execute_query_plan` steps,
// causing the narrator to emit "not computable" despite the dataset having the
// literal columns the question names. The per-X / multi-per repair passes above
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
 * Resolve an answer-dimension column from "across X" / "by X" /
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
 * Resolve the metric column the user wants to aggregate. Scans the question for
 * a numeric-column mention via existing `findMatchingColumn`
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
   * When set (and `outerOp === "mean"`), emit the simpler ratio shape:
   * `SUM(metric) / COUNT(DISTINCT denominatorSourceColumn) AS avg`.
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
  // Prefer the ratio shape for mean-rate questions with a temporal
  // denominator. Simpler than perDimension, one row per group,
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
 * Aggregation-intent floor. Returns a synthetic `execute_query_plan` step when
 * the question matches an aggregation shape and the metric column resolves
 * unambiguously. Returns null otherwise (caller falls through to the existing
 * empty-plan retry path).
 *
 * Priority of intent shapes:
 *   1. Multi-per: "<agg> X per Y per Z" / "<agg> X per Y across Z" / etc.
 *      Uses Y as rate denominator, Z as answer dimension.
 *   2. Single-per + standalone answer dim from "across/by X".
 *      Uses Y as rate denominator, X as answer dimension.
 *   3. Single-per alone — synthesizes a one-row rate aggregation.
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

  // Branch 1 — multi-per intent has both rate denominator and group dim.
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
      // multiPerIntent.rateDenominator always carries the source column (it's a
      // temporal facet by construction). Use it for the simpler ratio shape.
      denominatorSourceColumn: multiPerIntent.rateDenominator.sourceColumn,
      idPrefix: options?.idPrefix,
      reason: "multi_per_intent",
    });
  }

  // Branch 2/3 — single-per intent — try to find a standalone answer dim.
  if (perXIntent) {
    const metric = resolveMetricColumnFromQuestion(q, dataSummary, {
      wideFormatTransform: wf,
    });
    if (!metric) return null;
    const answerDim = resolveAnswerDimensionFromQuestion(q, dataSummary, {
      wideFormatTransform: wf,
    });
    // Suppress synthesis for the degenerate scalar case:
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
      // Only temporal perDimensions translate cleanly to ratio shape
      // (COUNT(DISTINCT date) makes sense; COUNT(DISTINCT region)
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

  // Branch 4 — simple aggregation with no per-clause ("What is the total X by Y").
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
 * Idempotency check. Returns true when an existing `execute_query_plan` step
 * already covers the synthesized aggregation (same outer op + same metric
 * column + groupBy contains all answer dims). When true, the caller should skip
 * synthesis to avoid duplicate work.
 *
 * Stricter coverage semantics: if the LLM's groupBy includes the synthesized
 * step's rate denominator (the temporal column whose buckets we
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

  // Derive the synth's rate denominator + its temporal aliases ONCE. The
  // denominator may surface as `perDimension` on an aggregation (nested shape)
  // or as a `count_distinct`-op aggregation column (ratio shape). The alias
  // set lets us reject "LLM grouped by Date"
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

    // Even if the answer dim is covered, reject when the LLM ALSO grouped by
    // the rate denominator — that's a different question
    // (trend-with-breakdown vs. rate-per-group). Synthesis must still
    // fire so the user sees the literal answer in the pivot.
    if (synthRateDenominatorAliases.size > 0) {
      const grabbedRateDim = groupBy.some((g) =>
        synthRateDenominatorAliases.has(g)
      );
      if (grabbedRateDim) {
        logger.warn(
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
 * Returns the set of column names that semantically represent the synth's rate
 * denominator — including the literal perDimension, its
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
    // Ratio shape: a count_distinct aggregation on a temporal column IS the
    // rate denominator.
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
  // Branch 2 · column is a raw date column (the ratio shape uses
  // count_distinct on the source column itself, not a facet). Expand to all
  // facet aliases so "LLM grouped by Week · Date" still trips the coverage
  // check when synth's count_distinct is on "Date".
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
