import type { ChatDocument } from "../../../models/chat.model.js";
import type {
  DataSummary,
  Insight,
  Message,
  SessionAnalysisContext,
} from "../../../shared/schema.js";
import type { AgentExecutionContext, AnalysisSpecForAgent, StreamPreAnalysis } from "./types.js";
import { detectPeriodFromQuery } from "../../dateUtils.js";
import { temporalFacetMetadataForDateColumns } from "../../temporalFacetColumns.js";

type MidTurnPersist = AgentExecutionContext["onMidTurnSessionContext"];

export function buildAgentExecutionContext(params: {
  sessionId: string;
  username?: string;
  question: string;
  data: Record<string, any>[];
  summary: DataSummary;
  chatHistory: Message[];
  chatInsights?: Insight[];
  mode: "analysis" | "dataOps" | "modeling";
  permanentContext?: string;
  sessionAnalysisContext?: SessionAnalysisContext;
  columnarStoragePath?: boolean;
  chatDocument?: ChatDocument;
  dataBlobVersion?: number;
  loadFullData?: () => Promise<Record<string, any>[]>;
  streamPreAnalysis?: StreamPreAnalysis;
  analysisSpec?: AnalysisSpecForAgent | null;
  onMidTurnSessionContext?: MidTurnPersist;
  onIntermediateArtifact?: AgentExecutionContext["onIntermediateArtifact"];
}): AgentExecutionContext {
  return {
    sessionId: params.sessionId,
    username: params.username,
    question: params.question,
    data: params.data,
    turnStartDataRef: params.data?.length ? params.data : null,
    analysisSpec: params.analysisSpec ?? null,
    summary: params.summary,
    chatHistory: params.chatHistory,
    chatInsights: params.chatInsights,
    mode: params.mode,
    permanentContext: params.permanentContext,
    sessionAnalysisContext: params.sessionAnalysisContext,
    columnarStoragePath: params.columnarStoragePath,
    chatDocument: params.chatDocument,
    dataBlobVersion: params.dataBlobVersion,
    loadFullData: params.loadFullData,
    streamPreAnalysis: params.streamPreAnalysis,
    onMidTurnSessionContext: params.onMidTurnSessionContext,
    onIntermediateArtifact: params.onIntermediateArtifact,
  };
}

/** Shared user notes + session JSON blocks (used by planner summary and reflector). */
export function formatUserAndSessionJsonBlocks(
  ctx: AgentExecutionContext,
  opts: { maxUserChars: number; maxJsonChars: number }
): string {
  let s = "";
  if (ctx.permanentContext?.trim().length) {
    s += `\nUser-provided notes (verbatim):\n${ctx.permanentContext.trim().slice(0, opts.maxUserChars)}`;
  }
  if (ctx.sessionAnalysisContext) {
    s += `\nSessionAnalysisContextJSON:\n${JSON.stringify(ctx.sessionAnalysisContext).slice(0, opts.maxJsonChars)}`;
  }
  return s;
}

/** Tighter caps for reflector budget (planner uses larger caps in summarizeContextForPrompt). */
export function appendixForReflectorPrompt(ctx: AgentExecutionContext): string {
  return formatUserAndSessionJsonBlocks(ctx, {
    maxUserChars: 2000,
    maxJsonChars: 5000,
  });
}

function formatDerivedTemporalFacetsBlock(summary: DataSummary): string {
  const meta =
    summary.temporalFacetColumns?.length ?
      summary.temporalFacetColumns
    : temporalFacetMetadataForDateColumns(summary.dateColumns);
  if (!meta.length) return "";
  const lines = meta.map(
    (m) => `${m.name} (${m.grain} of "${m.sourceColumn}")`
  );
  const cap = 80;
  const shown = lines.slice(0, cap);
  const more = lines.length > cap ? `\n... +${lines.length - cap} more` : "";
  return `\nDerived time-bucket columns (precomputed from dateColumns; use the exact column name shown — e.g. \`Month · Order Date\` — matching the question's grain; legacy \`__tf_*\` ids are still accepted):\n${shown.join("\n")}${more}`;
}

export function summarizeContextForPrompt(ctx: AgentExecutionContext): string {
  const cols = ctx.summary.columns.map((c) => c.name).join(", ");
  const dates = ctx.summary.dateColumns.join(", ") || "(none)";
  const numerics = ctx.summary.numericColumns.join(", ") || "(none)";
  const pre = ctx.streamPreAnalysis;
  const atMentionNote = ctx.question.includes("@")
    ? "\nThe user may prefix column names with @ (e.g. @Sales (Volume)); treat those as references to the exact schema column names listed above."
    : "";
  const auth =
    pre?.canonicalColumns?.length ?
      `\nAUTHORITATIVE columns for this question (use these EXACT strings in execute_query_plan groupBy, aggregations, dimensionFilters, sort, and any tool args that name columns — unless get_schema_summary shows the headers differ): ${pre.canonicalColumns.join(", ")}`
    : "";
  const mapBlock =
    pre?.columnMapping && Object.keys(pre.columnMapping).length > 0 ?
      `\nPhrase → column: ${JSON.stringify(pre.columnMapping)}`
    : "";
  const hints = pre
    ? `${auth}${mapBlock}\nUpstream analysis intent: ${pre.intentLabel}\nPreferred columns: ${pre.relevantColumns.join(", ") || "(none)"}\nUser intent summary: ${pre.userIntent}`
    : "";
  const blocks = formatUserAndSessionJsonBlocks(ctx, {
    maxUserChars: 6000,
    maxJsonChars: 12000,
  });
  const temporal = detectPeriodFromQuery(ctx.question);
  const temporalLine = temporal
    ? `\nTemporal intent from question: use dateAggregationPeriod=${temporal} when bucketing a raw date column, or groupBy the matching derived time-bucket column (same name as in the list above, e.g. \`Month · …\`) and omit date bucketing in the plan. For vague temporal questions (no explicit grain), prefer sorting on the raw date column over forcing yearly buckets.`
    : "";
  const facetBlock = formatDerivedTemporalFacetsBlock(ctx.summary);
  const diag =
    ctx.analysisSpec?.mode === "diagnostic" ?
      `\nDIAGNOSTIC_ANALYSIS_HINT: User question matches driver/factor/deep-dive intent. Prefer: (1) execute_query_plan with dimensionFilters only (no aggregations) OR run_readonly_sql on row-level \`dataset\` to slice the segment; (2) breakdowns (groupBy + sum) **on the sliced frame**; (3) run_correlation with **dimensionFilters** matching the slice and **targetVariable** = numeric outcome (e.g. Sales)—do **not** run correlation only on small aggregate tables from step (1) if that table has one row per group already. When **run_segment_driver_analysis** is available and the question is clearly about drivers in a segment, you may use it as one step. Independent post-slice queries may be planned as parallel-friendly separate steps with the same dependsOn parent if the executor supports it; otherwise keep a short linear plan.\nSuggested outcome column (hint only): ${ctx.analysisSpec.outcomeColumn ?? "(infer from question)"}`
    : "";
  return `Dataset: ${ctx.summary.rowCount} rows, columns: ${cols}.
dateColumns: ${dates}
numericColumns: ${numerics}${facetBlock}${hints}${atMentionNote}${temporalLine}
Mode: ${ctx.mode}${diag}${blocks}`;
}
