/**
 * Wave W5 · narratorAgent
 *
 * Evidence-based synthesis from the analytical blackboard. Replaces the raw
 * observations dump when the blackboard has findings. The narrator reads the
 * structured hypothesis outcomes and findings and writes an investigation
 * narrative: what was tested, what was found, what it means for the business.
 *
 * When the blackboard is empty (dataOps turns, or hypothesis planner was
 * skipped), the caller falls back to the existing synthesizeFinalAnswerEnvelope.
 */

import { z } from "zod";
import { completeJson } from "./llmJson.js";
import { agentLog } from "./agentLogger.js";
import {
  formatForNarrator,
  type AnalyticalBlackboard,
} from "./analyticalBlackboard.js";
import type { AgentExecutionContext } from "./types.js";

export { shouldUseNarrator } from "./analyticalBlackboard.js";

const narratorOutputSchema = z.object({
  body: z.string(),
  keyInsight: z.string().nullable().optional(),
  ctas: z.array(z.string()).default([]),
  /** 2–4 entries backing the main claim: {label, value, confidence?} */
  magnitudes: z
    .array(
      z.object({
        label: z.string(),
        value: z.string(),
        confidence: z.enum(["low", "medium", "high"]).optional(),
      })
    )
    .optional(),
  unexplained: z.string().optional(),
});

export type NarratorOutput = z.infer<typeof narratorOutputSchema>;

/**
 * Run the narrator to produce an investigation narrative from the blackboard.
 * Returns null if the LLM call fails (caller uses synthesizer fallback).
 */
export async function runNarrator(
  ctx: AgentExecutionContext,
  blackboard: AnalyticalBlackboard,
  turnId: string,
  onLlmCall: () => void
): Promise<NarratorOutput | null> {
  const blackboardBlock = formatForNarrator(blackboard);
  if (!blackboardBlock.trim()) return null;

  const sacBlock = ctx.sessionAnalysisContext
    ? `\n\nSessionContext:\n${JSON.stringify(ctx.sessionAnalysisContext).slice(0, 6000)}`
    : "";
  const permBlock = ctx.permanentContext?.trim().length
    ? `\n\nUser notes:\n${ctx.permanentContext.trim().slice(0, 2000)}`
    : "";
  const phase1Shape = ctx.analysisBrief?.questionShape;
  const phase1Block = phase1Shape
    ? `\n\nPhase-1 rich envelope (REQUIRED when questionShape is set):
- "magnitudes": 2–4 entries that back your main claim. Each: {label, value, confidence?}. MUST come from findings — never invent.
- "unexplained": one sentence (≤180 chars) on what could NOT be determined. Omit if nothing material is missing.
Current questionShape: ${phase1Shape}.`
    : "";

  const system = `You are a senior data analyst presenting the results of a completed investigation.
You have access to a structured blackboard: the hypotheses that were tested, their outcomes
(confirmed / refuted / partial / open), and the findings that emerged.

Your job: narrate the investigation clearly and concisely in the following JSON format:
- "body": main markdown answer. Lead with the most important finding. For each confirmed
  hypothesis, cite the supporting evidence. For refuted hypotheses, say what was ruled out.
  Do not repeat the user question verbatim. Keep to 2–4 paragraphs.
- "keyInsight": 1–3 sentences on what the findings imply for decisions (the "so what").
  Use null if nothing beyond the body adds value.
- "ctas": 0 to 3 actionable follow-up prompts (empty array if none fit).
- Do NOT invent numbers not present in the findings. If a hypothesis has no evidence, say
  it remains open and explain why.${phase1Block}`;

  const user = `Question: ${ctx.question}${permBlock}${sacBlock}\n\n${blackboardBlock}`;

  const result = await completeJson(system, user, narratorOutputSchema, {
    turnId: `${turnId}_narrator`,
    maxTokens: 2600,
    temperature: 0.25,
    onLlmCall,
  });

  if (!result.ok) {
    agentLog("narratorAgent.failed", { turnId, error: result.error });
    return null;
  }

  agentLog("narratorAgent.done", {
    turnId,
    hypotheses: blackboard.hypotheses.length,
    findings: blackboard.findings.length,
  });

  return result.data;
}
