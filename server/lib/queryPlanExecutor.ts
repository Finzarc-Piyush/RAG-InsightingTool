/**
 * Structured query plans (Zod) → applyQueryTransformations.
 * Lets the agent pass explicit groupBy / aggregations without NL parsing variance.
 */

import { z } from "zod";
import { applyQueryTransformations } from "./dataTransform.js";
import type { DimensionFilter, ParsedQuery } from "../shared/queryTypes.js";
import type { DataSummary } from "../shared/schema.js";
import {
  remapGroupByToTemporalFacet,
  temporalFacetColumnNamesForDateColumns,
  buildLegacyToDisplayFacetMap,
  normalizeLegacyTemporalFacetColumnRef,
  temporalFacetGrainTokenFromFacetColumnName,
  migrateLegacyTemporalFacetRowKeys,
} from "./temporalFacetColumns.js";
import { repairMisassignedDimensionFilters } from "./dimensionFilterRepair.js";

const aggOpSchema = z.enum([
  "sum",
  "mean",
  "avg",
  "count",
  "min",
  "max",
  "median",
  "percent_change",
  // PCT1
  "countIf",
  "sumIf",
  // Wave QL7 · count_distinct — first-class denominator for "average per X"
  // rate questions. Emits `COUNT(DISTINCT col)` in DuckDB and a Set-based
  // count in the in-memory executor. Pairs with `computedAggregations` on
  // the plan body to express `SUM(metric) / COUNT(DISTINCT denom) AS ratio`
  // as a single GROUP BY query (simpler than the nested perDimension shape).
  "count_distinct",
]);

// PCT1 · DimensionFilter shape — exported so countIf/sumIf predicates can reuse
// it. CMP1 will extend the `op` enum with comparison operators (lt/lte/gt/gte/
// eq/neq/between); both top-level dimensionFilters AND predicates pick up the
// extension automatically because they share this schema.
export const dimensionFilterSchema = z
  .object({
    column: z.string().min(1),
    // CMP1 · scalar comparison + range ops alongside categorical in/not_in.
    op: z.enum([
      "in",
      "not_in",
      "eq",
      "neq",
      "lt",
      "lte",
      "gt",
      "gte",
      "between",
    ]),
    values: z.array(z.string()),
    match: z.enum(["exact", "case_insensitive", "contains"]).optional(),
  })
  .superRefine((f, ctx) => {
    if (f.op === "between") {
      if (f.values.length !== 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "between requires exactly two values: [low, high]",
          path: ["values"],
        });
      }
    } else if (
      f.op === "eq" ||
      f.op === "neq" ||
      f.op === "lt" ||
      f.op === "lte" ||
      f.op === "gt" ||
      f.op === "gte"
    ) {
      if (f.values.length !== 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${f.op} requires exactly one value`,
          path: ["values"],
        });
      }
    } else if (f.values.length === 0) {
      // in / not_in
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${f.op} requires at least one value`,
        path: ["values"],
      });
    }
  });

const aggregationEntrySchema = z
  .object({
    column: z.string().min(1),
    operation: aggOpSchema,
    alias: z.string().optional(),
    // PCT1 · predicate for countIf/sumIf. Ignored for other ops.
    predicate: z.array(dimensionFilterSchema).optional(),
    // PD1 · nested aggregation: bucket rows by `perDimension` and apply
    // `innerOperation` within each bucket (default "sum"), then apply
    // `operation` ACROSS the bucket totals. Closes the "average X per Y"
    // semantic gap — single-pass mean of raw rows averages per-row values,
    // which is wrong when each row is already a per-period aggregate.
    perDimension: z.string().min(1).optional(),
    innerOperation: aggOpSchema.optional(),
  })
  .superRefine((agg, ctx) => {
    if (agg.operation === "countIf" || agg.operation === "sumIf") {
      if (!agg.predicate || agg.predicate.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${agg.operation} requires a non-empty predicate`,
          path: ["predicate"],
        });
      }
    }
    if (agg.perDimension !== undefined) {
      // PD1 · percent_change across bucket totals isn't well-defined
      // (which buckets do you compare?). Predicates apply to row-level
      // filtering — use plan.dimensionFilters or innerOperation:"countIf"
      // / "sumIf" if you need a conditional inside the bucket.
      if (agg.operation === "percent_change") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "perDimension is incompatible with operation:percent_change",
          path: ["operation"],
        });
      }
      if (agg.predicate && agg.predicate.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "perDimension is incompatible with aggregation predicate (use plan.dimensionFilters for row-level filtering before bucketing)",
          path: ["predicate"],
        });
      }
      if (
        agg.innerOperation === "countIf" ||
        agg.innerOperation === "sumIf"
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "innerOperation must be a non-conditional aggregator (sum/mean/avg/count/min/max/median)",
          path: ["innerOperation"],
        });
      }
      if (agg.innerOperation === "percent_change") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "innerOperation:percent_change is not supported (apply percent_change at the outer level only)",
          path: ["innerOperation"],
        });
      }
    }
  });

// Wave QL7 · Post-aggregation computed columns. After the GROUP BY produces
// the aggregation rows, wrap them in a SELECT that evaluates each
// `{alias, expression}` against the aggregation aliases. Used to express
// ratios like `SUM(metric) / COUNT(DISTINCT denom)` as a single plan
// (simpler than the nested perDimension shape).
//
// `expression` is a restricted arithmetic mini-language — only `+ - * /
// ( )`, numeric literals, and bare alias identifiers (no SQL functions,
// no string operations, no subqueries). The executors validate the
// expression character-set before emission to prevent SQL injection.
export const computedAggregationSchema = z
  .object({
    alias: z.string().min(1).max(64),
    expression: z.string().min(1).max(240),
  })
  .strict();

export type ComputedAggregation = z.infer<typeof computedAggregationSchema>;

const ALLOWED_EXPRESSION_CHARS_RE = /^[A-Za-z0-9_\s+\-*/().]+$/;

/** Wave QL7 · Validate the restricted arithmetic mini-language for computed
 *  aggregations. Returns the list of alias identifiers the expression references
 *  so the planner can verify each one matches an aggregation alias. */
export function parseComputedAggregationExpression(
  expression: string
): { ok: true; aliasesReferenced: string[] } | { ok: false; error: string } {
  const trimmed = expression.trim();
  if (!trimmed) return { ok: false, error: "expression is empty" };
  if (!ALLOWED_EXPRESSION_CHARS_RE.test(trimmed)) {
    return {
      ok: false,
      error:
        "expression contains disallowed characters (only A-Z, a-z, 0-9, _, whitespace, + - * / ( ) allowed)",
    };
  }
  // Strip numeric literals and operators; what remains are identifier candidates.
  const identifiers = new Set<string>();
  const tokens = trimmed.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  for (const t of tokens) {
    // Reject suspiciously SQL-keyword-looking tokens.
    if (/^(?:select|from|where|group|order|join|union|drop|insert|update|delete|exec|execute|case|when|then|else|end|null|true|false|and|or|not|is|in|like)$/i.test(t)) {
      return { ok: false, error: `identifier '${t}' is not allowed (reserved)` };
    }
    identifiers.add(t);
  }
  return { ok: true, aliasesReferenced: [...identifiers] };
}

/**
 * Wave W1 · Window-function aggregations.
 *
 * Expressed at the ROW level (not after GROUP BY). The executor runs
 * BEFORE the optional GROUP BY pass — the window's output column is
 * materialised onto every row, then the rest of the query (filters,
 * GROUP BY, aggregations, sort, limit) sees it as if it were a regular
 * source column. This is how rolling averages, cumulative sums, and
 * rank-within-group get exposed without a Window-function escape hatch
 * to `run_readonly_sql`.
 *
 * Supported operations (all map to DuckDB window functions):
 *   - `sum` / `mean` / `min` / `max` / `count` — aggregate over a
 *     `partitionBy` group, ordered by `orderBy`, with the `frame`
 *     defining how many rows participate (default: full partition).
 *   - `row_number` / `rank` / `dense_rank` — positional ranking; ignore
 *     `column` and `frame`.
 *   - `lag` / `lead` — value at the previous/next row in the partition;
 *     uses `column`; `offset` defaults to 1.
 *
 * Frame shapes (only the two most-used ones — keeping the surface
 * small enough for the planner LLM to emit reliably):
 *   - `{ rows: N }` → ROWS BETWEEN N-1 PRECEDING AND CURRENT ROW
 *     (rolling window: rolling 4-week avg ⇒ `rows: 4`).
 *   - `{ range: "unbounded_preceding" }` → ROWS BETWEEN UNBOUNDED
 *     PRECEDING AND CURRENT ROW (cumulative sum / running total).
 *
 * If `frame` is omitted, the window covers the entire partition
 * (matches DuckDB's default for the windowed aggregates).
 *
 * Cap: 6 window aggregations per plan — tight to keep the planner
 * prompt focused and the executor's per-row work bounded.
 */
export const windowAggregationSchema = z
  .object({
    alias: z.string().min(1).max(64),
    operation: z.enum([
      "sum",
      "mean",
      "min",
      "max",
      "count",
      "row_number",
      "rank",
      "dense_rank",
      "lag",
      "lead",
    ]),
    /** Required for windowed aggregates + lag/lead; ignored for row_number/rank/dense_rank. */
    column: z.string().min(1).max(200).optional(),
    /** Empty = window spans the entire dataset (no partition). */
    partitionBy: z.array(z.string().min(1).max(200)).max(4).optional(),
    /** Required for every window function — defines row ordering within each partition. */
    orderBy: z
      .array(
        z.object({
          column: z.string().min(1).max(200),
          direction: z.enum(["asc", "desc"]).optional(),
        })
      )
      .min(1)
      .max(4),
    /** Default: full partition. Two supported shapes (see comment above). */
    frame: z
      .union([
        z.object({ rows: z.number().int().positive().max(365) }),
        z.object({ range: z.literal("unbounded_preceding") }),
      ])
      .optional(),
    /** Offset for lag/lead (default 1). Ignored for other operations. */
    offset: z.number().int().positive().max(50).optional(),
  })
  .strict()
  .superRefine((w, ctx) => {
    const NEEDS_COLUMN = new Set(["sum", "mean", "min", "max", "lag", "lead"]);
    if (NEEDS_COLUMN.has(w.operation) && !w.column) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `windowAggregations[${w.alias}]: '${w.operation}' requires 'column'`,
        path: ["column"],
      });
    }
    // row_number / rank / dense_rank ignore `column` if supplied.
    if (
      ["row_number", "rank", "dense_rank"].includes(w.operation) &&
      w.frame
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `windowAggregations[${w.alias}]: ranking operations don't use 'frame'`,
        path: ["frame"],
      });
    }
  });
export type WindowAggregation = z.infer<typeof windowAggregationSchema>;

export const queryPlanBodySchema = z
  .object({
    groupBy: z.array(z.string().min(1)).optional(),
    dateAggregationPeriod: z
      .enum(["day", "week", "half_year", "month", "monthOnly", "quarter", "year"])
      .nullable()
      .optional(),
    aggregations: z.array(aggregationEntrySchema).optional(),
    // Wave QL7 · Optional post-aggregation computed columns. Evaluated AFTER
    // the GROUP BY against the aggregation aliases. Up to 8 per plan.
    computedAggregations: z
      .array(computedAggregationSchema)
      .max(8)
      .optional(),
    // Wave W1 · Optional window-function aggregations. Evaluated at the
    // ROW level BEFORE GROUP BY so the output alias columns can be
    // referenced downstream (filters, aggregations, sort).
    windowAggregations: z.array(windowAggregationSchema).max(6).optional(),
    dimensionFilters: z.array(dimensionFilterSchema).optional(),
    limit: z.number().int().positive().max(50_000).optional(),
    sort: z
      .array(
        z.object({
          column: z.string().min(1),
          direction: z.enum(["asc", "desc"]),
        })
      )
      .optional(),
  })
  .strict();

export const executeQueryPlanArgsSchema = z
  .object({
    plan: queryPlanBodySchema,
  })
  .strict();

export type QueryPlanBody = z.infer<typeof queryPlanBodySchema>;

export function normalizeLegacyTemporalFacetKeysInPlan(
  plan: QueryPlanBody,
  summary: DataSummary
): QueryPlanBody {
  const map = buildLegacyToDisplayFacetMap(summary);
  if (map.size === 0) return plan;
  const norm = (col: string) => normalizeLegacyTemporalFacetColumnRef(col, map);

  const next: QueryPlanBody = { ...plan };
  if (plan.groupBy?.length) {
    next.groupBy = plan.groupBy.map(norm);
  }
  if (plan.aggregations?.length) {
    next.aggregations = plan.aggregations.map((a) => ({
      ...a,
      column: norm(a.column),
      ...(a.alias !== undefined ? { alias: norm(a.alias) } : {}),
      // PCT1 · remap predicate filter columns the same way top-level
      // dimensionFilters get remapped, so countIf/sumIf predicates pick up
      // the same display-facet → physical column rewrites.
      ...(a.predicate?.length
        ? { predicate: a.predicate.map((f) => ({ ...f, column: norm(f.column) })) }
        : {}),
      // PD1 · perDimension is a column reference (often a temporal facet
      // like "Day · Order Date"); normalize legacy `__tf_day__Order_Date`
      // → display facet just like groupBy entries.
      ...(a.perDimension !== undefined
        ? { perDimension: norm(a.perDimension) }
        : {}),
    }));
  }
  if (plan.dimensionFilters?.length) {
    next.dimensionFilters = plan.dimensionFilters.map((f) => ({
      ...f,
      column: norm(f.column),
    }));
  }
  if (plan.sort?.length) {
    next.sort = plan.sort.map((s) => ({ ...s, column: norm(s.column) }));
  }
  return next;
}

function facetGrainMatchesAggregationPeriod(
  grainToken: string,
  period: NonNullable<QueryPlanBody["dateAggregationPeriod"]>
): boolean {
  if (period === "monthOnly" && grainToken === "month") return true;
  if (period === "day" && grainToken === "date") return true;
  return grainToken === period;
}

/**
 * If the plan already groups by a precomputed `__tf_*` column whose grain matches
 * `dateAggregationPeriod`, drop the period so `applyAggregations` does not re-bucket via
 * fuzzy-matched raw date columns (which may be absent on the current frame).
 */
export function clearRedundantDateAggregationForTemporalFacets(
  plan: QueryPlanBody
): QueryPlanBody {
  const period = plan.dateAggregationPeriod;
  if (period == null || !plan.groupBy?.length) return plan;
  for (const g of plan.groupBy) {
    const grain = temporalFacetGrainTokenFromFacetColumnName(g);
    if (grain && facetGrainMatchesAggregationPeriod(grain, period)) {
      return { ...plan, dateAggregationPeriod: undefined };
    }
  }
  return plan;
}


/**
 * Aligns raw date groupBy entries with precomputed `__tf_*` facet columns when the user
 * question implies a coarse period (month/year/…) and those keys exist on rows — same
 * idea as data-ops `remapGroupByToTemporalFacet`. Clears `dateAggregationPeriod` when
 * any groupBy remap occurs so the executor does not double-bucket.
 */
export function remapQueryPlanGroupByToTemporalFacets(
  plan: QueryPlanBody,
  summary: DataSummary,
  availableKeys: Set<string>,
  originalMessage: string | undefined
): QueryPlanBody {
  const groupBy = plan.groupBy;
  if (!groupBy?.length) return plan;
  const dateColumns = summary.dateColumns ?? [];
  let anyRemapped = false;
  const nextGroupBy = groupBy.map((g) => {
    const { groupBy: ng, remapped } = remapGroupByToTemporalFacet({
      groupByColumn: g,
      dateColumns,
      originalMessage,
      availableKeys,
      planDateAggregationPeriod: plan.dateAggregationPeriod ?? null,
    });
    if (remapped) anyRemapped = true;
    return ng;
  });
  if (!anyRemapped) return plan;
  return {
    ...plan,
    groupBy: nextGroupBy,
    dateAggregationPeriod: undefined,
  };
}

export function queryPlanToParsedQuery(plan: QueryPlanBody): ParsedQuery {
  return {
    rawQuestion: "execute_query_plan",
    groupBy: plan.groupBy,
    dateAggregationPeriod: plan.dateAggregationPeriod ?? null,
    aggregations: plan.aggregations,
    dimensionFilters: plan.dimensionFilters,
    limit: plan.limit,
    sort: plan.sort,
  };
}

/** Schema columns plus derived temporal facet names (columnar metadata often omits facets from `columns`). */
export function allowedColumnNamesForQueryPlan(summary: DataSummary): Set<string> {
  const allowed = new Set<string>();
  for (const c of summary.columns) allowed.add(c.name);
  for (const m of summary.temporalFacetColumns ?? []) allowed.add(m.name);
  for (const n of temporalFacetColumnNamesForDateColumns(summary.dateColumns ?? [])) {
    allowed.add(n);
  }
  return allowed;
}

/**
 * P-A4: Cheap "did you mean" suggestions when a plan references a column
 * that isn't in the schema. Case-insensitive prefix / substring match on
 * the full allowed set, ranked by token overlap. Keeps top 3.
 */
function suggestCloseColumnNames(
  missing: string,
  allowed: ReadonlySet<string>
): string[] {
  const m = missing.toLowerCase();
  if (!m) return [];
  const scored: Array<{ name: string; score: number }> = [];
  for (const name of allowed) {
    const n = name.toLowerCase();
    if (n === m) continue;
    let score = 0;
    if (n.startsWith(m) || m.startsWith(n)) score += 4;
    if (n.includes(m) || m.includes(n)) score += 2;
    const mTokens = new Set(m.split(/[^a-z0-9]+/).filter(Boolean));
    const nTokens = new Set(n.split(/[^a-z0-9]+/).filter(Boolean));
    for (const t of mTokens) if (nTokens.has(t)) score += 1;
    if (score > 0) scored.push({ name, score });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((s) => s.name);
}

function formatMissingColumnError(
  missing: string,
  allowed: ReadonlySet<string>
): string {
  const suggestions = suggestCloseColumnNames(missing, allowed);
  // Structured prefix so the reflector / planner can parse it reliably.
  if (suggestions.length === 0) {
    return `Column not in schema: ${missing}`;
  }
  return `Column not in schema: ${missing}. Did you mean: ${suggestions.join(", ")}?`;
}

function assertPlanColumnsAllowed(
  summary: DataSummary,
  plan: QueryPlanBody
): string | null {
  const allowed = allowedColumnNamesForQueryPlan(summary);
  const check = (col: string) => {
    if (!allowed.has(col)) return formatMissingColumnError(col, allowed);
    return null;
  };
  for (const c of plan.groupBy ?? []) {
    const e = check(c);
    if (e) return e;
  }
  for (const a of plan.aggregations ?? []) {
    // PCT1 · countIf has no meaningful column (counts predicate-matching rows);
    // tolerate any non-empty placeholder so the planner doesn't have to invent
    // a real column name when emitting countIf with `column: "*"`.
    if (a.operation !== "countIf") {
      const e = check(a.column);
      if (e) return e;
    }
    for (const f of a.predicate ?? []) {
      const e = check(f.column);
      if (e) return e;
    }
  }
  for (const d of plan.dimensionFilters ?? []) {
    const e = check(d.column);
    if (e) return e;
  }
  const allowedSort = new Set(allowed);
  for (const a of plan.aggregations ?? []) {
    if (a.alias) allowedSort.add(a.alias);
    allowedSort.add(`${a.column}_${a.operation}`);
  }
  // Computed-aggregation aliases (e.g. a boolean-indicator rate
  // `matching / total`) are valid sort targets — they exist in the result set,
  // not the input schema. The planner-layer validator already allows them
  // (commit d7e5aece / Fix C); this is the executor-layer twin that was missing,
  // which produced "Column not in schema: <x>_rate" at runtime.
  for (const ca of plan.computedAggregations ?? []) {
    if (ca?.alias) allowedSort.add(ca.alias);
  }
  for (const s of plan.sort ?? []) {
    if (!allowedSort.has(s.column)) {
      return formatMissingColumnError(s.column, allowedSort);
    }
  }
  return null;
}

export interface ExecuteQueryPlanSuccess {
  ok: true;
  data: Record<string, any>[];
  descriptions: string[];
  parsed: ParsedQuery;
}

export interface ExecuteQueryPlanFailure {
  ok: false;
  error: string;
}

/**
 * Same normalization and validation as executeQueryPlan (before touching row data).
 */
export function normalizeAndValidateQueryPlanBody(
  summary: DataSummary,
  plan: QueryPlanBody
): { ok: true; normalizedPlan: QueryPlanBody } | { ok: false; error: string } {
  const withDisplayFacets = normalizeLegacyTemporalFacetKeysInPlan(plan, summary);
  let planAfterRepair: QueryPlanBody = withDisplayFacets;
  if (withDisplayFacets.dimensionFilters?.length) {
    const repaired = repairMisassignedDimensionFilters(
      withDisplayFacets.dimensionFilters as DimensionFilter[],
      summary
    );
    planAfterRepair = {
      ...withDisplayFacets,
      dimensionFilters: repaired as QueryPlanBody["dimensionFilters"],
    };
  }
  const normalizedPlan =
    clearRedundantDateAggregationForTemporalFacets(planAfterRepair);
  const colErr = assertPlanColumnsAllowed(summary, normalizedPlan);
  if (colErr) {
    return { ok: false, error: colErr };
  }

  const hasAggregations = (normalizedPlan.aggregations?.length ?? 0) > 0;
  const hasWindowAggregations =
    Array.isArray((normalizedPlan as QueryPlanBody).windowAggregations) &&
    ((normalizedPlan as QueryPlanBody).windowAggregations?.length ?? 0) > 0;
  if (
    !hasAggregations &&
    (normalizedPlan.dimensionFilters?.length ?? 0) === 0 &&
    !normalizedPlan.limit &&
    !hasWindowAggregations
  ) {
    return {
      ok: false,
      error:
        "Plan must include aggregations, and/or dimensionFilters, and/or limit — avoid full-table scans with no structure.",
    };
  }

  // PD2 · The in-memory executor's applyQueryTransformations path predates
  // PD1 and doesn't understand `perDimension` (nested aggregation). Rather
  // than silently compute the wrong number (treating perDimension as a
  // no-op), fail closed. Production always has DuckDB (`isDuckDBAvailable()`
  // === true), so this only fires in test/edge environments and protects
  // the user from incorrect math.
  for (const a of normalizedPlan.aggregations ?? []) {
    if (a.perDimension) {
      return {
        ok: false,
        error:
          "perDimension (nested aggregation) requires DuckDB; the in-memory executor cannot run this plan.",
      };
    }
  }

  return { ok: true, normalizedPlan };
}

export function executeQueryPlan(
  data: Record<string, any>[],
  summary: DataSummary,
  plan: QueryPlanBody
): ExecuteQueryPlanSuccess | ExecuteQueryPlanFailure {
  const dateCols = summary.dateColumns ?? [];
  if (data.length > 0 && dateCols.length > 0) {
    migrateLegacyTemporalFacetRowKeys(data, dateCols);
  }
  const v = normalizeAndValidateQueryPlanBody(summary, plan);
  if (!v.ok) {
    return { ok: false, error: v.error };
  }
  const { normalizedPlan } = v;

  // Wave W1 · Apply window aggregations BEFORE the rest of the plan so
  // the output alias columns become first-class source columns for
  // filters, GROUP BY, and downstream aggregations. The DuckDB executor
  // does this via a CTE wrapper; the in-memory path materialises the
  // alias columns onto every row.
  const windowAggs = (normalizedPlan as QueryPlanBody).windowAggregations;
  let rowsForExec = data;
  if (Array.isArray(windowAggs) && windowAggs.length > 0) {
    const winResult = applyWindowAggregationsInMemory(data, windowAggs);
    if (!winResult.ok) {
      return { ok: false, error: winResult.error };
    }
    rowsForExec = winResult.rows;
  }

  const parsed = queryPlanToParsedQuery(normalizedPlan);
  const { data: out, descriptions } = applyQueryTransformations(
    rowsForExec,
    summary,
    parsed
  );

  // Wave QL7 · Post-aggregation computed columns. Evaluated against the
  // aggregation aliases after GROUP BY. Same semantics as the DuckDB
  // wrapping SELECT — see queryPlanDuckdbExecutor.ts.
  const computed = (normalizedPlan as QueryPlanBody).computedAggregations;
  let finalRows = out;
  if (Array.isArray(computed) && computed.length > 0) {
    const evalResult = applyComputedAggregationsInMemory(out, computed);
    if (!evalResult.ok) {
      return { ok: false, error: evalResult.error };
    }
    finalRows = evalResult.rows;
  }

  return { ok: true, data: finalRows, descriptions, parsed };
}

/**
 * Wave QL7 · Evaluate `computedAggregations` against the aggregated rows.
 * For each row, the computed alias columns are appended via a restricted
 * arithmetic expression over the existing column names. Errors out on
 * unknown identifier or invalid expression syntax — never silently swallows.
 *
 * Mirrors the DuckDB-side wrapping SELECT so in-memory + SQL paths produce
 * the same result. Production aggregations hit DuckDB; this is the fallback
 * for chart-enrichment and small-dataset paths.
 */
function applyComputedAggregationsInMemory(
  rows: Record<string, any>[],
  computed: ReadonlyArray<ComputedAggregation>
):
  | { ok: true; rows: Record<string, any>[] }
  | { ok: false; error: string } {
  if (rows.length === 0) return { ok: true, rows };
  const knownAliases = new Set(Object.keys(rows[0] ?? {}));
  // Validate every expression first so we don't half-mutate.
  for (const c of computed) {
    const parsed = parseComputedAggregationExpression(c.expression);
    if (!parsed.ok) {
      return {
        ok: false,
        error: `computedAggregations[${c.alias}]: ${parsed.error}`,
      };
    }
    for (const id of parsed.aliasesReferenced) {
      if (!knownAliases.has(id)) {
        return {
          ok: false,
          error: `computedAggregations[${c.alias}]: identifier '${id}' is not an existing aggregation alias`,
        };
      }
    }
  }
  const out: Record<string, any>[] = [];
  for (const row of rows) {
    const next: Record<string, any> = { ...row };
    for (const c of computed) {
      try {
        // Restricted arithmetic — the expression character-set check above
        // already rejects anything outside [A-Za-z0-9_+\-*/(). ]. Substitute
        // bare identifiers with their numeric values from the row, then
        // evaluate via Function constructor. (Function over eval — no
        // closure access; the substituted expression is pure arithmetic.)
        const subbed = c.expression.replace(/\b[A-Za-z_][A-Za-z0-9_]*\b/g, (id) => {
          const v = Number(next[id]);
          return Number.isFinite(v) ? `(${v})` : "(null)";
        });
        // eslint-disable-next-line no-new-func
        const fn = new Function(`return (${subbed});`);
        const val = fn();
        next[c.alias] = typeof val === "number" && Number.isFinite(val) ? val : null;
      } catch {
        next[c.alias] = null;
      }
    }
    out.push(next);
  }
  return { ok: true, rows: out };
}

/**
 * Wave W1 · Apply windowAggregations to row-level data BEFORE any
 * GROUP BY / aggregation pass. The output alias columns are materialised
 * onto every row so downstream filters / aggregations / sort can
 * reference them as normal source columns.
 *
 * Algorithm:
 *   1. Validate operations + frames; reject unknown identifiers up front
 *      so partial mutations never escape.
 *   2. For each window aggregation: partition rows by `partitionBy`,
 *      sort each partition by `orderBy`, then walk each partition
 *      computing the window value for each row (frame-aware).
 *   3. Materialise alias columns onto a NEW rows array (never mutate
 *      input). The input array can contain thousands of rows but each
 *      window pass is O(N log N) for the sort + O(N · frameSize) for
 *      the walk.
 *
 * Conservative cap: input ≤ 100k rows. Above that, callers fall back
 * to the DuckDB executor where SQL window functions are O(N log N)
 * with hardware-native sort and constant memory.
 */
function applyWindowAggregationsInMemory(
  rows: Record<string, any>[],
  windows: ReadonlyArray<WindowAggregation>
):
  | { ok: true; rows: Record<string, any>[] }
  | { ok: false; error: string } {
  if (rows.length === 0) return { ok: true, rows: [] };
  if (rows.length > 100_000) {
    return {
      ok: false,
      error: `windowAggregations: input row count (${rows.length}) exceeds 100k cap for the in-memory path; route through DuckDB executor instead.`,
    };
  }

  const out: Record<string, any>[] = rows.map((r) => ({ ...r }));

  for (const w of windows) {
    // Build partition key for each row.
    const partitionKey = (row: Record<string, any>): string =>
      (w.partitionBy ?? [])
        .map((c) => String(row[c] ?? "__NULL__"))
        .join("\x1f");
    const partitions = new Map<string, number[]>();
    for (let i = 0; i < out.length; i++) {
      const k = partitionKey(out[i]!);
      if (!partitions.has(k)) partitions.set(k, []);
      partitions.get(k)!.push(i);
    }

    // Sort each partition by orderBy.
    const orderBy = w.orderBy;
    for (const indices of partitions.values()) {
      indices.sort((a, b) => {
        for (const ob of orderBy) {
          const av = out[a]![ob.column];
          const bv = out[b]![ob.column];
          // Null-last for asc, null-first for desc — mirrors SQL default.
          if (av == null && bv == null) continue;
          if (av == null) return ob.direction === "desc" ? -1 : 1;
          if (bv == null) return ob.direction === "desc" ? 1 : -1;
          if (typeof av === "number" && typeof bv === "number") {
            if (av !== bv) return ob.direction === "desc" ? bv - av : av - bv;
            continue;
          }
          const as = String(av);
          const bs = String(bv);
          if (as !== bs) {
            const cmp = as.localeCompare(bs, undefined, { numeric: true });
            return ob.direction === "desc" ? -cmp : cmp;
          }
        }
        return 0;
      });
    }

    // Compute the window value per row.
    const isRanking =
      w.operation === "row_number" ||
      w.operation === "rank" ||
      w.operation === "dense_rank";
    const isLagLead = w.operation === "lag" || w.operation === "lead";
    const offset = w.offset ?? 1;

    for (const indices of partitions.values()) {
      if (isRanking) {
        // row_number: 1..N strictly. rank: ties get the same rank, gaps after.
        // dense_rank: ties get the same rank, no gaps after.
        let prevKey: string | null = null;
        let assigned = 0;
        let nextRank = 1;
        for (let pos = 0; pos < indices.length; pos++) {
          const idx = indices[pos]!;
          const key = orderBy
            .map((ob) => String(out[idx]![ob.column] ?? "__NULL__"))
            .join("\x1f");
          if (w.operation === "row_number") {
            out[idx]![w.alias] = pos + 1;
          } else if (w.operation === "rank") {
            if (key !== prevKey) nextRank = pos + 1;
            out[idx]![w.alias] = nextRank;
            prevKey = key;
          } else {
            // dense_rank
            if (key !== prevKey) assigned += 1;
            out[idx]![w.alias] = Math.max(1, assigned);
            prevKey = key;
          }
        }
        continue;
      }

      if (isLagLead) {
        const col = w.column!;
        for (let pos = 0; pos < indices.length; pos++) {
          const targetPos = w.operation === "lag" ? pos - offset : pos + offset;
          const idx = indices[pos]!;
          out[idx]![w.alias] =
            targetPos >= 0 && targetPos < indices.length
              ? out[indices[targetPos]!]![col] ?? null
              : null;
        }
        continue;
      }

      // Windowed aggregate (sum/mean/min/max/count).
      const col = w.column!;
      const frameRows = w.frame && "rows" in w.frame ? w.frame.rows : undefined;
      const unbounded =
        w.frame && "range" in w.frame && w.frame.range === "unbounded_preceding";
      for (let pos = 0; pos < indices.length; pos++) {
        const idx = indices[pos]!;
        let startPos = 0;
        const endPos = pos; // inclusive
        if (frameRows !== undefined) {
          startPos = Math.max(0, pos - (frameRows - 1));
        } else if (unbounded) {
          startPos = 0;
        } else {
          // No frame → entire partition.
          startPos = 0;
        }
        const slice: number[] = [];
        for (let j = startPos; j <= endPos; j++) {
          const v = Number(out[indices[j]!]![col]);
          if (Number.isFinite(v)) slice.push(v);
        }
        let value: number | null = null;
        if (slice.length === 0 && w.operation !== "count") {
          value = null;
        } else if (w.operation === "sum") {
          value = slice.reduce((a, b) => a + b, 0);
        } else if (w.operation === "mean") {
          value = slice.reduce((a, b) => a + b, 0) / slice.length;
        } else if (w.operation === "min") {
          value = Math.min(...slice);
        } else if (w.operation === "max") {
          value = Math.max(...slice);
        } else if (w.operation === "count") {
          value = slice.length;
        }
        out[idx]![w.alias] = value;
      }
    }
  }
  return { ok: true, rows: out };
}

/** Upper bounds for group count when calendar bucketing is expected to collapse rows. */
const COARSE_DATE_PERIOD_MAX_GROUPS: Record<string, number> = {
  year: 96,
  half_year: 192,
  quarter: 384,
  month: 960,
  monthOnly: 960,
};

/**
 * When dateAggregationPeriod is coarse but output still has many groups, bucketing likely failed
 * (e.g. groupBy column not treated as a date). Returns a SYSTEM_VALIDATION line for observations.
 */
export function validateCoarseDateAggregationOutput(
  parsed: ParsedQuery,
  inputRowCount: number,
  outputRowCount: number
): string | null {
  const period = parsed.dateAggregationPeriod;
  if (
    !period ||
    !parsed.groupBy?.length ||
    !parsed.aggregations?.length ||
    inputRowCount < 80
  ) {
    return null;
  }

  // This heuristic is meant to catch cases where the model *didn't* apply calendar
  // bucketing for the requested coarse grain. When `groupBy` is already a temporal
  // facet column (UI id or legacy `__tf_*`), bucketing is already correct, and
  // rejecting purely on row count can become a false negative for long ranges.
  //
  // Also, the cap below assumes a single date bucket dimension; if there are
  // additional `groupBy` dimensions, group counts can exceed the cap even when
  // bucketing is correct.
  if (parsed.groupBy.length !== 1) {
    return null;
  }

  const gb0 = parsed.groupBy[0] ?? "";
  const facetGrain =
    period === "year"
      ? "year"
      : period === "quarter"
        ? "quarter"
        : period === "half_year"
          ? "half_year"
          : period === "month" || period === "monthOnly"
            ? "month"
            : null;
  if (facetGrain) {
    const token = temporalFacetGrainTokenFromFacetColumnName(gb0);
    if (token === facetGrain) {
      return null;
    }
  }

  const cap = COARSE_DATE_PERIOD_MAX_GROUPS[period];
  if (cap == null) {
    return null;
  }
  if (outputRowCount <= cap) {
    return null;
  }
  return (
    `[SYSTEM_VALIDATION] dateAggregationPeriod=${period} produced ${outputRowCount} groups from ${inputRowCount} rows (expected at most ~${cap} for this period). ` +
    `Calendar bucketing likely did not apply. Replan: use a column listed in dateColumns (or Cleaned_*) in groupBy, or fix dataSummary.dateColumns to match loaded data.`
  );
}

/** True if question implies totals/sums (for verifier). */
export function questionImpliesSumAggregation(question: string): boolean {
  return /\b(total|sums?|combined\s+total|add\s+up|aggregate\s+all)\b/i.test(
    question
  );
}
