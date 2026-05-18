/**
 * Wave W60 · `execute_metric_query` tool dispatcher.
 *
 * Closes the W56 + W57 + W58 + W59a + W59b semantic-layer chain. Until
 * now the catalog was read-only grounding: every planner LLM call saw
 * the byte-stable manifest from `formatMetricCatalog` (W59b) but the
 * planner still had to translate metric / dimension names back to raw
 * `execute_query_plan` shapes against schema columns. W60 promotes the
 * catalog to a first-class dispatch path — the planner emits
 * `{ metric, breakdownBy?, filters?, sortBy?, limit? }` against the
 * **semantic** names, the compiler (W58) translates to a `QueryPlanBody`
 * against raw columns, and the executor runs through the existing
 * `execute_query_plan` plumbing (DuckDB first, in-memory fallback).
 *
 * Args mirror `CompileMetricQueryInput` minus the `model` (read from
 * `ctx.exec.chatDocument.semanticModel`). The tool fails fast with a
 * clear summary when there is no catalog on the session — planner
 * should fall back to `execute_query_plan` against raw schema columns.
 *
 * Pure dispatcher: the only side effect is registry delegation to
 * `execute_query_plan`. Compilation is pure (`compileMetricQuery` from
 * W58). The plan-to-body conversion (`compiledPlanToQueryPlanBody`) is
 * exported so tests can exercise it directly.
 */

import { z } from "zod";
import type { ToolRegistry, ToolResult } from "../toolRegistry.js";
import { agentLog } from "../agentLogger.js";
import {
  compileMetricQuery,
  type CompiledQueryPlan,
} from "../../../semantic/compiler.js";
import type { QueryPlanBody } from "../../../queryPlanExecutor.js";

const semanticFilterSchema = z
  .object({
    dimension: z.string().min(1).max(80),
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
    values: z.array(z.string()).min(1).max(50),
    match: z.enum(["exact", "case_insensitive", "contains"]).optional(),
  })
  .strict();

export const executeMetricQueryArgsSchema = z
  .object({
    metric: z.string().min(1).max(80),
    breakdownBy: z.array(z.string().min(1).max(80)).max(8).optional(),
    filters: z.array(semanticFilterSchema).max(20).optional(),
    sortBy: z
      .object({
        by: z.string().min(1).max(80),
        direction: z.enum(["asc", "desc"]),
      })
      .strict()
      .optional(),
    limit: z.number().int().positive().max(50_000).optional(),
  })
  .strict();

export type ExecuteMetricQueryArgs = z.infer<typeof executeMetricQueryArgsSchema>;

/**
 * Convert the compiler's `CompiledQueryPlan` into the executor's
 * `QueryPlanBody` shape. The two are structurally near-identical — this
 * function exists to (a) deep-copy every array so downstream mutation
 * cannot bleed back into the compiler output, (b) drop empty optional
 * fields so the strict `queryPlanBodySchema` doesn't see redundant
 * `[]`s, and (c) keep the bridge in one place so future widening of the
 * compiler (window aggregations, predicates) only touches this file.
 *
 * Exported for direct unit tests — same pattern as W58's
 * `compileMetricQuery`.
 */
export function compiledPlanToQueryPlanBody(
  plan: CompiledQueryPlan,
): QueryPlanBody {
  const body: QueryPlanBody = {
    aggregations: plan.aggregations.map((a) => ({
      column: a.column,
      operation: a.operation,
      alias: a.alias,
    })),
  };
  if (plan.groupBy && plan.groupBy.length > 0) {
    body.groupBy = [...plan.groupBy];
  }
  if (plan.computedAggregations && plan.computedAggregations.length > 0) {
    body.computedAggregations = plan.computedAggregations.map((c) => ({
      alias: c.alias,
      expression: c.expression,
    }));
  }
  if (plan.dimensionFilters && plan.dimensionFilters.length > 0) {
    body.dimensionFilters = plan.dimensionFilters.map((f) => {
      const out: NonNullable<QueryPlanBody["dimensionFilters"]>[number] = {
        column: f.column,
        op: f.op,
        values: [...f.values],
      };
      if (f.match) out.match = f.match;
      return out;
    });
  }
  if (plan.sort && plan.sort.length > 0) {
    body.sort = plan.sort.map((s) => ({
      column: s.column,
      direction: s.direction,
    }));
  }
  if (plan.limit !== undefined) {
    body.limit = plan.limit;
  }
  return body;
}

export function registerExecuteMetricQueryTool(registry: ToolRegistry) {
  registry.register(
    "execute_metric_query",
    executeMetricQueryArgsSchema as unknown as z.ZodType<Record<string, unknown>>,
    async (ctx, args): Promise<ToolResult> => {
      if (ctx.exec.mode !== "analysis") {
        return {
          ok: false,
          summary: "execute_metric_query is only available in analysis mode.",
        };
      }
      const parsed = executeMetricQueryArgsSchema.safeParse(args);
      if (!parsed.success) {
        return {
          ok: false,
          summary: `Invalid args for execute_metric_query: ${parsed.error.message}`,
        };
      }
      const model = ctx.exec.chatDocument?.semanticModel;
      const hasCatalog =
        !!model &&
        ((model.metrics?.length ?? 0) > 0 ||
          (model.dimensions?.length ?? 0) > 0 ||
          (model.hierarchies?.length ?? 0) > 0);
      if (!hasCatalog) {
        return {
          ok: false,
          summary:
            "No semantic catalog on this session. Fall back to execute_query_plan with raw column names from the schema.",
        };
      }
      const compiled = compileMetricQuery({
        model: model!,
        metric: parsed.data.metric,
        breakdownBy: parsed.data.breakdownBy,
        filters: parsed.data.filters,
        sortBy: parsed.data.sortBy,
        limit: parsed.data.limit,
      });
      if (!compiled.ok) {
        return { ok: false, summary: compiled.error };
      }
      const plan = compiledPlanToQueryPlanBody(compiled.plan);
      agentLog("execute_metric_query.compiled", {
        metric: parsed.data.metric,
        breakdownCount: parsed.data.breakdownBy?.length ?? 0,
        filterCount: parsed.data.filters?.length ?? 0,
        sortBy: parsed.data.sortBy?.by,
        aggregationCount: plan.aggregations?.length ?? 0,
        computedAggregations: plan.computedAggregations?.length ?? 0,
      });
      const result = await registry.execute(
        "execute_query_plan",
        { plan },
        ctx,
      );
      // Re-title the workbench entry so the user sees the semantic shape
      // (`execute_metric_query(metric_name)`) rather than the dispatched
      // `execute_query_plan` it travelled through.
      if (result.ok && result.workbenchArtifact) {
        result.workbenchArtifact = {
          ...result.workbenchArtifact,
          title: `execute_metric_query(${parsed.data.metric})`,
        };
      }
      return result;
    },
    {
      description:
        "Run a semantic metric query against the per-session SEMANTIC_CATALOG. Args reference catalog METRIC and DIMENSION names (not raw schema columns); the compiler translates to QueryPlanBody and dispatches through execute_query_plan (DuckDB-first). Prefer this over execute_query_plan whenever the question's measure matches a catalog metric — the catalog encodes the canonical aggregation (e.g. `net_sales = SUM(gross_sales) - SUM(returns)`) so the planner cannot pick the wrong column / aggregation pair. Fall through to execute_query_plan only when no catalog metric covers the measure or you need shape it doesn't yet support (windowAggregations, percent_change, perDimension nested aggregations).",
      argsHelp:
        '{"metric": string (catalog metric name, snake_case), "breakdownBy"?: string[] (catalog dimension names; max 8), "filters"?: [{"dimension": string (catalog dimension name), "op": "in"|"not_in"|"eq"|"neq"|"lt"|"lte"|"gt"|"gte"|"between", "values": string[], "match"?: "exact"|"case_insensitive"|"contains"}], "sortBy"?: {"by": string (the metric name OR a breakdown dimension), "direction": "asc"|"desc"}, "limit"?: number} — refer to SEMANTIC_CATALOG names ONLY; no raw schema columns.',
    },
  );
}
