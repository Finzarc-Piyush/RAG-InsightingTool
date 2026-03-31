import type {
  DataSummary,
  Insight,
  Message,
  SessionAnalysisContext,
} from "../../../shared/schema.js";
import type { AgentExecutionContext, StreamPreAnalysis } from "./types.js";
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
  dataBlobVersion?: number;
  loadFullData?: () => Promise<Record<string, any>[]>;
  streamPreAnalysis?: StreamPreAnalysis;
  onMidTurnSessionContext?: MidTurnPersist;
  onIntermediateArtifact?: AgentExecutionContext["onIntermediateArtifact"];
}): AgentExecutionContext {
  return {
    sessionId: params.sessionId,
    username: params.username,
    question: params.question,
    data: params.data,
    summary: params.summary,
    chatHistory: params.chatHistory,
    chatInsights: params.chatInsights,
    mode: params.mode,
    permanentContext: params.permanentContext,
    sessionAnalysisContext: params.sessionAnalysisContext,
    columnarStoragePath: params.columnarStoragePath,
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
  return `\nDerived time-bucket columns (precomputed from dateColumns; use the matching __tf_* facet column when the question requests that grain):\n${shown.join("\n")}${more}`;
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
    ? `\nTemporal intent from question: use dateAggregationPeriod=${temporal} when bucketing a raw date column, or groupBy the matching precomputed __tf_* facet column and omit date bucketing in the plan. For vague temporal questions (no explicit grain), prefer sorting on the raw date column over forcing yearly buckets.`
    : "";
  const facetBlock = formatDerivedTemporalFacetsBlock(ctx.summary);
  return `Dataset: ${ctx.summary.rowCount} rows, columns: ${cols}.
dateColumns: ${dates}
numericColumns: ${numerics}${facetBlock}${hints}${atMentionNote}${temporalLine}
Mode: ${ctx.mode}${blocks}`;
}
