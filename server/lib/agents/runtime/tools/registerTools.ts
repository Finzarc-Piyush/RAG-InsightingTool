import { z } from "zod";
import { ToolRegistry, type ToolRunContext } from "../toolRegistry.js";
import { agentLog } from "../agentLogger.js";
import { AGENT_WORKBENCH_ENTRY_CODE_MAX, isAgenticLoopEnabled } from "../types.js";
import { executeAnalyticalQuery } from "../../../analyticalQueryExecutor.js";
import type { ParsedQuery } from "../../../shared/queryTypes.js";
import { analyzeCorrelations } from "../../../correlationAnalyzer.js";
import { processChartData } from "../../../chartGenerator.js";
import { optimizeChartData } from "../../../chartDownsampling.js";
import { chartSpecSchema, type AgentWorkbenchEntry } from "../../../../shared/schema.js";
import {
  executeQueryPlan,
  executeQueryPlanArgsSchema,
  questionImpliesSumAggregation,
} from "../../../queryPlanExecutor.js";
import type { DataSummary } from "../../../../shared/schema.js";

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
    type: z.enum(["line", "bar", "scatter", "pie", "area"]),
    x: z.string(),
    y: z.string(),
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

function allowlistedColumns(ctx: ToolRunContext): Set<string> {
  return new Set(ctx.exec.summary.columns.map((c) => c.name));
}

function assertColumns(ctx: ToolRunContext, names: string[]): string | null {
  const allow = allowlistedColumns(ctx);
  for (const n of names) {
    if (!allow.has(n)) {
      return `Column not in schema: ${n}`;
    }
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

      const wideWithoutAgg =
        !appliedAggregation &&
        ((inputRowCount >= 50 && outputRowCount === inputRowCount) ||
          (inputRowCount >= 500 &&
            outputRowCount / inputRowCount >= 0.97));

      if (wideWithoutAgg) {
        return {
          ok: false,
          summary: `Analytical query returned ${outputRowCount} rows (nearly the full ${inputRowCount} rows) without aggregation. Replan: use run_analytical_query with a question_override that asks for the correct metric summarized by the right dimension (e.g. sum of sales by category), using exact column names from the schema.`,
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
      const exec = executeQueryPlan(ctx.exec.data, ctx.exec.summary, plan);
      if (!exec.ok) {
        return { ok: false, summary: exec.error };
      }
      const { data: resultRows, descriptions, parsed } = exec;
      const inputRowCount = ctx.exec.data.length;
      const outputRowCount = resultRows.length;
      const appliedAggregation = appliedAggregationFromParsed(parsed);
      const analyticalMeta = {
        inputRowCount,
        outputRowCount,
        appliedAggregation,
      };

      const wideWithoutAgg =
        !appliedAggregation &&
        ((inputRowCount >= 50 && outputRowCount === inputRowCount) ||
          (inputRowCount >= 500 &&
            outputRowCount / inputRowCount >= 0.97));

      if (wideWithoutAgg) {
        return {
          ok: false,
          summary: `execute_query_plan returned ${outputRowCount} rows (nearly full ${inputRowCount}) without aggregation. Replan: add groupBy + aggregations (e.g. sum of sales by year).`,
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
        table: { rows: resultRows, columns: cols, rowCount: outputRowCount },
        memorySlots: {
          analytical_snippet: formattedResults.replace(/\s+/g, " ").slice(0, 320),
        },
        workbenchArtifact,
      };
    },
    {
      description:
        "Run a structured query plan (groupBy, aggregations, optional dimensionFilters/limit/sort). Prefer for precise SUM/COUNT/AVG by dimension when NL parsing is ambiguous. Args.plan uses exact schema column names.",
      argsHelp:
        '{"plan": {"groupBy"?: string[], "aggregations"?: [{"column": string, "operation": "sum"|"mean"|"avg"|"count"|"min"|"max"|"median"|"percent_change", "alias"?: string}], "dateAggregationPeriod"?: "day"|"month"|"monthOnly"|"quarter"|"year"|null, "dimensionFilters"?: [...], "limit"?: number, "sort"?: [...]}}',
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
      const names = [args.x, args.y, ...(args.y2 ? [args.y2] : [])];
      const colErr = assertColumns(ctx, names);
      if (colErr) return { ok: false, summary: colErr };
      const spec = chartSpecSchema.parse({
        type: args.type,
        title: args.title || `${args.y} by ${args.x}`,
        x: args.x,
        y: args.y,
        ...(args.y2 ? { y2: args.y2 } : {}),
        aggregate: args.aggregate ?? "none",
      });
      let processed = processChartData(
        ctx.exec.data,
        spec,
        ctx.exec.summary?.dateColumns
      );
      processed = optimizeChartData(processed, spec);
      const full = { ...spec, data: processed };
      return {
        ok: true,
        summary: `Chart ${spec.type}: ${spec.title} (x=${spec.x}, y=${spec.y}${args.y2 ? `, y2=${args.y2}` : ""}, aggregate=${spec.aggregate ?? "none"}), ${processed.length} points.`,
        charts: [full],
        memorySlots: { chart_x: spec.x, chart_y: spec.y },
      };
    },
    {
      description:
        "Build a chart from in-memory rows (often after run_analytical_query or execute_query_plan). x and y are exact schema column names. Set aggregate sum|mean|count when plotting grouped metrics.",
      argsHelp:
        '{"type": "line"|"bar"|"scatter"|"pie"|"area", "x": string, "y": string, "y2"?: string, "title"?: string, "aggregate"?: "sum"|"mean"|"count"|"none"}',
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
