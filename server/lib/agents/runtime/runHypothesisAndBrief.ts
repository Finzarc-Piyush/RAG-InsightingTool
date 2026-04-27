/**
 * Wave W39 · merged hypothesis + analysis-brief LLM call (env-gated)
 *
 * A typical analytical turn currently fires TWO sequential LLM calls before
 * the planner:
 *   1. `generateHypotheses` — produces 3–5 testable hypotheses for the
 *      blackboard.
 *   2. `maybeRunAnalysisBrief` — produces a structured brief (shape,
 *      driver dimensions, etc.) when diagnostic-intent is detected.
 *
 * Both consume the same dataset summary + question and ask the LLM for
 * related but distinct outputs. This wave merges them into a SINGLE LLM
 * call that returns both objects — cuts wall-time by ~one network round-
 * trip per analytical turn (~1–3s) AND consolidates token spend.
 *
 * Gated by `MERGED_PRE_PLANNER=true` (default OFF). Falls back to the
 * existing per-task calls on:
 *   - Env flag off
 *   - Schema validation failure on either sub-section (so we never ship
 *     a half-broken brief)
 *   - LLM call failure (network, parse)
 *
 * The merged-prompt is RIGOROUS about format separation: each sub-section
 * lives under its own schema key (`hypotheses` and `brief`), parsed
 * independently. If either is malformed, we fall through.
 *
 * Reuses the existing `hypothesisOutputSchema` and `analysisBriefSchema`
 * directly so any callsite expecting the original shapes continues to
 * work — no shape divergence.
 */
import { z } from "zod";
import { completeJson } from "./llmJson.js";
import { LLM_PURPOSE } from "./llmCallPurpose.js";
import { ANALYST_PREAMBLE } from "./sharedPrompts.js";
import { agentLog } from "./agentLogger.js";
import {
  addHypothesis,
  type AnalyticalBlackboard,
} from "./analyticalBlackboard.js";
import {
  analysisBriefSchema,
  type AnalysisBrief,
} from "../../../shared/schema.js";
import { mergeInferredFiltersIntoBrief } from "./analysisBrief.js";
import { applyAnalysisBriefDigestToSession } from "../../sessionAnalysisContext.js";
import type { AgentExecutionContext } from "./types.js";

export function isMergedPrePlannerEnabled(): boolean {
  return process.env.MERGED_PRE_PLANNER === "true";
}

// Same shape as the per-task hypothesis schema (kept here to avoid a
// circular import with hypothesisPlanner.ts; both produce the same
// `{ hypotheses: [{ text, targetColumn? }] }` shape).
const hypothesisItemSchema = z.object({
  text: z.string(),
  targetColumn: z.string().optional(),
});

/**
 * Merged output schema. Both sub-sections are present (hypotheses always
 * required; brief required when the merged-call's gating logic upstream
 * decided to ask for it). The .nullable() on `brief` lets the LLM
 * explicitly opt out when it can't produce a structured brief.
 */
const mergedOutputSchema = z.object({
  hypotheses: z.array(hypothesisItemSchema).min(1).max(6),
  brief: analysisBriefSchema.nullable().optional(),
});

interface MergedResult {
  /** True when both sections parsed cleanly and were applied to ctx + blackboard. */
  ok: boolean;
  /** Set on the blackboard when ok=true. */
  hypothesesCount?: number;
  /** Set on ctx.analysisBrief when ok=true AND the brief was requested. */
  briefSet?: boolean;
}

/**
 * Run the merged pre-planner call. Mutates `blackboard` (adds hypotheses)
 * and `ctx.analysisBrief` on success. Returns false when the merged path
 * should fall back to per-task calls.
 */
export async function runHypothesisAndBriefMerged(
  ctx: AgentExecutionContext,
  blackboard: AnalyticalBlackboard,
  turnId: string,
  onLlmCall: () => void,
  /** From the caller's `shouldBuildAnalysisBrief(ctx)` gate. */
  shouldBuildBrief: boolean
): Promise<MergedResult> {
  if (!isMergedPrePlannerEnabled()) return { ok: false };

  const cols = ctx.summary.columns
    .slice(0, 40)
    .map((c) => `${c.name} (${c.type})`)
    .join(", ");
  const briefAsk = shouldBuildBrief
    ? `

ALSO produce a structured analysis BRIEF for this question with the same shape that the per-task analysisBriefSchema requires. Set \`brief\` to the brief JSON object. If the question is ambiguous, populate \`brief.clarifyingQuestions\`.

questionShape classification (pick at most one; leave \`brief\` null when no shape fits):
- "driver_discovery" — what drives / impacts an outcome.
- "variance_diagnostic" — why a metric moved between two periods.
- "trend" — how a metric evolved over time.
- "comparison" — contrast two explicit segments / periods.
- "exploration" — open prompt ("show me something interesting").
- "descriptive" — lookup/summary question.
`
    : `

Set \`brief\` to null. The caller's gate decided no structured brief is needed for this turn.`;

  const system = `${ANALYST_PREAMBLE}You are a pre-planner that produces TWO things in one JSON response: investigation hypotheses, and (conditionally) a structured analysis brief. Both are derived from the user question + dataset schema.

HYPOTHESES (always required, 3 to 5 entries under \`hypotheses\`):
- Each hypothesis MUST be falsifiable by querying the data (a simple aggregation, breakdown, or correlation).
- Focus on specific dimensions, metrics, or time windows visible in the schema.
- Do not repeat the question — each hypothesis should be a distinct explanation candidate.
- Keep each hypothesis under 25 words.
- Output JSON: { "hypotheses": [{ "text": string, "targetColumn"?: string }, ...] }${briefAsk}

Output STRICTLY ONE JSON object: { "hypotheses": [...], "brief": {...} | null }`;

  const briefSnippet = ctx.analysisBrief
    ? `OutcomeMetric: ${ctx.analysisBrief.outcomeMetricColumn ?? "?"} | Dimensions: ${(ctx.analysisBrief.segmentationDimensions ?? []).join(", ")}`
    : "";
  const sacSnippet = ctx.sessionAnalysisContext
    ? JSON.stringify(ctx.sessionAnalysisContext.dataset).slice(0, 800)
    : "";
  const user = [
    `Question: ${ctx.question}`,
    `Columns (${ctx.summary.columns.length} total): ${cols}`,
    `Numeric columns: ${(ctx.summary.numericColumns || []).join(", ")}`,
    `Date columns: ${(ctx.summary.dateColumns || []).join(", ")}`,
    briefSnippet ? `Existing brief snapshot: ${briefSnippet}` : "",
    sacSnippet ? `Session dataset summary: ${sacSnippet}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const result = await completeJson(system, user, mergedOutputSchema, {
    turnId: `${turnId}_merged_pre_planner`,
    maxTokens: 1600,
    temperature: 0.25,
    onLlmCall,
    purpose: LLM_PURPOSE.HYPOTHESIS,
  });
  if (!result.ok) {
    agentLog("merged_pre_planner.failed", {
      turnId,
      err: result.error.slice(0, 200),
    });
    return { ok: false };
  }

  // Apply hypotheses to blackboard.
  let hypothesesCount = 0;
  for (const h of result.data.hypotheses) {
    addHypothesis(blackboard, h.text, { targetColumn: h.targetColumn });
    hypothesesCount++;
  }

  // Apply brief if requested AND emitted. Mirror the per-task path's
  // post-processing so downstream code (planner prompt, telemetry) sees
  // the same shape.
  let briefSet = false;
  if (shouldBuildBrief && result.data.brief) {
    const merged: AnalysisBrief = mergeInferredFiltersIntoBrief(
      result.data.brief,
      ctx.inferredFilters
    );
    ctx.analysisBrief = merged;
    if (ctx.sessionAnalysisContext) {
      ctx.sessionAnalysisContext = applyAnalysisBriefDigestToSession(
        ctx.sessionAnalysisContext,
        merged
      );
    }
    briefSet = true;
  }

  agentLog("merged_pre_planner.ok", {
    turnId,
    hypothesesCount,
    briefSet,
    briefRequested: shouldBuildBrief,
  });
  return { ok: true, hypothesesCount, briefSet };
}
