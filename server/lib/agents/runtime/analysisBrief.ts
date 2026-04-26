import { analysisBriefSchema, type AnalysisBrief } from "../../../shared/schema.js";
import type { AgentExecutionContext } from "./types.js";
import { userMessageHasReportIntent } from "../../reportIntent.js";
import type { InferredFilter } from "../utils/inferFiltersFromQuestion.js";

function shouldBuildAnalysisBrief(ctx: AgentExecutionContext): boolean {
  if (ctx.mode !== "analysis") return false;
  if (ctx.analysisSpec?.mode === "diagnostic") return true;
  if (userMessageHasReportIntent(ctx.question)) return true;
  return false;
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

candidateDriverDimensions: only set for driver_discovery or variance_diagnostic. Propose up to 6 column names from the Columns line that might plausibly drive the outcomeMetricColumn (ordinarily categorical dimensions, region/category/segment-like columns). Must not overlap segmentationDimensions.

requestsDashboard (Phase-2): set to true when the user explicitly asks to build / create / turn-into a dashboard, a report, or a monitoring view. Trigger phrases include "make me a dashboard", "turn this into a dashboard", "give me a dashboard for X", "build a report for X", "monitoring view". Do NOT set true for plain analytical questions even if they're broad.

comparisonPeriods (Phase-1 time_window_diff): ONLY set when the user explicitly contrasts two named time windows (e.g. "Mar-22 vs Apr-25", "Q3 vs Q4", "last year vs this year"). Each side is an array of analysisBriefFilterSchema that selects the period — typically a single filter on a date-like column whose values are the literal period labels the user named. Include short aLabel / bLabel (e.g. "Mar-22", "Apr-25") so downstream narrative reads naturally. Leave unset when the user gives a single window or no window at all.`;

  const inferredBlock = ctx.inferredFilters?.length
    ? `\n\nDeterministically inferred filters (from user-named values in topValues — include these verbatim in the brief's \`filters\` unless the user asked for an unfiltered view):\n${JSON.stringify(ctx.inferredFilters.map(stripInternalFields)).slice(0, 1500)}`
    : "";

  const user = `Question:\n${ctx.question.slice(0, 4000)}\n\nColumns:\n${columnListForBrief(ctx)}\n\nNumeric columns: ${(ctx.summary.numericColumns || []).join(", ")}\nDate columns: ${(ctx.summary.dateColumns || []).join(", ")}${inferredBlock}`;

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
