import { z } from "zod";
import { ToolRegistry, type ToolRunContext } from "../toolRegistry.js";
import { agentLog } from "../agentLogger.js";
import { AGENT_WORKBENCH_ENTRY_CODE_MAX, isAgenticLoopEnabled } from "../types.js";
import { executeAnalyticalQuery } from "../../../analyticalQueryExecutor.js";
import type { ParsedQuery } from "../../../shared/queryTypes.js";
import { analyzeCorrelations } from "../../../correlationAnalyzer.js";
import { processChartData } from "../../../chartGenerator.js";
import { compileChartSpec } from "../../../chartSpecCompiler.js";
import { chartSpecSchema, type AgentWorkbenchEntry } from "../../../../shared/schema.js";
import {
  executeQueryPlan,
  executeQueryPlanArgsSchema,
  normalizeAndValidateQueryPlanBody,
  questionImpliesSumAggregation,
  queryPlanToParsedQuery,
  remapQueryPlanGroupByToTemporalFacets,
  validateCoarseDateAggregationOutput,
} from "../../../queryPlanExecutor.js";
import {
  canExecuteQueryPlanOnDuckDb,
  executeQueryPlanOnDuckDb,
} from "../../../queryPlanDuckdbExecutor.js";
import { migrateLegacyTemporalFacetRowKeys } from "../../../temporalFacetColumns.js";
import { shouldRejectWideWithoutAgg } from "../../../questionAggregationPolicy.js";
import { findMatchingColumn } from "../../utils/columnMatcher.js";
import type { DataSummary } from "../../../../shared/schema.js";
import {
  deriveDimensionBucketArgsSchema,
  applyDeriveDimensionBucket,
} from "../../../deriveDimensionBucket.js";
import {
  executeReadonlySqlOnFrame,
  READONLY_SQL_MAX_LENGTH,
  sanitizeReadonlyDatasetSql,
} from "../../../agentReadonlySql.js";
import {
  addComputedColumnsArgsSchema,
  applyAddComputedColumns,
  replaceSummaryFromFresh,
} from "../../../computedColumns.js";
import { createDataSummary } from "../../../fileParser.js";
import { saveModifiedData } from "../../../dataOps/dataPersistence.js";
import queryCache from "../../../cache.js";
import {
  ColumnarStorageService,
  isDuckDBAvailable,
} from "../../../columnarStorage.js";
import { metadataService } from "../../../metadataService.js";

function appliedAggregationFromParsed(pq: ParsedQuery | null | undefined): boolean {
  return !!(pq?.aggregations?.length);
}

const emptyArgs = z.object({}).strict();
const sampleRowsArgs = z
  .object({
    limit: z.number().int().min(1).max(5000).optional(),
  })
  .strict();
const analyticalArgs = z
  .object({
    question_override: z.string().optional(),
  })
  .strict();
const correlationArgs = z
  .object({
    targetVariable: z.string(),
    filter: z.enum(["all", "positive", "negative"]).optional(),
  })
  .strict();
const chartArgs = z
  .object({
    type: z.enum(["line", "bar", "scatter", "pie", "area", "heatmap"]),
    x: z.string(),
    y: z.string(),
    z: z.string().optional(),
    seriesColumn: z.string().optional(),
    barLayout: z.enum(["stacked", "grouped"]).optional(),
    y2: z.string().optional(),
    title: z.string().optional(),
    aggregate: z.enum(["sum", "mean", "count", "none"]).optional(),
  })
  .strict();
const clarifyArgs = z
  .object({
    message: z.string(),
  })
  .strict();
const runDataOpsArgs = z
  .object({
    reason: z.string().optional(),
  })
  .strict();
const retrieveSemanticArgs = z
  .object({
    query: z.string().min(1).max(2000),
  })
  .strict();
const readonlySqlArgs = z
  .object({
    sql: z.string().min(1).max(READONLY_SQL_MAX_LENGTH),
  })
  .strict();

function allowlistedColumns(ctx: ToolRunContext): Set<string> {
  return new Set(ctx.exec.summary.columns.map((c) => c.name));
}

/** Schema headers plus keys on the current in-memory frame (e.g. aggregated query output). */
function allowedColumnNames(ctx: ToolRunContext): Set<string> {
  const allow = allowlistedColumns(ctx);
  const row0 = ctx.exec.data[0];
  if (row0 && typeof row0 === "object") {
    for (const k of Object.keys(row0)) {
      allow.add(k);
    }
  }
  return allow;
}

function assertColumns(ctx: ToolRunContext, names: string[]): string | null {
  const allow = allowedColumnNames(ctx);
  for (const n of names) {
    if (!allow.has(n)) {
      return `Column not in schema: ${n}`;
    }
  }
  return null;
}

/** When the frame looks aggregated, x/y must resolve to keys on the current rows (e.g. Sales_sum). */
function assertChartColumns(ctx: ToolRunContext, names: string[]): string | null {
  const row0 = ctx.exec.data[0];
  const keys =
    row0 && typeof row0 === "object" ? Object.keys(row0 as object) : [];
  const hasAggShape = keys.some((k) => /_(sum|mean|avg|count|min|max|median)$/i.test(k));

  for (const n of names) {
    if (hasAggShape) {
      const m = findMatchingColumn(n, keys);
      if (!m || !keys.includes(m)) {
        return `Column not on current result rows: ${n}. Use keys from the last query output (e.g. Sales_sum). Available: ${keys.slice(0, 40).join(", ")}${keys.length > 40 ? "…" : ""}`;
      }
      continue;
    }
    const err = assertColumns(ctx, [n]);
    if (err) return err;
  }
  return null;
}

function topDistinctStrings(
  data: Record<string, any>[],
  col: string,
  maxScan: number,
  maxReturn: number
): string[] {
  const slice = data.slice(0, Math.min(data.length, maxScan));
  const counts = new Map<string, number>();
  for (const row of slice) {
    const v = row[col];
    if (v === null || v === undefined || v === "") continue;
    const k = String(v);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxReturn)
    .map(([k]) => k);
}

function logAnalyticalToolMeta(
  tool: string,
  summary: DataSummary,
  parsed: ParsedQuery | null | undefined
) {
  const gb = parsed?.groupBy ?? [];
  const period = parsed?.dateAggregationPeriod ?? "";
  const ops = (parsed?.aggregations ?? []).map((a) => a.operation).join(",");
  const dateBucketSchemaApplied =
    gb.length > 0 && gb.every((c) => summary.dateColumns.includes(c));
  agentLog("tool_analytical_meta", {
    tool,
    groupBy: gb.join("|").slice(0, 240),
    dateAggregationPeriod: String(period),
    aggOps: ops.slice(0, 200),
    dateBucketSchemaApplied,
  });
}

export function registerDefaultTools(registry: ToolRegistry) {
  registry.register(
    "retrieve_semantic_context",
    retrieveSemanticArgs,
    async (ctx, args) => {
      const { isRagEnabled } = await import("../../../rag/config.js");
      if (!isRagEnabled()) {
        return {
          ok: false,
          summary: isAgenticLoopEnabled()
            ? "Semantic retrieval is not configured. Set RAG_ENABLED=true and AZURE_SEARCH_* (required when the agentic loop is enabled)."
            : "Semantic retrieval is not configured (set RAG_ENABLED and Azure AI Search env).",
        };
      }
      const { retrieveRagHits, formatHitsForPrompt } = await import("../../../rag/retrieve.js");
      const params = {
        sessionId: ctx.exec.sessionId,
        question: args.query,
        summary: ctx.exec.summary,
        dataVersion: ctx.exec.dataBlobVersion,
      };
      let { hits, suggestedColumns, retrievalError } = await retrieveRagHits(params);
      if (retrievalError) {
        const retry = await retrieveRagHits(params);
        hits = retry.hits;
        suggestedColumns = retry.suggestedColumns;
        retrievalError = retry.retrievalError;
      }
      if (retrievalError) {
        return {
          ok: false,
          summary:
            "Semantic retrieval is temporarily unavailable. Please try again in a moment.",
        };
      }
      const text = formatHitsForPrompt(hits);
      if (!text.trim()) {
        return {
          ok: true,
          summary: "No indexed passages matched this query.",
          suggestedColumns,
          ragHitCount: hits.length,
          memorySlots: suggestedColumns?.length
            ? { suggested_columns: suggestedColumns.slice(0, 20).join(",") }
            : undefined,
        };
      }
      return {
        ok: true,
        summary: text.slice(0, 6000),
        numericPayload: text,
        suggestedColumns,
        ragHitCount: hits.length,
        memorySlots: suggestedColumns?.length
          ? { suggested_columns: suggestedColumns.slice(0, 20).join(",") }
          : undefined,
      };
    },
    {
      description:
        "Vector search over indexed session chunks (themes, wording, narrative text).",
      argsHelp: '{"query": string} required — natural-language search text; not SQL.',
    }
  );

  registry.register(
    "get_schema_summary",
    emptyArgs,
    async (ctx) => {
      const s = ctx.exec.summary;
      const lines = [
        `rows=${s.rowCount}`,
        `columns=${s.columns.map((c) => `${c.name}(${c.type})`).join(", ")}`,
        `numeric=${s.numericColumns.join(", ")}`,
        `dates=${s.dateColumns.join(", ")}`,
      ];
      const dimHints = s.columns
        .filter((c) => c.type === "string" && c.topValues && c.topValues.length > 0)
        .map(
          (c) =>
            `${c.name}=[${c.topValues!.map((t) => String(t.value)).slice(0, 14).join("|")}]`
        );
      if (dimHints.length) {
        lines.push(`dimension_top_values=${dimHints.join("; ").slice(0, 4000)}`);
      }
      const colNames = s.columns.map((c) => c.name).join(",");
      return {
        ok: true,
        summary: lines.join("\n"),
        memorySlots: {
          column_names: colNames.slice(0, 800),
          numeric_columns: s.numericColumns.join(",").slice(0, 400),
        },
      };
    },
    {
      description: "Cheap overview: row count, column names and types.",
      argsHelp: "{} (no keys)",
    }
  );

  registry.register(
    "sample_rows",
    sampleRowsArgs,
    async (ctx, args) => {
      const limit = Math.min(
        args.limit ?? ctx.config.sampleRowsCap,
        ctx.config.sampleRowsCap
      );
      const rows = ctx.exec.data.slice(0, limit);
      return {
        ok: true,
        summary: `First ${rows.length} rows (JSON preview truncated).`,
        numericPayload: JSON.stringify(rows.slice(0, 3)),
      };
    },
    {
      description: "Preview first N in-memory rows.",
      argsHelp: '{"limit"?: number}',
    }
  );

  registry.register(
    "run_analytical_query",
    analyticalArgs,
    async (ctx, args) => {
      const q = (args.question_override as string | undefined) || ctx.exec.question;
      const res = await executeAnalyticalQuery(
        q,
        ctx.exec.data,
        ctx.exec.summary,
        ctx.exec.chatHistory
      );
      if (!res.isAnalytical) {
        return { ok: true, summary: "Question not classified as analytical; no query run." };
      }
      if (!res.queryResults) {
        return {
          ok: false,
          summary: "Analytical intent but query could not be executed (low parse confidence or error).",
        };
      }
      const { formattedResults, summary: rs, data: resultRows } = res.queryResults;
      const inputRowCount = ctx.exec.data.length;
      const outputRowCount = resultRows.length;
      const appliedAggregation = appliedAggregationFromParsed(res.parsedQuery);
      const analyticalMeta = {
        inputRowCount,
        outputRowCount,
        appliedAggregation,
      };

      if (outputRowCount === 0 && inputRowCount >= 10) {
        const pq = res.parsedQuery;
        const colsToSample = new Set<string>();
        pq?.dimensionFilters?.forEach((f) => colsToSample.add(f.column));
        pq?.groupBy?.forEach((c) => colsToSample.add(c));
        pq?.valueFilters?.forEach((f) => colsToSample.add(f.column));
        pq?.exclusionFilters?.forEach((f) => colsToSample.add(f.column));
        const diag: string[] = [
          `${rs}`,
          "Diagnostic: 0 result rows with non-empty input — filters may not match literals in the data, or a needed column is missing from the in-memory frame.",
        ];
        const row0 = ctx.exec.data[0];
        for (const col of colsToSample) {
          if (!row0 || !(col in row0)) {
            diag.push(`Column "${col}" is absent from loaded rows — replan with full schema columns or sample_rows.`);
            continue;
          }
          const tops = topDistinctStrings(ctx.exec.data, col, 8000, 18);
          if (tops.length) {
            diag.push(`Distinct sample for "${col}": ${tops.join(", ")}`);
          }
        }
        let workbenchArtifact: AgentWorkbenchEntry | undefined;
        if (pq) {
          const code = JSON.stringify(pq, null, 2);
          workbenchArtifact = {
            id: `pq-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
            kind: "query_spec",
            title: "Parsed analytical query",
            code: code.slice(0, AGENT_WORKBENCH_ENTRY_CODE_MAX),
            language: "json",
          };
        }
        return {
          ok: false,
          summary: diag.join("\n"),
          analyticalMeta,
          memorySlots: {
            zero_row_diagnostic: "1",
            analytical_snippet: diag.join(" ").slice(0, 320),
          },
          workbenchArtifact,
        };
      }

      if (
        shouldRejectWideWithoutAgg({
          question: q,
          inputRowCount,
          outputRowCount,
          appliedAggregation,
        })
      ) {
        return {
          ok: false,
          summary: `Analytical query returned ${outputRowCount} rows (nearly the full ${inputRowCount} rows) without aggregation. Replan: add an aggregation over the requested metric with an explicit breakdown (e.g. "by <dimension>") using exact column names from the schema.`,
          analyticalMeta,
          memorySlots: {
            analytical_snippet: "wide_result_no_aggregation",
          },
        };
      }

      if (
        questionImpliesSumAggregation(q) &&
        appliedAggregation &&
        res.parsedQuery?.aggregations?.length
      ) {
        const ops = res.parsedQuery.aggregations.map((a) => a.operation);
        const hasSum = ops.some((o) => o === "sum");
        const onlyMeans = ops.every((o) => o === "mean" || o === "avg");
        if (!hasSum && onlyMeans) {
          agentLog("tool_verifier_reject", {
            tool: "run_analytical_query",
            reason: "total_requires_sum_not_mean",
          });
          return {
            ok: false,
            summary: `The question asks for a total/sum but the parsed query only used mean/average. Replan with question_override that explicitly requests SUM (e.g. "sum of [numeric column] by [breakdown column]") using exact column names.`,
            analyticalMeta,
            memorySlots: { analytical_snippet: "total_requires_sum_not_mean" },
          };
        }
      }

      const prev =
        formattedResults.length > 2000
          ? formattedResults.slice(0, 2000) + "…"
          : formattedResults;

      let workbenchArtifact: AgentWorkbenchEntry | undefined;
      if (res.parsedQuery) {
        const code = JSON.stringify(res.parsedQuery, null, 2);
        workbenchArtifact = {
          id: `pq-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          kind: "query_spec",
          title: "Parsed analytical query",
          code: code.slice(0, AGENT_WORKBENCH_ENTRY_CODE_MAX),
          language: "json",
        };
      }

      const outCols =
        resultRows.length > 0 ? Object.keys(resultRows[0]) : [];

      logAnalyticalToolMeta("run_analytical_query", ctx.exec.summary, res.parsedQuery);

      return {
        ok: true,
        summary: `${rs}\n${prev}`,
        numericPayload: formattedResults.slice(0, 4000),
        analyticalMeta,
        queryPlanParsed: res.parsedQuery ?? null,
        table: {
          rows: resultRows,
          columns: outCols,
          rowCount: outputRowCount,
        },
        memorySlots: {
          analytical_snippet: formattedResults.replace(/\s+/g, " ").slice(0, 320),
        },
        workbenchArtifact,
      };
    },
    {
      description:
        "Run NL analytical query for aggregates, filters, totals (authoritative numbers).",
      argsHelp:
        '{"question_override"?: string} optional. Never use key "query" — that belongs only on retrieve_semantic_context.',
    }
  );

  registry.register(
    "execute_query_plan",
    executeQueryPlanArgsSchema as unknown as z.ZodType<Record<string, unknown>>,
    async (ctx, args) => {
      const plan = (args as z.infer<typeof executeQueryPlanArgsSchema>).plan;
      const dateCols = ctx.exec.summary.dateColumns ?? [];
      if (ctx.exec.data.length > 0 && dateCols.length > 0) {
        migrateLegacyTemporalFacetRowKeys(ctx.exec.data, dateCols);
      }
      const keys = new Set(Object.keys(ctx.exec.data[0] ?? {}));
      const effectivePlan = remapQueryPlanGroupByToTemporalFacets(
        plan,
        ctx.exec.summary,
        keys,
        ctx.exec.question
      );
      const validated = normalizeAndValidateQueryPlanBody(
        ctx.exec.summary,
        effectivePlan
      );
      if (!validated.ok) {
        return { ok: false, summary: validated.error };
      }
      const { normalizedPlan } = validated;

      let resultRows: Record<string, any>[] = [];
      let descriptions: string[] = [];
      let parsed = queryPlanToParsedQuery(normalizedPlan);
      let inputRowCount = ctx.exec.data.length;

      const tryDuck =
        Boolean(ctx.exec.columnarStoragePath) &&
        Boolean(ctx.exec.sessionId) &&
        canExecuteQueryPlanOnDuckDb(normalizedPlan);

      if (tryDuck) {
        const duck = await executeQueryPlanOnDuckDb(
          ctx.exec.sessionId,
          normalizedPlan,
          ctx.exec.summary,
          ctx.exec.chatDocument
        );
        if (duck.ok) {
          resultRows = duck.rows as Record<string, any>[];
          descriptions = duck.descriptions;
          inputRowCount = duck.inputRowCount;
        } else {
          agentLog("execute_query_plan_duckdb_fallback", {
            sessionId: ctx.exec.sessionId,
            error: duck.error.slice(0, 400),
          });
          const mem = executeQueryPlan(
            ctx.exec.data,
            ctx.exec.summary,
            normalizedPlan
          );
          if (!mem.ok) {
            return { ok: false, summary: mem.error };
          }
          resultRows = mem.data;
          descriptions = mem.descriptions;
          parsed = mem.parsed;
          inputRowCount = ctx.exec.data.length;
        }
      } else {
        const mem = executeQueryPlan(
          ctx.exec.data,
          ctx.exec.summary,
          normalizedPlan
        );
        if (!mem.ok) {
          return { ok: false, summary: mem.error };
        }
        resultRows = mem.data;
        descriptions = mem.descriptions;
        parsed = mem.parsed;
        inputRowCount = ctx.exec.data.length;
      }
      const outputRowCount = resultRows.length;
      const appliedAggregation = appliedAggregationFromParsed(parsed);
      const analyticalMeta = {
        inputRowCount,
        outputRowCount,
        appliedAggregation,
      };

      if (
        shouldRejectWideWithoutAgg({
          question: ctx.exec.question,
          inputRowCount,
          outputRowCount,
          appliedAggregation,
        })
      ) {
        return {
          ok: false,
          summary: `execute_query_plan returned ${outputRowCount} rows (nearly full ${inputRowCount}) without aggregation. Replan: add groupBy + aggregations with an explicit breakdown (e.g. "by <dimension>") using exact column names from the schema.`,
          analyticalMeta,
          memorySlots: { analytical_snippet: "query_plan_wide_no_agg" },
        };
      }

      if (
        questionImpliesSumAggregation(ctx.exec.question) &&
        appliedAggregation &&
        parsed.aggregations?.length
      ) {
        const ops = parsed.aggregations.map((a) => a.operation);
        const hasSum = ops.some((o) => o === "sum");
        const onlyMeans = ops.every((o) => o === "mean" || o === "avg");
        if (!hasSum && onlyMeans) {
          agentLog("tool_verifier_reject", {
            tool: "execute_query_plan",
            reason: "plan_total_requires_sum",
          });
          return {
            ok: false,
            summary:
              "Question implies total/sum but plan only uses mean/average. Replan execute_query_plan with operation sum for the revenue/metric column.",
            analyticalMeta,
            memorySlots: { analytical_snippet: "plan_total_requires_sum" },
          };
        }
      }

      const coarseValidation = validateCoarseDateAggregationOutput(
        parsed,
        inputRowCount,
        outputRowCount
      );
      if (coarseValidation) {
        agentLog("tool_verifier_reject", {
          tool: "execute_query_plan",
          reason: "coarse_period_too_many_groups",
          outputRowCount,
        });
        return {
          ok: false,
          summary: coarseValidation,
          analyticalMeta,
          queryPlanParsed: parsed,
          memorySlots: { analytical_snippet: "coarse_period_row_count_mismatch" },
        };
      }

      const cols =
        resultRows.length > 0 ? Object.keys(resultRows[0]) : [];
      const formattedResults = JSON.stringify(resultRows.slice(0, 200), null, 2);
      const rs = descriptions.length
        ? descriptions.join("; ")
        : "Query plan executed.";
      const workbenchArtifact: AgentWorkbenchEntry = {
        id: `qp-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        kind: "query_spec",
        title: "execute_query_plan",
        code: JSON.stringify(plan, null, 2).slice(0, AGENT_WORKBENCH_ENTRY_CODE_MAX),
        language: "json",
      };

      logAnalyticalToolMeta("execute_query_plan", ctx.exec.summary, parsed);

      return {
        ok: true,
        summary: `${rs}\nRows: ${outputRowCount}. Columns: ${cols.join(", ")}\nSample:\n${formattedResults.length > 3500 ? formattedResults.slice(0, 3500) + "…" : formattedResults}`,
        numericPayload: formattedResults.slice(0, 4000),
        analyticalMeta,
        queryPlanParsed: parsed,
        table: { rows: resultRows, columns: cols, rowCount: outputRowCount },
        memorySlots: {
          analytical_snippet: formattedResults.replace(/\s+/g, " ").slice(0, 320),
        },
        workbenchArtifact,
      };
    },
    {
      description:
        "Structured query plan: time series (trend) OR dimension breakdowns. For explicit time grain questions (year/month/quarter/etc.), groupBy the matching derived time-bucket column (same label as in schema, e.g. Month · Order Date). When groupBy is already such a bucket column, OMIT dateAggregationPeriod (pre-bucketed). Legacy __tf_month__* ids are normalized automatically. Use dateAggregationPeriod only when groupBy is a raw date column that needs calendar truncation. For vague 'over time' without an explicit grain, you can omit groupBy/aggregations and instead sort by a date column (and use limit) to return an ordered time series without forcing yearly sums. For breakdowns: groupBy dimension(s) + aggregations. Exact schema column names required.",
      argsHelp:
        'Facet time-series: {"plan":{"groupBy":["Month · Order Date"],"aggregations":[{"column":"Sales","operation":"sum"}],"sort":[{"column":"Month · Order Date","direction":"asc"}]}}. Raw date: {"plan":{"groupBy":["Order Date"],"dateAggregationPeriod":"month","aggregations":[{"column":"Sales","operation":"sum"}]}}. Full shape: {"plan": {"groupBy"?: string[], "dateAggregationPeriod"?: "day"|"week"|"half_year"|"month"|"monthOnly"|"quarter"|"year"|null, "aggregations"?: [{"column": string, "operation": "sum"|"mean"|"avg"|"count"|"min"|"max"|"median"|"percent_change", "alias"?: string}], "dimensionFilters"?: [...], "limit"?: number, "sort"?: [...]}}',
    }
  );

  registry.register(
    "derive_dimension_bucket",
    deriveDimensionBucketArgsSchema as unknown as z.ZodType<Record<string, unknown>>,
    async (ctx, args) => {
      if (ctx.exec.mode !== "analysis") {
        return {
          ok: false,
          summary: "derive_dimension_bucket is only available in analysis mode.",
        };
      }
      const parsed = deriveDimensionBucketArgsSchema.safeParse(args);
      if (!parsed.success) {
        return {
          ok: false,
          summary: `Invalid args for derive_dimension_bucket: ${parsed.error.message}`,
        };
      }
      const allow = allowlistedColumns(ctx);
      if (!allow.has(parsed.data.sourceColumn)) {
        return {
          ok: false,
          summary: `Column not in schema: ${parsed.data.sourceColumn}`,
        };
      }
      const out = applyDeriveDimensionBucket(ctx.exec.data, ctx.exec.summary, parsed.data);
      if (!out.ok) {
        return { ok: false, summary: out.error };
      }
      const cols = out.rows.length > 0 ? Object.keys(out.rows[0]!) : [];
      const sample = JSON.stringify(out.rows.slice(0, 15), null, 2);
      return {
        ok: true,
        summary: `derive_dimension_bucket: added "${parsed.data.newColumnName}" from "${parsed.data.sourceColumn}". Rows: ${out.rows.length}. Columns: ${cols.join(", ")}\nSample:\n${sample.slice(0, 3500)}`,
        table: {
          rows: out.rows,
          columns: cols,
          rowCount: out.rows.length,
        },
        memorySlots: {
          derived_column: parsed.data.newColumnName,
        },
      };
    },
    {
      description:
        "Add a string bucket column by mapping source dimension values into labels (custom groups). Use before execute_query_plan when the user merges categories/regions. Chain with dependsOn if needed.",
      argsHelp:
        '{"sourceColumn": string, "newColumnName": string, "buckets": [{"label": string, "values": string[]}], "matchMode"?: "exact"|"case_insensitive", "defaultLabel"?: string}',
    }
  );

  registry.register(
    "add_computed_columns",
    addComputedColumnsArgsSchema as unknown as z.ZodType<Record<string, unknown>>,
    async (ctx, args) => {
      if (ctx.exec.mode !== "analysis") {
        return {
          ok: false,
          summary: "add_computed_columns is only available in analysis mode.",
        };
      }
      const parsed = addComputedColumnsArgsSchema.safeParse(args);
      if (!parsed.success) {
        return {
          ok: false,
          summary: `Invalid args for add_computed_columns: ${parsed.error.message}`,
        };
      }

      const useColumnarDuckdb =
        Boolean(ctx.exec.columnarStoragePath) && isDuckDBAvailable();

      let rows: Record<string, any>[];
      if (useColumnarDuckdb) {
        let base: Record<string, any>[];
        try {
          base = ctx.exec.loadFullData
            ? await ctx.exec.loadFullData()
            : ctx.exec.data;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            ok: false,
            summary: `add_computed_columns: loadFullData failed (${msg.slice(0, 300)}).`,
          };
        }
        if (!base?.length) {
          return {
            ok: false,
            summary: "add_computed_columns: no rows loaded for columnar session.",
          };
        }
        const fullOut = applyAddComputedColumns(
          base,
          ctx.exec.summary,
          parsed.data
        );
        if (!fullOut.ok) {
          return { ok: false, summary: fullOut.error };
        }
        rows = fullOut.rows;
      } else {
        const out = applyAddComputedColumns(
          ctx.exec.data,
          ctx.exec.summary,
          parsed.data
        );
        if (!out.ok) {
          return { ok: false, summary: out.error };
        }
        rows = out.rows;
      }

      let persistNote = "";
      let duckdbNote = "";
      if (parsed.data.persistToSession) {
        try {
          await saveModifiedData(
            ctx.exec.sessionId,
            rows,
            "add_computed_columns",
            (parsed.data.persistDescription?.trim() ||
              "Computed columns added from analysis agent") as string
          );
          queryCache.invalidateSession(ctx.exec.sessionId);
          const fresh = createDataSummary(rows);
          replaceSummaryFromFresh(ctx.exec.summary, fresh);
          persistNote = " Persisted to session dataset (new blob version).";
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            ok: false,
            summary: `Computed columns were built but persist failed: ${msg.slice(0, 400)}`,
          };
        }
      }

      if (useColumnarDuckdb) {
        const storage = new ColumnarStorageService({
          sessionId: ctx.exec.sessionId,
        });
        try {
          await storage.initialize();
          await storage.materializeAuthoritativeDataTable(rows, {
            tableName: "data",
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            ok: false,
            summary: `Computed columns built but DuckDB rematerialize failed: ${msg.slice(0, 400)}`,
          };
        } finally {
          await storage.close().catch(() => {
            /* ignore */
          });
        }
        metadataService.invalidateCache(ctx.exec.sessionId);
        queryCache.invalidateSession(ctx.exec.sessionId);
        ctx.exec.data = rows;
        duckdbNote = " Session DuckDB table `data` updated for pivot/sample queries.";
      }
      const cols = rows.length > 0 ? Object.keys(rows[0]!) : [];
      const sample = JSON.stringify(rows.slice(0, 15), null, 2);
      const names = parsed.data.columns.map((c) => c.name).join(", ");
      return {
        ok: true,
        summary: `add_computed_columns: added ${names}. Rows: ${rows.length}. Columns: ${cols.join(", ")}${persistNote}${duckdbNote}\nSample:\n${sample.slice(0, 3500)}`,
        table: {
          rows,
          columns: cols,
          rowCount: rows.length,
        },
        memorySlots: {
          computed_columns: names.slice(0, 200),
          ...(parsed.data.persistToSession ? { persisted: "1" } : {}),
        },
      };
    },
    {
      description:
        "Add row-wise numeric columns from safe definitions (date difference in whole days between two date columns; or numeric add/subtract/multiply/divide). Use before execute_query_plan when you need a derived metric. Same row count as input. Optional persistToSession saves the enriched frame as the session dataset (use only when the user asked to keep/save the new column).",
      argsHelp:
        '{"columns": [{"name": string, "def": {"type":"date_diff_days","startColumn": string, "endColumn": string, "clampNegative"?: boolean} | {"type":"numeric_binary","op":"add"|"subtract"|"multiply"|"divide","leftColumn": string, "rightColumn": string}}], "persistToSession"?: boolean, "persistDescription"?: string}',
    }
  );

  registry.register(
    "run_readonly_sql",
    readonlySqlArgs,
    async (ctx, args) => {
      if (ctx.exec.mode !== "analysis") {
        return {
          ok: false,
          summary: "run_readonly_sql is only available in analysis mode.",
        };
      }
      const sql = (args as z.infer<typeof readonlySqlArgs>).sql;
      const pre = sanitizeReadonlyDatasetSql(sql);
      if (!pre.ok) {
        return { ok: false, summary: pre.error };
      }
      const exec = await executeReadonlySqlOnFrame(ctx.exec.data, sql);
      if (!exec.ok) {
        return { ok: false, summary: exec.error };
      }
      const formatted = JSON.stringify(exec.rows.slice(0, 100), null, 2);
      return {
        ok: true,
        summary: `run_readonly_sql: ${exec.rows.length} rows, columns: ${exec.columns.join(", ")}. Sample:\n${formatted.slice(0, 4000)}`,
        table: {
          rows: exec.rows,
          columns: exec.columns,
          rowCount: exec.rows.length,
        },
        memorySlots: { readonly_sql: "1" },
      };
    },
    {
      description:
        "Advanced: single SELECT only against ephemeral table \"dataset\" (current frame, row-capped). No DDL/DML. Prefer execute_query_plan when possible.",
      argsHelp: '{"sql": string} — e.g. SELECT bucket, SUM(CAST("Sales" AS DOUBLE)) FROM dataset GROUP BY 1',
    }
  );

  registry.register(
    "run_correlation",
    correlationArgs,
    async (ctx, args) => {
      const err = assertColumns(ctx, [args.targetVariable]);
      if (err) return { ok: false, summary: err };
      const numeric = ctx.exec.summary.numericColumns;
      if (!numeric.includes(args.targetVariable)) {
        return {
          ok: false,
          summary: `Target ${args.targetVariable} is not a numeric column.`,
        };
      }
      const { charts, insights } = await analyzeCorrelations(
        ctx.exec.data,
        args.targetVariable,
        numeric,
        args.filter ?? "all",
        undefined,
        ctx.exec.chatInsights,
        25,
        undefined,
        ctx.exec.sessionId,
        true
      );
      return {
        ok: true,
        summary: `Correlation analysis: ${charts.length} chart(s), ${insights.length} insight(s).`,
        charts,
        insights,
      };
    },
    {
      description: "Correlation / drivers for a numeric target column.",
      argsHelp: '{"targetVariable": string, "filter"?: "all"|"positive"|"negative"}',
    }
  );

  registry.register(
    "build_chart",
    chartArgs,
    async (ctx, args) => {
      const names = [
        args.x,
        args.y,
        ...(args.y2 ? [args.y2] : []),
        ...(args.type === "heatmap" && args.z ? [args.z] : []),
        ...(args.seriesColumn ? [args.seriesColumn] : []),
      ];
      const colErr = assertChartColumns(ctx, names);
      if (colErr) return { ok: false, summary: colErr };
      const explicitAgg =
        args.aggregate !== undefined && args.aggregate !== null;
      const compileProposal = {
        type: args.type,
        x: args.x,
        y: args.y,
        ...(args.type === "heatmap" && args.z ? { z: args.z } : {}),
        seriesColumn: args.seriesColumn,
        barLayout: args.barLayout,
        ...(args.aggregate !== undefined && args.aggregate !== null
          ? { aggregate: args.aggregate }
          : {}),
        ...(args.y2 ? { y2: args.y2 } : {}),
      };
      const { merged: compiled } = compileChartSpec(
        ctx.exec.data as Record<string, unknown>[],
        {
          numericColumns: ctx.exec.summary?.numericColumns ?? [],
          dateColumns: ctx.exec.summary?.dateColumns,
        },
        compileProposal,
        {
          preserveAggregate: explicitAgg,
          columnOrder: Array.isArray(ctx.exec.lastAnalyticalTable?.columns)
            ? (ctx.exec.lastAnalyticalTable!.columns as string[])
            : null,
        }
      );
      const postNames = [
        compiled.x,
        compiled.y,
        ...(compiled.type === "heatmap" && compiled.z ? [compiled.z] : []),
        ...(compiled.seriesColumn ? [compiled.seriesColumn] : []),
        ...(args.y2 ? [args.y2] : []),
      ];
      const colErr2 = assertChartColumns(ctx, postNames);
      if (colErr2) return { ok: false, summary: colErr2 };

      const defaultAgg =
        explicitAgg
          ? (args.aggregate as "sum" | "mean" | "count" | "none")
          : compiled.seriesColumn &&
              (compiled.type === "bar" ||
                compiled.type === "line" ||
                compiled.type === "area")
            ? compiled.aggregate ?? "sum"
            : compiled.aggregate ??
              (compiled.type === "heatmap"
                ? "sum"
                : "none");
      const spec = chartSpecSchema.parse({
        type: compiled.type,
        title: args.title || `${compiled.y} by ${compiled.x}`,
        x: compiled.x,
        y: compiled.y,
        ...(compiled.type === "heatmap" && compiled.z ? { z: compiled.z } : {}),
        ...(compiled.seriesColumn ? { seriesColumn: compiled.seriesColumn } : {}),
        ...(compiled.seriesColumn && compiled.barLayout
          ? { barLayout: compiled.barLayout }
          : {}),
        ...(args.y2 ? { y2: args.y2 } : {}),
        aggregate: defaultAgg,
      });
      let processed = processChartData(
        ctx.exec.data,
        spec,
        ctx.exec.summary?.dateColumns,
        { chartQuestion: ctx.exec.question }
      );
      const useAnalyticalOnly =
        Boolean(ctx.exec.lastAnalyticalTable?.rows?.length) &&
        ctx.exec.data === ctx.exec.lastAnalyticalTable!.rows;
      const full = {
        ...spec,
        data: processed,
        ...(useAnalyticalOnly ? { _useAnalyticalDataOnly: true as const } : {}),
      };
      const layerNote = spec.seriesColumn
        ? `, series=${spec.seriesColumn}${spec.barLayout ? ` (${spec.barLayout})` : ""}`
        : "";
      const zNote = spec.type === "heatmap" && spec.z ? `, z=${spec.z}` : "";
      return {
        ok: true,
        summary: `Chart ${spec.type}: ${spec.title} (x=${spec.x}, y=${spec.y}${args.y2 ? `, y2=${args.y2}` : ""}${zNote}${layerNote}, aggregate=${spec.aggregate ?? defaultAgg}), ${processed.length} points.`,
        charts: [full],
        memorySlots: { chart_x: spec.x, chart_y: spec.y },
      };
    },
    {
      description:
        "Build a chart from in-memory rows (often after run_analytical_query or execute_query_plan). After sum/mean aggregations, y must match the result column (e.g. Sales_sum), not the raw schema name Sales. x is the groupBy date column (bucket labels). Use aggregate none when one row per x already. For breakdowns (e.g. sales by month AND region), use bar or line/area with seriesColumn = the second dimension column (long-format rows: one row per x×series with y numeric); default aggregate sum then applies per series cell. For two numeric metrics over the same x (e.g. Revenue and Profit over time), use y2 instead of seriesColumn. Heatmap: type heatmap, x=row dim, y=col dim, z=numeric measure.",
      argsHelp:
        '{"type": "line"|"bar"|"scatter"|"pie"|"area"|"heatmap", "x": string, "y": string, "z"?: string (heatmap cell value), "seriesColumn"?: string (second category for stacked/grouped bar or multi-series line/area), "barLayout"?: "stacked"|"grouped", "y2"?: string (second numeric series, dual-axis line), "title"?: string, "aggregate"?: "sum"|"mean"|"count"|"none"} — after execute_query_plan, y must match result column names (e.g. Sales_sum). With seriesColumn, omit aggregate or use sum/mean to roll up raw rows per x×series.',
    }
  );

  registry.register(
    "clarify_user",
    clarifyArgs,
    async (_ctx, args) => {
      return {
        ok: true,
        summary: "Clarification requested.",
        clarify: args.message,
      };
    },
    {
      description: "Ask the user a clarifying question.",
      argsHelp: '{"message": string}',
    }
  );

  registry.register(
    "run_data_ops",
    runDataOpsArgs,
    async (ctx) => {
      if (ctx.exec.mode !== "dataOps") {
        return {
          ok: false,
          summary: "run_data_ops only available in dataOps mode.",
        };
      }
      const { runDataOpsFromAgentContext } = await import("../../runDataOpsFromAgent.js");
      const out = await runDataOpsFromAgentContext(ctx.exec);
      return {
        ok: true,
        summary: out.answer?.slice(0, 1500) || "",
        answerFragment: out.answer,
        charts: out.charts,
        insights: out.insights,
        table: out.table,
        operationResult: out.operationResult,
        numericPayload: out.answer?.slice(0, 2000),
      };
    },
    {
      description:
        "Perform a data transformation (mutations) via the data-ops pipeline — not the legacy orchestrator.",
      argsHelp: '{"reason"?: string} optional note only.',
    }
  );
}
