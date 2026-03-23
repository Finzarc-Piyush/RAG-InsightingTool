import type {
  DataSummary,
  Insight,
  Message,
  SessionAnalysisContext,
} from "../../../shared/schema.js";
import type { AgentExecutionContext, StreamPreAnalysis } from "./types.js";

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

export function summarizeContextForPrompt(ctx: AgentExecutionContext): string {
  const cols = ctx.summary.columns.map((c) => c.name).join(", ");
  const pre = ctx.streamPreAnalysis;
  const hints = pre
    ? `\nUpstream analysis intent: ${pre.intentLabel}\nPreferred columns: ${pre.relevantColumns.join(", ") || "(none)"}\nUser intent summary: ${pre.userIntent}`
    : "";
  const blocks = formatUserAndSessionJsonBlocks(ctx, {
    maxUserChars: 6000,
    maxJsonChars: 12000,
  });
  return `Dataset: ${ctx.summary.rowCount} rows, columns: ${cols}.${hints}\nMode: ${ctx.mode}${blocks}`;
}
