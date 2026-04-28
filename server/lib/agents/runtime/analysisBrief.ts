import { analysisBriefSchema, type AnalysisBrief } from "../../../shared/schema.js";
import type { AgentExecutionContext } from "./types.js";
import { userMessageHasReportIntent } from "../../reportIntent.js";
import type { InferredFilter } from "../utils/inferFiltersFromQuestion.js";
import {
  tagMarketingColumns,
  looksLikeMarketingMixDataset,
} from "../../marketingColumnTags.js";

// W39 · exported so the merged-pre-planner path can apply the same gate
// the per-task analysisBrief call uses, keeping behaviour identical.
export function shouldBuildAnalysisBrief(ctx: AgentExecutionContext): boolean {
  if (ctx.mode !== "analysis") return false;
  if (ctx.analysisSpec?.mode === "diagnostic") return true;
  if (userMessageHasReportIntent(ctx.question)) return true;
  if (looksLikeBudgetReallocationQuestion(ctx.question)) return true;
  return false;
}

const REALLOC_VERB_RX = /(redistribut|reallocat|reshuffl|rebalanc|optimi[sz]|optimal\b)/i;
const REALLOC_NOUN_RX = /(budget|spend|investment|allocation|media|marketing|mix)/i;
const STRONG_PHRASE_RX =
  /(media[\s_-]*mix|marketing[\s_-]*mix|\bmmm\b|where (?:should|to) (?:i )?(?:spend|invest|put))/i;

/**
 * Lightweight intent detector for the budget_reallocation question shape. Used
 * both in shouldBuildAnalysisBrief (so the brief LLM gets to confirm) and in
 * the W53 tool's planner-priority hint. Two patterns:
 *   - strong phrase ("media mix", "MMM", "where should I spend")
 *   - reallocation verb + budget/media noun in the same question
 */
export function looksLikeBudgetReallocationQuestion(question: string): boolean {
  if (STRONG_PHRASE_RX.test(question)) return true;
  return REALLOC_VERB_RX.test(question) && REALLOC_NOUN_RX.test(question);
}

function columnListForBrief(ctx: AgentExecutionContext): string {
  return ctx.summary.columns
    .map((c) => c.name)
    .slice(0, 120)
    .join(", ");
}

/**
 * One structured LLM call before the planner when diagnostic or report intent is detected.
 * Sets `ctx.analysisBrief` when successful.
 */
export async function maybeRunAnalysisBrief(
  ctx: AgentExecutionContext,
  turnId: string,
  onLlmCall: () => void
): Promise<void> {
  if (!shouldBuildAnalysisBrief(ctx)) return;
  if (ctx.analysisBrief) return;

  const system = `You extract a structured ANALYSIS BRIEF from the user question and dataset column names.
Output JSON only matching the schema. Use ONLY column names that appear in the provided Columns line.
If the question is ambiguous, put questions in clarifyingQuestions (do not invent column names).
epistemicNotes must remind analysts to avoid claiming causation from observational data alone (attribution vs causation).
filters: use op "in" or "not_in" with values[] when the user names literal segments (regions, categories).

questionShape classification (pick at most one; leave unset if unclear):
- "driver_discovery" — user asks what drives / impacts / affects / correlates with an outcome. Example: "what impacts my sales the most?"
- "variance_diagnostic" — user asks WHY a metric moved in a segment between two periods. Example: "why did east-region tech sales fall Mar-22 to Apr-25?"
- "trend" — user asks how a metric evolved over time.
- "comparison" — user contrasts two explicit segments / periods without asking "why".
- "exploration" — open prompt like "show me something interesting / surprising".
- "descriptive" — lookup/summary question ("what's my top region by revenue?").
- "budget_reallocation" — user asks how to redistribute / reallocate / optimize media spend across channels. Trigger phrases: "redistribute my budget", "reallocate spend", "optimize media mix", "where should I spend", "MMM". Requires a marketing-mix dataset (multiple channel-spend columns + outcome + time). When this shape applies, set outcomeMetricColumn to the conversion metric (revenue/sales/conversions) and put each channel-spend column into segmentationDimensions.

candidateDriverDimensions: set for driver_discovery, variance_diagnostic, OR whenever requestsDashboard is true. Propose up to 24 column names from the Columns line that might plausibly drive the outcomeMetricColumn (ordinarily categorical dimensions: region/category/segment/channel/account/SKU-like columns). Must not overlap segmentationDimensions. When requestsDashboard is true, err on the side of LISTING every plausible categorical dimension (the dashboard is meant to be exhaustive); when in doubt, include it — downstream cardinality guards will skip dimensions with too many unique values.

requestsDashboard (Phase-2): set to true when the user explicitly asks to build / create / turn-into a dashboard, a report, or a monitoring view. Trigger phrases include "make me a dashboard", "turn this into a dashboard", "give me a dashboard for X", "build a report for X", "monitoring view". Do NOT set true for plain analytical questions even if they're broad.

comparisonPeriods (Phase-1 time_window_diff): ONLY set when the user explicitly contrasts two named time windows (e.g. "Mar-22 vs Apr-25", "Q3 vs Q4", "last year vs this year"). Each side is an array of analysisBriefFilterSchema that selects the period — typically a single filter on a date-like column whose values are the literal period labels the user named. Include short aLabel / bLabel (e.g. "Mar-22", "Apr-25") so downstream narrative reads naturally. Leave unset when the user gives a single window or no window at all.`;

  const inferredBlock = ctx.inferredFilters?.length
    ? `\n\nDeterministically inferred filters (from user-named values in topValues — include these verbatim in the brief's \`filters\` unless the user asked for an unfiltered view):\n${JSON.stringify(ctx.inferredFilters.map(stripInternalFields)).slice(0, 1500)}`
    : "";

  const marketingBlock = buildMarketingHintBlock(ctx);

  const user = `Question:\n${ctx.question.slice(0, 4000)}\n\nColumns:\n${columnListForBrief(ctx)}\n\nNumeric columns: ${(ctx.summary.numericColumns || []).join(", ")}\nDate columns: ${(ctx.summary.dateColumns || []).join(", ")}${inferredBlock}${marketingBlock}`;

  const { completeJson } = await import("./llmJson.js");
  const { LLM_PURPOSE } = await import("./llmCallPurpose.js");
  const out = await completeJson(system, user, analysisBriefSchema, {
    turnId,
    temperature: 0.15,
    maxTokens: 1200,
    onLlmCall,
    purpose: LLM_PURPOSE.ANALYSIS_BRIEF,
  });
  if (!out.ok) return;
  ctx.analysisBrief = mergeInferredFiltersIntoBrief(out.data, ctx.inferredFilters);
}

/**
 * If the dataset looks like a marketing-mix dataset, hand the brief LLM a
 * deterministic suggestion of which columns are spend / outcome / time so it
 * can fill outcomeMetricColumn + segmentationDimensions accurately for the
 * budget_reallocation shape.
 */
function buildMarketingHintBlock(ctx: AgentExecutionContext): string {
  if (!looksLikeMarketingMixDataset(ctx.summary)) return "";
  const t = tagMarketingColumns(ctx.summary);
  const lines = [
    "\n\nMarketing-mix hint (deterministic — use when classifying budget_reallocation):",
    `  spend_columns: ${t.spendColumns.join(", ") || "(none detected)"}`,
    `  outcome_candidates: ${t.outcomeCandidates.join(", ") || "(none detected)"}`,
    `  time_column: ${t.timeColumn ?? "(none)"}`,
  ];
  if (t.channelDimension) lines.push(`  channel_dimension: ${t.channelDimension}`);
  return lines.join("\n");
}

function stripInternalFields(f: InferredFilter) {
  return { column: f.column, op: f.op, values: f.values, match: f.match };
}

/**
 * Union inferred filters into the brief's `filters`. Brief-emitted filters for a
 * given (column, op) take precedence; inferred filters fill the gap when the
 * brief LLM omitted a user-named segment.
 */
export function mergeInferredFiltersIntoBrief(
  brief: AnalysisBrief,
  inferred: InferredFilter[] | undefined
): AnalysisBrief {
  if (!inferred?.length) return brief;
  const existingKeys = new Set<string>();
  for (const f of brief.filters ?? []) {
    existingKeys.add(`${f.column}|${f.op}`);
  }
  const merged: NonNullable<AnalysisBrief["filters"]> = [...(brief.filters ?? [])];
  for (const f of inferred) {
    const key = `${f.column}|${f.op}`;
    if (existingKeys.has(key)) continue;
    merged.push({
      column: f.column,
      op: f.op,
      values: f.values,
      match: f.match,
    });
  }
  return { ...brief, filters: merged };
}

export function formatAnalysisBriefForPrompt(ctx: AgentExecutionContext): string {
  const b = ctx.analysisBrief;
  if (!b) return "";
  const lines: string[] = ["\nANALYSIS_BRIEF_JSON (planner + verifier must align claims and tools with this brief):"];
  lines.push(JSON.stringify(b).slice(0, 6000));
  if (b.clarifyingQuestions?.length) {
    lines.push(
      "If clarifyingQuestions is non-empty and no tool can answer without user input, prefer clarify_user early."
    );
  }
  return lines.join("\n");
}

export type { AnalysisBrief };
