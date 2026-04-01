/**
 * Structured query plans (Zod) → applyQueryTransformations.
 * Lets the agent pass explicit groupBy / aggregations without NL parsing variance.
 */

import { z } from "zod";
import { applyQueryTransformations } from "./dataTransform.js";
import type { ParsedQuery } from "../shared/queryTypes.js";
import type { DataSummary } from "../shared/schema.js";
import {
  remapGroupByToTemporalFacet,
  temporalFacetColumnNamesForDateColumns,
  buildLegacyToDisplayFacetMap,
  normalizeLegacyTemporalFacetColumnRef,
  temporalFacetGrainTokenFromFacetColumnName,
  migrateLegacyTemporalFacetRowKeys,
} from "./temporalFacetColumns.js";

const aggOpSchema = z.enum([
  "sum",
  "mean",
  "avg",
  "count",
  "min",
  "max",
  "median",
  "percent_change",
]);

export const queryPlanBodySchema = z
  .object({
    groupBy: z.array(z.string().min(1)).optional(),
    dateAggregationPeriod: z
      .enum(["day", "week", "half_year", "month", "monthOnly", "quarter", "year"])
      .nullable()
      .optional(),
    aggregations: z
      .array(
        z.object({
          column: z.string().min(1),
          operation: aggOpSchema,
          alias: z.string().optional(),
        })
      )
      .optional(),
    dimensionFilters: z
      .array(
        z.object({
          column: z.string().min(1),
          op: z.enum(["in", "not_in"]),
          values: z.array(z.string()),
          match: z
            .enum(["exact", "case_insensitive", "contains"])
            .optional(),
        })
      )
      .optional(),
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

function assertPlanColumnsAllowed(
  summary: DataSummary,
  plan: QueryPlanBody
): string | null {
  const allowed = allowedColumnNamesForQueryPlan(summary);
  const check = (col: string) => {
    if (!allowed.has(col)) return `Column not in schema: ${col}`;
    return null;
  };
  for (const c of plan.groupBy ?? []) {
    const e = check(c);
    if (e) return e;
  }
  for (const a of plan.aggregations ?? []) {
    const e = check(a.column);
    if (e) return e;
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
  for (const s of plan.sort ?? []) {
    if (!allowedSort.has(s.column)) {
      return `Column not in schema: ${s.column}`;
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
  const normalizedPlan =
    clearRedundantDateAggregationForTemporalFacets(withDisplayFacets);
  const colErr = assertPlanColumnsAllowed(summary, normalizedPlan);
  if (colErr) {
    return { ok: false, error: colErr };
  }

  const hasAggregations = (normalizedPlan.aggregations?.length ?? 0) > 0;
  if (
    !hasAggregations &&
    (normalizedPlan.dimensionFilters?.length ?? 0) === 0 &&
    !normalizedPlan.limit
  ) {
    return {
      ok: false,
      error:
        "Plan must include aggregations, and/or dimensionFilters, and/or limit — avoid full-table scans with no structure.",
    };
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

  const parsed = queryPlanToParsedQuery(normalizedPlan);
  const { data: out, descriptions } = applyQueryTransformations(
    data,
    summary,
    parsed
  );

  return { ok: true, data: out, descriptions, parsed };
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
