/**
 * ============================================================================
 * executeMetricQueryTool.ts — run a "semantic metric" query in plain business terms
 * ============================================================================
 * WHAT THIS FILE DOES
 *   Registers the `execute_metric_query` tool that the AI agent can call while
 *   answering a question. A "semantic catalog" is a per-dataset dictionary of
 *   business measures (e.g. `net_sales = SUM(gross_sales) - SUM(returns)`) and
 *   dimensions (e.g. `region`, `brand`). Instead of forcing the AI to write a
 *   raw query against confusing column names, this tool lets it ask for a
 *   catalog metric by name with optional breakdowns, filters, sorting and a
 *   row limit. A "compiler" then translates that friendly request into the
 *   lower-level query shape (`QueryPlanBody`) and hands it off to the existing
 *   `execute_query_plan` tool, which actually runs the SQL (DuckDB first, with
 *   an in-memory fallback). This file is a pure dispatcher — it does no math
 *   itself, it just translates and delegates.
 *
 * WHY IT MATTERS
 *   The catalog encodes the one correct way to compute each measure, so the AI
 *   can't accidentally pick the wrong column or aggregation (e.g. averaging a
 *   total). Without this tool the planner has to hand-translate every measure
 *   back to raw columns, which is error-prone. If there is no catalog on the
 *   session, the tool fails fast and tells the planner to fall back to
 *   `execute_query_plan` with raw column names.
 *
 * KEY PIECES
 *   - executeMetricQueryArgsSchema — Zod schema validating the AI's request
 *     (metric name, optional breakdownBy / filters / sortBy / limit).
 *   - compiledPlanToQueryPlanBody — converts the compiler's output into the
 *     executor's input shape (deep-copies arrays, drops empty optionals).
 *   - registerExecuteMetricQueryTool — wires the tool into the registry.
 *
 * HOW IT CONNECTS
 *   Called by the agent's act loop via the tool registry (toolRegistry.ts).
 *   Reads the catalog from `ctx.exec.chatDocument.semanticModel`, compiles via
 *   `compileMetricQuery` (../../../semantic/compiler.js), then delegates to the
 *   `execute_query_plan` tool through `registry.execute`. The exported
 *   `compiledPlanToQueryPlanBody` is unit-tested directly.
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
