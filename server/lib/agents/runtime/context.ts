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
import { classifyHierarchyIntent } from "./planArgRepairs.js";

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
  abortSignal?: AbortSignal;
}): AgentExecutionContext {
  const inferredFilters = inferFiltersFromQuestion(
    params.question,
    params.summary
  );
  // W-PivotState · find the most recent assistant message that carries a
  // persisted pivotState. We walk from the end so an intermediate message
  // (W41 streaming preview) without saved state doesn't shadow the prior
  // finalized turn's view.
  let lastAssistantPivotState: Message["pivotState"] | undefined;
  for (let i = params.chatHistory.length - 1; i >= 0; i--) {
    const m = params.chatHistory[i];
    if (m?.role === "assistant" && m.pivotState) {
      lastAssistantPivotState = m.pivotState;
      break;
    }
  }
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
    abortSignal: params.abortSignal,
    inferredFilters: inferredFilters.length ? inferredFilters : undefined,
    lastAssistantPivotState,
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

/**
 * H4 / RD1 · Surface user-declared dimension hierarchies as a first-class
 * block so the planner picks the right breakdown (excludes the rollup row
 * from peer comparisons, frames metrics as "share of category" when the
 * rollup is the denominator). Per-hierarchy intent classification (RD1)
 * is appended so the LLM knows which question shape applies right now.
 * Empty array → empty string. Capped to keep the prompt tight.
 */
export function formatDimensionHierarchiesBlock(
  ctx: AgentExecutionContext
): string {
  const hierarchies =
    ctx.sessionAnalysisContext?.dataset?.dimensionHierarchies ?? [];
  if (!hierarchies.length) return "";
  const lines = hierarchies.slice(0, 12).map((h) => {
    const items = h.itemValues?.length
      ? ` (children: ${h.itemValues.slice(0, 8).join(", ")}${h.itemValues.length > 8 ? ", ..." : ""})`
      : "";
    const note = h.description?.trim() ? ` — ${h.description.trim().slice(0, 200)}` : "";
    return `  - "${h.column}" column: "${h.rollupValue}" is a category total that rolls up the other values in the same column${items}${note}`;
  });
  const intents = classifyHierarchyIntent(ctx.question, hierarchies);
  const shareIntents = intents.filter((i) => i.intent === "share-of-category");
  const mentionIntents = intents.filter((i) => i.intent === "rollup-mention");
  const intentBlock: string[] = [];
  if (shareIntents.length) {
    intentBlock.push(
      `\nDETECTED INTENT — share-of-category: the user's question matches a "share / contribution / % of <category>" pattern for the following hierarchies. Use the rollup value AS THE DENOMINATOR for any share / percentage / contribution metric. Do NOT exclude the rollup row from the data — it must stay in so you can divide by it. Examples: "MARICO is 9% of the FEMALE SHOWER GEL category" (= 6000/68751), NOT "MARICO is 66% among non-FSG products" (= 6000/9056).`
    );
    for (const i of shareIntents) {
      intentBlock.push(`  - "${i.column}" — denominator: "${i.rollupValue}"`);
    }
  }
  if (mentionIntents.length) {
    intentBlock.push(
      `\nDETECTED INTENT — rollup-mention: the user names the rollup value directly. The rollup row is kept in the data. Treat it as a category total in narrative; do not compare it as a peer of its members.`
    );
    for (const i of mentionIntents) {
      intentBlock.push(`  - "${i.column}" rollup: "${i.rollupValue}"`);
    }
  }
  return `\nDIMENSION HIERARCHIES (declared by the user — treat as ground truth):\n${lines.join(
    "\n"
  )}\nWhen grouping/ranking by these columns, the deterministic pre-pass auto-excludes the rollup row from peer comparisons UNLESS the user explicitly asks about the rollup value or asks for a share/contribution/% of the category. Frame the rollup as a category total in narrative; frame its members as a share OF the category, not of the dataset total.${intentBlock.join("\n")}`;
}

/**
 * WPF1 · When the upload pipeline auto-melted a wide-format spreadsheet
 * (Nielsen / Marico-VN style with period-as-columns), surface the long-form
 * schema semantics as a labelled block. The LLM otherwise sees only a flat
 * column list (`Markets, Products, Period, PeriodIso, PeriodKind, Value,
 * Metric`) and has to guess what each column means — leading to wrong
 * sort order on Period (lexicographic Q1 24 < Q2 23) and silent SUM across
 * mixed metrics in compound shape.
 *
 * Empty when no melt was detected.
 */
export function formatWideFormatShapeBlock(summary: DataSummary): string {
  const wf = summary.wideFormatTransform;
  if (!wf?.detected) return "";

  const idCols = wf.idColumns.length ? wf.idColumns.join(", ") : "(none)";
  const valueCol = summary.columns.find((c) => c.name === wf.valueColumn);
  const currencyTag = valueCol?.currency
    ? ` (${valueCol.currency.isoCode}, symbol "${valueCol.currency.symbol}")`
    : "";

  const isCompound = wf.shape === "compound" && !!wf.metricColumn;
  let metricLine = "";
  let compoundCritical = "";
  if (isCompound && wf.metricColumn) {
    const metricCol = summary.columns.find((c) => c.name === wf.metricColumn);
    const distinctMetrics = (metricCol?.topValues ?? [])
      .slice(0, 12)
      .map((t) => String(t.value).trim())
      .filter(Boolean);
    const metricsList = distinctMetrics.length
      ? distinctMetrics.join(" | ")
      : "(see categoricalValues block)";
    metricLine = `\n- Metric (categorical, one of: ${metricsList}): ${wf.metricColumn}`;
    compoundCritical =
      `\n\nCRITICAL — COMPOUND SHAPE: the ${wf.valueColumn} column mixes multiple metrics ` +
      `(${metricsList}). NEVER aggregate ${wf.valueColumn} without filtering by ${wf.metricColumn}. ` +
      `Every plan that touches ${wf.valueColumn} MUST include a dimensionFilter on ${wf.metricColumn} ` +
      `matching the user's intended metric (e.g. "sales"/"revenue"/"value" → ${wf.metricColumn} = a value-sales metric; ` +
      `"volume"/"units" → ${wf.metricColumn} = a volume metric). For cross-metric questions ` +
      `("compare sales vs volume"), groupBy ${wf.metricColumn} so each metric stays separable. ` +
      `If the user's question is metric-ambiguous, use clarify_user with the available metric values.`;
  }

  const meltedCap = 20;
  const meltedShown = wf.meltedColumns.slice(0, meltedCap).join(", ");
  const meltedMore =
    wf.meltedColumns.length > meltedCap
      ? `, ...(${wf.meltedColumns.length} total)`
      : "";

  return (
    `\n### DATASET SHAPE — pre-melted from wide format (treat as ground truth):\n` +
    `This dataset arrived in WIDE format (period-as-columns) and was MELTED to LONG form at upload time. ` +
    `The original wide columns NO LONGER EXIST in the schema. Use ONLY the long-form columns listed below.\n\n` +
    `Long-form schema after melt (one row per id × period${isCompound ? " × metric" : ""}):\n` +
    `- ID columns: ${idCols}\n` +
    `- Period (raw human label, e.g. "Q1 23", "Latest 12 Mths"): ${wf.periodColumn}\n` +
    `- PeriodIso (CANONICAL sortable, e.g. "2023-Q1"): ${wf.periodIsoColumn} ` +
    `← ALWAYS sort/order time queries by this column, not ${wf.periodColumn}. ` +
    `Lexicographic sort on ${wf.periodColumn} produces "Q1 24" before "Q2 23" — wrong.\n` +
    `- PeriodKind (grain, e.g. quarter | year_to_date | latest_n): ${wf.periodKindColumn}\n` +
    `- Value (numeric): ${wf.valueColumn}${currencyTag}${metricLine}${compoundCritical}\n\n` +
    `Original wide-format column names that NO LONGER EXIST (do NOT reference these in any tool args; ` +
    `if the user mentions one, translate to ${wf.periodColumn}+${wf.valueColumn}` +
    `${isCompound ? `+${wf.metricColumn}` : ""} on the long form): ${meltedShown}${meltedMore}`
  );
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

/**
 * W-PivotState · render the user's currently-saved pivot/chart view as a
 * compact markdown block. Surfaced into the planner and synthesis prompts so
 * follow-up questions ("now break it down by category", "switch to a line
 * chart") have an explicit baseline. Returns "" when no state is saved.
 */
export function formatLastAssistantPivotStateBlock(
  state: Message["pivotState"] | undefined
): string {
  if (!state) return "";
  const cfg = state.config;
  const rows = cfg.rows.length ? cfg.rows.join(", ") : "(none)";
  const cols = cfg.columns.length ? cfg.columns.join(", ") : "(none)";
  const vals = cfg.values.length
    ? cfg.values.map((v) => `${v.field}(${v.agg})`).join(", ")
    : "(none)";
  const filters = cfg.filters.length ? cfg.filters.join(", ") : "(none)";
  const view = state.analysisView ?? "chart";
  const chart = state.chart
    ? `${state.chart.type} (x=${state.chart.xCol || "auto"}, y=${state.chart.yCol || "auto"}${
        state.chart.seriesCol ? `, series=${state.chart.seriesCol}` : ""
      }${state.chart.type === "bar" ? `, layout=${state.chart.barLayout}` : ""})`
    : "(default)";
  const filterSelKeys = state.filterSelections
    ? Object.keys(state.filterSelections)
    : [];
  const filterSelLine = filterSelKeys.length
    ? `\nfilterSelections: ${filterSelKeys
        .map(
          (k) => `${k}=[${(state.filterSelections?.[k] ?? []).slice(0, 6).join("|")}]`
        )
        .join("; ")
        .slice(0, 800)}`
    : "";
  return `\n### CURRENT_USER_VIEW (pivot/chart state of the most recent assistant message — what the user is looking at right now; treat as the implicit baseline for follow-up questions like "drill into X", "switch to line chart", "remove that filter")\nrows: ${rows}\ncolumns: ${cols}\nvalues: ${vals}\nfilters: ${filters}${filterSelLine}\nview: ${view}\nchart: ${chart}`;
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
  // WPF6 · When the dataset was melted from wide format, the time axis lives
  // in PeriodIso (canonical sortable) rather than in a parseable date column.
  // Surface it on the dateColumns line so the planner doesn't go hunting for
  // a real date column that doesn't exist.
  const wfForDates = ctx.summary.wideFormatTransform;
  const dateColParts = [...ctx.summary.dateColumns];
  if (
    wfForDates?.detected &&
    wfForDates.periodIsoColumn &&
    !dateColParts.includes(wfForDates.periodIsoColumn)
  ) {
    dateColParts.push(`${wfForDates.periodIsoColumn} (canonical period — see DATASET SHAPE block)`);
  }
  const dates = dateColParts.join(", ") || "(none)";
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
  const hierarchyBlock = formatDimensionHierarchiesBlock(ctx);
  const wideFormatBlock = formatWideFormatShapeBlock(ctx.summary);
  const diag =
    ctx.analysisSpec?.mode === "diagnostic" ?
      `\nDIAGNOSTIC_ANALYSIS_HINT: User question matches driver/factor/deep-dive intent. Prefer: (1) execute_query_plan with dimensionFilters only (no aggregations) OR run_readonly_sql on row-level \`dataset\` to slice the segment; (2) breakdowns (groupBy + sum) **on the sliced frame**; (3) run_correlation with **dimensionFilters** matching the slice and **targetVariable** = numeric outcome (e.g. Sales)—do **not** run correlation only on small aggregate tables from step (1) if that table has one row per group already. When **run_segment_driver_analysis** is available and the question is clearly about drivers in a segment, you may use it as one step. Independent post-slice queries may be planned as parallel-friendly separate steps with the same dependsOn parent if the executor supports it; otherwise keep a short linear plan.\nSuggested outcome column (hint only): ${ctx.analysisSpec.outcomeColumn ?? "(infer from question)"}`
    : "";
  const briefBlock = formatAnalysisBriefForPrompt(ctx);
  const pivotStateBlock = formatLastAssistantPivotStateBlock(ctx.lastAssistantPivotState);
  return `Dataset: ${ctx.summary.rowCount} rows, columns: ${cols}.
dateColumns: ${dates}
numericColumns: ${numerics}${facetBlock}${categoricalBlock}${hints}${atMentionNote}${temporalLine}
Mode: ${ctx.mode}${inferredBlock}${hierarchyBlock}${wideFormatBlock}${diag}${briefBlock}${pivotStateBlock}${blocks}`;
}
