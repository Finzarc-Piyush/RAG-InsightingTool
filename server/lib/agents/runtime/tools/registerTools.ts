import { z } from "zod";
import { ToolRegistry, type ToolRunContext } from "../toolRegistry.js";
import type { AgentExecutionContext } from "../types.js";

function buildPermanentContextForDelegate(exec: AgentExecutionContext): string | undefined {
  const parts: string[] = [];
  if (exec.permanentContext?.trim()) parts.push(exec.permanentContext.trim());
  if (exec.sessionAnalysisContext) {
    parts.push(
      `SessionAnalysisContextJSON:\n${JSON.stringify(exec.sessionAnalysisContext).slice(0, 8000)}`
    );
  }
  return parts.length ? parts.join("\n\n---\n\n") : undefined;
}
import { executeAnalyticalQuery } from "../../../analyticalQueryExecutor.js";
import { analyzeCorrelations } from "../../../correlationAnalyzer.js";
import { processChartData } from "../../../chartGenerator.js";
import { optimizeChartData } from "../../../chartDownsampling.js";
import { chartSpecSchema } from "../../../../shared/schema.js";

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
const delegateArgs = z
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

export function registerDefaultTools(registry: ToolRegistry) {
  registry.register("retrieve_semantic_context", retrieveSemanticArgs, async (ctx, args) => {
    const { isRagEnabled } = await import("../../../rag/config.js");
    if (!isRagEnabled()) {
      return {
        ok: false,
        summary: "Semantic retrieval is not configured (set RAG_ENABLED and Azure AI Search env).",
      };
    }
    const { retrieveRagHits, formatHitsForPrompt } = await import("../../../rag/retrieve.js");
    const { hits, suggestedColumns } = await retrieveRagHits({
      sessionId: ctx.exec.sessionId,
      question: args.query,
      summary: ctx.exec.summary,
      dataVersion: ctx.exec.dataBlobVersion,
    });
    const text = formatHitsForPrompt(hits);
    if (!text.trim()) {
      return {
        ok: true,
        summary: "No indexed passages matched this query.",
        suggestedColumns,
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
      memorySlots: suggestedColumns?.length
        ? { suggested_columns: suggestedColumns.slice(0, 20).join(",") }
        : undefined,
    };
  });

  registry.register("get_schema_summary", emptyArgs, async (ctx) => {
    const s = ctx.exec.summary;
    const lines = [
      `rows=${s.rowCount}`,
      `columns=${s.columns.map((c) => `${c.name}(${c.type})`).join(", ")}`,
      `numeric=${s.numericColumns.join(", ")}`,
      `dates=${s.dateColumns.join(", ")}`,
    ];
    const colNames = s.columns.map((c) => c.name).join(",");
    return {
      ok: true,
      summary: lines.join("\n"),
      memorySlots: {
        column_names: colNames.slice(0, 800),
        numeric_columns: s.numericColumns.join(",").slice(0, 400),
      },
    };
  });

  registry.register("sample_rows", sampleRowsArgs, async (ctx, args) => {
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
  });

  registry.register("run_analytical_query", analyticalArgs, async (ctx, args) => {
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
    const { formattedResults, summary: rs } = res.queryResults;
    const prev =
      formattedResults.length > 2000
        ? formattedResults.slice(0, 2000) + "…"
        : formattedResults;
    return {
      ok: true,
      summary: `${rs}\n${prev}`,
      numericPayload: formattedResults.slice(0, 4000),
      memorySlots: {
        analytical_snippet: formattedResults.replace(/\s+/g, " ").slice(0, 320),
      },
    };
  });

  registry.register("run_correlation", correlationArgs, async (ctx, args) => {
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
  });

  registry.register("build_chart", chartArgs, async (ctx, args) => {
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
  });

  registry.register("clarify_user", clarifyArgs, async (_ctx, args) => {
    return {
      ok: true,
      summary: "Clarification requested.",
      clarify: args.message,
    };
  });

  registry.register("delegate_general_analysis", delegateArgs, async (ctx) => {
    const { getInitializedOrchestrator } = await import("../../index.js");
    const orch = getInitializedOrchestrator();
    const out = await orch.processQuery(
      ctx.exec.question,
      ctx.exec.chatHistory,
      ctx.exec.data,
      ctx.exec.summary,
      ctx.exec.sessionId,
      ctx.exec.chatInsights,
      undefined,
      ctx.exec.mode === "dataOps" ? "analysis" : ctx.exec.mode,
      buildPermanentContextForDelegate(ctx.exec)
    );
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
  });

  registry.register("delegate_data_ops", delegateArgs, async (ctx) => {
    if (ctx.exec.mode !== "dataOps") {
      return {
        ok: false,
        summary: "delegate_data_ops only available in dataOps mode.",
      };
    }
    const { getInitializedOrchestrator } = await import("../../index.js");
    const orch = getInitializedOrchestrator();
    const out = await orch.processQuery(
      ctx.exec.question,
      ctx.exec.chatHistory,
      ctx.exec.data,
      ctx.exec.summary,
      ctx.exec.sessionId,
      ctx.exec.chatInsights,
      undefined,
      "dataOps",
      buildPermanentContextForDelegate(ctx.exec)
    );
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
  });
}
