/**
 * Wave W6 · coordinatorAgent
 *
 * For complex questions (dashboards, multi-metric comparisons, broad analyses),
 * decomposes the root question into 2–4 parallel investigation threads. Each
 * thread becomes a root-level node in the Investigation Tree (W7+).
 *
 * Simple questions (focused on one metric or one time window) return null so
 * the single-turn path proceeds unchanged.
 *
 * Complexity scoring:
 *  - questionShape ∈ {driver_discovery, variance_diagnostic} → high
 *  - "dashboard" or "all" in question → high
 *  - multiple distinct metrics mentioned → medium
 *  - everything else → simple (return null)
 */

import { z } from "zod";
import { agentLog } from "./agentLogger.js";
import type { AgentExecutionContext } from "./types.js";
import type { AnalysisBrief } from "../../../shared/schema.js";

const decomposedThreadSchema = z.object({
  question: z.string(),
  focusColumns: z.array(z.string()).default([]),
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
  const result = await completeJson(system, user, coordinatorOutputSchema, {
    turnId: `${turnId}_coordinator`,
    maxTokens: 800,
    temperature: 0.2,
    onLlmCall,
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
  return threads;
}

/**
 * Pure complexity scorer — exported for testing without LLM.
 */
export { scoreComplexity };
