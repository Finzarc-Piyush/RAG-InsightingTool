/**
 * ============================================================================
 * coordinatorAgent.ts — splits a big question into parallel sub-investigations
 * ============================================================================
 * WHAT THIS FILE DOES
 *   Some questions are really several questions in one (e.g. "build a full
 *   dashboard", "compare regions across categories and explain the drivers").
 *   This file decides whether the user's question is COMPLEX enough to break
 *   apart, and if so asks an LLM to decompose it into 2–4 independent
 *   "investigation threads" that can each be researched on their own and, taken
 *   together, fully answer the original question. Simple questions (one metric,
 *   one dimension, one time window) return null so the normal single-turn path
 *   runs unchanged.
 *
 * WHY IT MATTERS
 *   Decomposing complex asks lets the engine parallelise work and gives each
 *   facet focused attention instead of one overloaded plan. To avoid spending an
 *   LLM call on questions that don't need it, a cheap deterministic complexity
 *   score gates the decomposition — only questions scoring above a threshold get
 *   sent to the LLM coordinator.
 *
 * KEY PIECES
 *   - decomposeQuestion — the main entry; scores complexity, and if high enough,
 *     calls the LLM to return DecomposedThread[] (or null when simple/failed).
 *   - scoreComplexity (also exported) — pure heuristic scorer: question shape,
 *     keywords like "dashboard"/"compare"/"by region", and number of
 *     segmentation dimensions. Exported so tests can run it without an LLM.
 *   - DecomposedThread / CoordinatorOutput — Zod-derived shapes of the output.
 *
 * HOW IT CONNECTS
 *   Reads AgentExecutionContext (types.js) and AnalysisBrief (shared/schema.js).
 *   Lazily imports completeJson (llmJson.js) and LLM_PURPOSE (llmCallPurpose.js).
 *   Each returned thread is meant to become a root node in the Investigation Tree.
 */

import { z } from "zod";
import { agentLog } from "./agentLogger.js";
import type { AgentExecutionContext } from "./types.js";
import type { AnalysisBrief } from "../../../shared/schema.js";

const decomposedThreadSchema = z.object({
  question: z.string(),
  focusColumns: z.array(z.string()).optional().default([]),
  rationale: z.string(),
});

const coordinatorOutputSchema = z.object({
  isComplex: z.boolean(),
  threads: z.array(decomposedThreadSchema).min(0).max(4),
  rationale: z.string(),
});

export type DecomposedThread = z.infer<typeof decomposedThreadSchema>;
export type CoordinatorOutput = z.infer<typeof coordinatorOutputSchema>;

/** Threshold: questions scoring above this get decomposed. */
const COMPLEXITY_SCORE_THRESHOLD = 2;

function scoreComplexity(ctx: AgentExecutionContext): number {
  let score = 0;
  const q = ctx.question.toLowerCase();

  const complexShapes: Array<AnalysisBrief["questionShape"]> = [
    "driver_discovery",
    "variance_diagnostic",
  ];
  if (ctx.analysisBrief?.questionShape && complexShapes.includes(ctx.analysisBrief.questionShape)) {
    score += 2;
  }

  if (/dashboard|full report|all (metrics|dimensions|categories|regions)/i.test(q)) score += 2;
  if (/compare|versus|vs\.?|contrast/i.test(q)) score += 1;
  if (/across|by (region|category|segment|channel|brand)/i.test(q)) score += 1;

  const numMetrics = (ctx.analysisBrief?.segmentationDimensions ?? []).length;
  if (numMetrics >= 3) score += 1;

  return score;
}

/**
 * Returns a list of decomposed investigation threads for complex questions,
 * or null if the question is simple enough for a single-turn plan.
 */
export async function decomposeQuestion(
  ctx: AgentExecutionContext,
  turnId: string,
  onLlmCall: () => void
): Promise<DecomposedThread[] | null> {
  if (ctx.mode !== "analysis") return null;

  const complexity = scoreComplexity(ctx);
  if (complexity < COMPLEXITY_SCORE_THRESHOLD) return null;

  const cols = ctx.summary.columns
    .slice(0, 30)
    .map((c) => `${c.name} (${c.type})`)
    .join(", ");

  const system = `You are a coordinator for a multi-agent data investigation system.
Given a complex user question, decompose it into 2 to 4 independent investigation threads
that can be researched in parallel. Each thread should:
- Focus on a distinct aspect (e.g. time trend, region breakdown, category comparison, driver analysis).
- Be answerable independently from the others.
- Together, fully answer the user's root question.

If the question is actually simple (one metric, one dimension, one time window), set
isComplex=false and threads=[].

Output JSON:
{
  "isComplex": boolean,
  "rationale": string (why you decomposed this way, or why it is simple),
  "threads": [
    { "question": string, "focusColumns": string[], "rationale": string }
  ]
}`;

  const user = `Root question: ${ctx.question}
Columns (${ctx.summary.columns.length} total): ${cols}
${ctx.analysisBrief ? `Question shape: ${ctx.analysisBrief.questionShape ?? "unknown"}` : ""}`;

  const { completeJson } = await import("./llmJson.js");
  const { LLM_PURPOSE } = await import("./llmCallPurpose.js");
  const result = await completeJson(system, user, coordinatorOutputSchema, {
    turnId: `${turnId}_coordinator`,
    maxTokens: 800,
    temperature: 0.2,
    onLlmCall,
    purpose: LLM_PURPOSE.COORDINATOR,
  });

  if (!result.ok) {
    agentLog("coordinatorAgent.failed", { turnId, error: result.error });
    return null;
  }

  const { isComplex, threads } = result.data;

  if (!isComplex || threads.length === 0) {
    agentLog("coordinatorAgent.simple", { turnId });
    return null;
  }

  agentLog("coordinatorAgent.decomposed", { turnId, threads: threads.length });
  // threads is post-validation (zod defaults applied), so focusColumns is always
  // string[] at runtime; the parse result is typed as z.input here, hence the cast.
  return threads as DecomposedThread[];
}

/**
 * Pure complexity scorer — exported for testing without LLM.
 */
export { scoreComplexity };
