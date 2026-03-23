import { z } from "zod";
import { ToolRegistry, type ToolRunContext } from "../toolRegistry.js";
import { AGENT_WORKBENCH_ENTRY_CODE_MAX, isAgenticLoopEnabled } from "../types.js";
import { executeAnalyticalQuery } from "../../../analyticalQueryExecutor.js";
import type { ParsedQuery } from "../../../shared/queryTypes.js";
import { analyzeCorrelations } from "../../../correlationAnalyzer.js";
import { processChartData } from "../../../chartGenerator.js";
import { optimizeChartData } from "../../../chartDownsampling.js";
import { chartSpecSchema, type AgentWorkbenchEntry } from "../../../../shared/schema.js";

function appliedAggregationFromParsed(pq: ParsedQuery | null | undefined): boolean {
  return !!(
    pq?.groupBy?.length &&
    pq?.aggregations?.length
  );
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
    title: z.string().optional(),
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

      return {
        ok: true,
        summary: `${rs}\n${prev}`,
        numericPayload: formattedResults.slice(0, 4000),
        analyticalMeta,
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
      const colErr = assertColumns(ctx, [args.x, args.y]);
      if (colErr) return { ok: false, summary: colErr };
      const spec = chartSpecSchema.parse({
        type: args.type,
        title: args.title || `${args.y} by ${args.x}`,
        x: args.x,
        y: args.y,
      });
      let processed = processChartData(ctx.exec.data, spec);
      processed = optimizeChartData(processed, spec);
      const full = { ...spec, data: processed };
      return {
        ok: true,
        summary: `Chart ${spec.type}: ${spec.title} (x=${spec.x}, y=${spec.y}), ${processed.length} points.`,
        charts: [full],
        memorySlots: { chart_x: spec.x, chart_y: spec.y },
      };
    },
    {
      description: "Build a chart; x and y must be exact schema column names.",
      argsHelp:
        '{"type": "line"|"bar"|"scatter"|"pie"|"area", "x": string, "y": string, "title"?: string}',
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
