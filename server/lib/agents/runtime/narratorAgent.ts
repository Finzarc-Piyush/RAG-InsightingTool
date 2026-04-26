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
import { LLM_PURPOSE } from "./llmCallPurpose.js";
import { ANALYST_PREAMBLE } from "./sharedPrompts.js";
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
  // W3 · AnswerEnvelope — optional structured rendering hints. Narrator may
  // emit any subset; the UI's AnswerCard renders whichever fields are present
  // and falls back to `body` markdown for the rest.
  tldr: z.string().max(280).optional(),
  findings: z
    .array(
      z.object({
        headline: z.string().max(200),
        evidence: z.string().max(600),
        magnitude: z.string().max(80).optional(),
      })
    )
    .max(5)
    .optional(),
  methodology: z.string().max(500).optional(),
  caveats: z.array(z.string().max(200)).max(3).optional(),
});

export type NarratorOutput = z.infer<typeof narratorOutputSchema>;

/**
 * W4 · narrator-repair branch.
 *
 * When the deep verifier returns `revise_narrative`, the agent loop hands
 * the issues + the prior draft back into runNarrator (rather than the legacy
 * rewriteNarrative path, which loses blackboard context). Both fields are
 * optional — `priorDraft` lets the model see what it said last time so it
 * can preserve good content while fixing the flagged issues.
 */
export interface NarratorRepairContext {
  issues: string;
  priorDraft?: string;
  courseCorrection?: string;
}

/**
 * Run the narrator to produce an investigation narrative from the blackboard.
 * Returns null if the LLM call fails (caller uses synthesizer fallback).
 */
export async function runNarrator(
  ctx: AgentExecutionContext,
  blackboard: AnalyticalBlackboard,
  turnId: string,
  onLlmCall: () => void,
  repair?: NarratorRepairContext
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

  // W4.2 · system is now byte-stable across calls — the phase-1 envelope
  // template is unconditionally present, and per-call questionShape is moved
  // to the user message. Combined with ANALYST_PREAMBLE this clears Azure's
  // 1024-token prefix-cache threshold.
  const system = `${ANALYST_PREAMBLE}You are a senior data analyst presenting the results of a completed investigation.
You have access to a structured blackboard: the hypotheses that were tested, their outcomes
(confirmed / refuted / partial / open), and the findings that emerged.

Your job: narrate the investigation clearly in the following JSON format:
- "body": main markdown answer. Lead with the most important finding. For each confirmed
  hypothesis, cite the supporting evidence. For refuted hypotheses, say what was ruled out.
  Do not repeat the user question verbatim.
  LENGTH: aim for 250–600 words for analytical questions, 80–150 words for simple/conversational
  questions. Do not pad. Do not bullet-spam — prefer 2–4 paragraphs of grounded prose.
- "keyInsight": 1–3 sentences on what the findings imply for decisions (the "so what").
  Use null if nothing beyond the body adds value.
- "ctas": 0 to 3 actionable follow-up prompts (empty array if none fit).
- Do NOT invent numbers not present in the findings. If a hypothesis has no evidence, say
  it remains open and explain why.

W3 · AnswerEnvelope — REQUIRED for analytical questions, omit each field independently
when not applicable:
- "tldr": ≤280 chars, ONE sentence that states the headline answer up-front. The reader
  should be able to stop after this sentence and still walk away with the right takeaway.
- "findings": 2–5 ordered entries, each {headline (≤200 chars), evidence (≤600 chars),
  magnitude?}. The headline is the claim; the evidence is the data that backs it
  (cite numbers from the blackboard verbatim); the magnitude is the single most
  important number in human-readable form (e.g. "+12.4% YoY", "$3.2M shortfall").
- "methodology": ≤500 chars on what tools / data / time-window were used. Plain prose,
  no JSON. Helps the reader judge the answer's reliability.
- "caveats": 0–3 short bullets on what limits the conclusion (sample-size,
  missing-data, ambiguous definitions, etc.). Omit when nothing material is missing.

Phase-1 rich envelope — REQUIRED whenever the user message declares a non-empty questionShape:
- "magnitudes": 2–4 entries that back your main claim. Each: {label, value, confidence?}. MUST come from findings — never invent.
- "unexplained": one sentence (≤180 chars) on what could NOT be determined. Omit if nothing material is missing.
When the user message says "questionShape: none" you may omit magnitudes and unexplained.`;

  const phase1Line = phase1Shape
    ? `questionShape: ${phase1Shape}\n`
    : `questionShape: none\n`;
  // W4 · when re-invoked after a verifier `revise_narrative` verdict, append
  // the issues + course correction + prior draft so the model can do a
  // grounded rewrite instead of starting blind. Cap at 4000 chars to keep
  // the user prompt within the existing budget.
  const repairBlock = repair
    ? `\n\nVerifier flagged issues with the previous draft. Address them:\nIssues: ${repair.issues.slice(0, 1500)}${
        repair.courseCorrection ? `\nCourse correction: ${repair.courseCorrection.slice(0, 500)}` : ""
      }${
        repair.priorDraft ? `\n\nPrior draft (rewrite, do not repeat verbatim):\n${repair.priorDraft.slice(0, 2000)}` : ""
      }`
    : "";
  const user = `${phase1Line}Question: ${ctx.question}${permBlock}${sacBlock}\n\n${blackboardBlock}${repairBlock}`;

  const result = await completeJson(system, user, narratorOutputSchema, {
    turnId: `${turnId}_narrator${repair ? "_repair" : ""}`,
    // W3 · 2600 → 4000. Claude Opus 4.7 (and GPT-4o) have plenty of headroom
    // for the structured envelope plus 2–4 paragraphs; the previous cap was
    // sometimes hit on richer investigations and silently truncated findings.
    maxTokens: 4000,
    temperature: 0.25,
    onLlmCall,
    purpose: LLM_PURPOSE.NARRATOR,
  });

  if (!result.ok) {
    agentLog("narratorAgent.failed", { turnId, error: result.error, repair: !!repair });
    return null;
  }

  agentLog(repair ? "narratorAgent.repair" : "narratorAgent.done", {
    turnId,
    hypotheses: blackboard.hypotheses.length,
    findings: blackboard.findings.length,
    repair: !!repair,
  });

  return result.data;
}
