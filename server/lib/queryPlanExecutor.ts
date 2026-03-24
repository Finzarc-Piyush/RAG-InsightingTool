/**
 * Structured query plans (Zod) → applyQueryTransformations.
 * Lets the agent pass explicit groupBy / aggregations without NL parsing variance.
 */

import { z } from "zod";
import { applyQueryTransformations } from "./dataTransform.js";
import type { ParsedQuery } from "../shared/queryTypes.js";
import type { DataSummary } from "../shared/schema.js";

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
      .enum(["day", "month", "monthOnly", "quarter", "year"])
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

function assertPlanColumnsAllowed(
  summary: DataSummary,
  plan: QueryPlanBody
): string | null {
  const allowed = new Set(summary.columns.map((c) => c.name));
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
  for (const s of plan.sort ?? []) {
    const e = check(s.column);
    if (e) return e;
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

export function executeQueryPlan(
  data: Record<string, any>[],
  summary: DataSummary,
  plan: QueryPlanBody
): ExecuteQueryPlanSuccess | ExecuteQueryPlanFailure {
  const colErr = assertPlanColumnsAllowed(summary, plan);
  if (colErr) {
    return { ok: false, error: colErr };
  }

  const hasAggregations = (plan.aggregations?.length ?? 0) > 0;
  if (!hasAggregations && (plan.dimensionFilters?.length ?? 0) === 0 && !plan.limit) {
    return {
      ok: false,
      error:
        "Plan must include aggregations, and/or dimensionFilters, and/or limit — avoid full-table scans with no structure.",
    };
  }

  const parsed = queryPlanToParsedQuery(plan);
  const { data: out, descriptions } = applyQueryTransformations(
    data,
    summary,
    parsed
  );

  return { ok: true, data: out, descriptions, parsed };
}

/** True if question implies totals/sums (for verifier). */
export function questionImpliesSumAggregation(question: string): boolean {
  return /\b(total|sums?|combined\s+total|add\s+up|aggregate\s+all)\b/i.test(
    question
  );
}
