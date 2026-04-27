import type { ChatDocument } from "../../../models/chat.model.js";
import type {
  DataSummary,
  Insight,
  Message,
  SessionAnalysisContext,
} from "../../../shared/schema.js";
import type { AgentExecutionContext, AnalysisSpecForAgent, StreamPreAnalysis } from "./types.js";
import { formatAnalysisBriefForPrompt } from "./analysisBrief.js";
import { detectPeriodFromQuery } from "../../dateUtils.js";
import { temporalFacetMetadataForDateColumns } from "../../temporalFacetColumns.js";
import { inferFiltersFromQuestion } from "../utils/inferFiltersFromQuestion.js";
import { formatPriorInvestigationsForPlanner } from "./priorInvestigations.js";

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
  domainContext?: string;
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
  const inferredFilters = inferFiltersFromQuestion(
    params.question,
    params.summary
  );
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
    domainContext: params.domainContext,
    sessionAnalysisContext: params.sessionAnalysisContext,
    columnarStoragePath: params.columnarStoragePath,
    chatDocument: params.chatDocument,
    dataBlobVersion: params.dataBlobVersion,
    loadFullData: params.loadFullData,
    streamPreAnalysis: params.streamPreAnalysis,
    onMidTurnSessionContext: params.onMidTurnSessionContext,
    onIntermediateArtifact: params.onIntermediateArtifact,
    inferredFilters: inferredFilters.length ? inferredFilters : undefined,
  };
}

/** Shared user notes + session JSON blocks (used by planner summary and reflector). */
export function formatUserAndSessionJsonBlocks(
  ctx: AgentExecutionContext,
  opts: { maxUserChars: number; maxJsonChars: number; maxDomainChars?: number }
): string {
  let s = "";
  if (ctx.permanentContext?.trim().length) {
    s += `\nUser-provided notes (verbatim):\n${ctx.permanentContext.trim().slice(0, opts.maxUserChars)}`;
  }
  if (ctx.domainContext?.trim().length) {
    const cap = opts.maxDomainChars ?? 12000;
    s +=
      `\nDomain knowledge (Marico/FMCG; authored background context — ` +
      `treat as orientation only, never as numeric evidence; tool output and ` +
      `RAG citations remain authoritative for any figure):\n` +
      ctx.domainContext.trim().slice(0, cap);
  }
  // W21 · prior-turn investigation digest, emitted as a labelled block so
  // the planner sees it as a first-class signal rather than buried inside
  // the session-context JSON dump. Empty array → empty string.
  const priorBlock = formatPriorInvestigationsForPlanner(ctx.sessionAnalysisContext);
  if (priorBlock) {
    s += `\n${priorBlock}`;
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
    maxDomainChars: 6000,
  });
}

function formatCategoricalValuesBlock(summary: DataSummary): string {
  const numeric = new Set(summary.numericColumns ?? []);
  const dates = new Set(summary.dateColumns ?? []);
  const perColumnValueCap = 8;
  const totalCharCap = 2000;
  const lines: string[] = [];
  for (const col of summary.columns) {
    if (numeric.has(col.name) || dates.has(col.name)) continue;
    if (col.type === "number") continue;
    if (!col.topValues || col.topValues.length === 0) continue;
    const values = col.topValues
      .slice(0, perColumnValueCap)
      .map((t) => String(t.value).trim())
      .filter(Boolean);
    if (!values.length) continue;
    lines.push(`  ${col.name}=[${values.join("|")}]`);
  }
  if (!lines.length) return "";
  let body = lines.join("\n");
  if (body.length > totalCharCap) {
    body = `${body.slice(0, totalCharCap)}\n  ... (truncated)`;
  }
  return `\ncategoricalValues (verbatim values by column; when the user names one of these in the question, include it as a dimensionFilter on the matching column — use op:"in", match:"case_insensitive" and pass the value verbatim):\n${body}`;
}

function formatInferredFiltersBlock(ctx: AgentExecutionContext): string {
  const fs = ctx.inferredFilters;
  if (!fs?.length) return "";
  const payload = fs.map((f) => ({
    column: f.column,
    op: f.op,
    values: f.values,
    match: f.match,
    matchedTokens: f.matchedTokens,
  }));
  const json = JSON.stringify(payload).slice(0, 2000);
  return `\nINFERRED_FILTERS_JSON (deterministically resolved from the user question against categorical topValues — treat as authoritative and include verbatim in execute_query_plan.dimensionFilters, run_correlation.dimensionFilters, breakdown_ranking.dimensionFilters, and any other tool that accepts dimensionFilters, unless the user's phrasing explicitly asks for the unfiltered view):\n${json}`;
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
    maxDomainChars: 12000,
  });
  const temporal = detectPeriodFromQuery(ctx.question);
  const temporalLine = temporal
    ? `\nTemporal intent from question: use dateAggregationPeriod=${temporal} when bucketing a raw date column, or groupBy the matching derived time-bucket column (same name as in the list above, e.g. \`Month · …\`) and omit date bucketing in the plan. For vague temporal questions (no explicit grain), prefer sorting on the raw date column over forcing yearly buckets.`
    : "";
  const facetBlock = formatDerivedTemporalFacetsBlock(ctx.summary);
  const categoricalBlock = formatCategoricalValuesBlock(ctx.summary);
  const inferredBlock = formatInferredFiltersBlock(ctx);
  const diag =
    ctx.analysisSpec?.mode === "diagnostic" ?
      `\nDIAGNOSTIC_ANALYSIS_HINT: User question matches driver/factor/deep-dive intent. Prefer: (1) execute_query_plan with dimensionFilters only (no aggregations) OR run_readonly_sql on row-level \`dataset\` to slice the segment; (2) breakdowns (groupBy + sum) **on the sliced frame**; (3) run_correlation with **dimensionFilters** matching the slice and **targetVariable** = numeric outcome (e.g. Sales)—do **not** run correlation only on small aggregate tables from step (1) if that table has one row per group already. When **run_segment_driver_analysis** is available and the question is clearly about drivers in a segment, you may use it as one step. Independent post-slice queries may be planned as parallel-friendly separate steps with the same dependsOn parent if the executor supports it; otherwise keep a short linear plan.\nSuggested outcome column (hint only): ${ctx.analysisSpec.outcomeColumn ?? "(infer from question)"}`
    : "";
  const briefBlock = formatAnalysisBriefForPrompt(ctx);
  return `Dataset: ${ctx.summary.rowCount} rows, columns: ${cols}.
dateColumns: ${dates}
numericColumns: ${numerics}${facetBlock}${categoricalBlock}${hints}${atMentionNote}${temporalLine}
Mode: ${ctx.mode}${inferredBlock}${diag}${briefBlock}${blocks}`;
}
