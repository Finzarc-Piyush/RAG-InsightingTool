/**
 * Wave W3 · hypothesisPlanner
 *
 * Runs before the main planner. Given the user question, schema summary,
 * and session context, generates 3–5 testable hypotheses that bound the
 * upcoming investigation. Writes them to the blackboard and returns a
 * formatted block for injection into the planner prompt.
 */

import { z } from "zod";
import { completeJson } from "./llmJson.js";
import { LLM_PURPOSE } from "./llmCallPurpose.js";
import { ANALYST_PREAMBLE } from "./sharedPrompts.js";
import { agentLog } from "./agentLogger.js";
import {
  addHypothesis,
  formatForPlanner,
  type AnalyticalBlackboard,
} from "./analyticalBlackboard.js";
import type { AgentExecutionContext } from "./types.js";

const hypothesisItemSchema = z.object({
  text: z.string(),
  targetColumn: z.string().optional(),
});

const hypothesisOutputSchema = z.object({
  hypotheses: z.array(hypothesisItemSchema).min(1).max(6),
});

type HypothesisOutput = z.infer<typeof hypothesisOutputSchema>;

function buildUserBlock(ctx: AgentExecutionContext): string {
  const cols = ctx.summary.columns
    .slice(0, 40)
    .map((c) => `${c.name} (${c.type})`)
    .join(", ");
  const sacSnippet = ctx.sessionAnalysisContext?.sessionContext
    ? ctx.sessionAnalysisContext.sessionContext.slice(0, 800)
    : "";
  const briefSnippet = ctx.analysisBrief
    ? `OutcomeMetric: ${ctx.analysisBrief.outcomeMetricColumn ?? "?"} | Dimensions: ${(ctx.analysisBrief.segmentationDimensions ?? []).join(", ")}`
    : "";
  return [
    `Question: ${ctx.question}`,
    `Columns (${ctx.summary.columns.length} total): ${cols}`,
    briefSnippet ? `Analysis brief: ${briefSnippet}` : "",
    sacSnippet ? `Session context (excerpt): ${sacSnippet}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Generate 3–5 testable hypotheses for the given question and write them to
 * the blackboard. Returns true on success; false if the LLM call failed
 * (caller continues without hypotheses — planner still works).
 */
export async function generateHypotheses(
  ctx: AgentExecutionContext,
  blackboard: AnalyticalBlackboard,
  turnId: string,
  onLlmCall: () => void
): Promise<boolean> {
  // W4.2 · ANALYST_PREAMBLE prefix → cache eligibility (>1024 tokens). System
  // is purely static; the per-turn dataset/question/brief lives in user via
  // buildUserBlock(ctx).
  const system = `${ANALYST_PREAMBLE}You are an investigation planner for a data analysis assistant.
Given a user question and dataset schema, generate 3 to 5 concise testable hypotheses
that would, if confirmed or refuted by the data, fully explain the user's question.

Rules:
- Each hypothesis MUST be falsifiable by querying the data (a simple aggregation, breakdown, or correlation).
- Focus on specific dimensions, metrics, or time windows visible in the schema.
- Do not repeat the question — each hypothesis should be a distinct explanation candidate.
- Keep each hypothesis under 25 words.
- If the question is purely operational (add a column, rename a sheet, etc.), output a single
  hypothesis: "User request is a data operation with no analytical hypothesis needed."
- Output JSON: {"hypotheses": [{"text": string, "targetColumn"?: string}]}`;

  const user = buildUserBlock(ctx);
  const result = await completeJson(system, user, hypothesisOutputSchema, {
    maxTokens: 512,
    temperature: 0.3,
    turnId,
    onLlmCall,
    purpose: LLM_PURPOSE.HYPOTHESIS,
  });

  if (!result.ok) {
    agentLog("hypothesisPlanner.failed", { turnId, error: result.error });
    return false;
  }

  const { hypotheses } = result.data as HypothesisOutput;
  for (const h of hypotheses) {
    addHypothesis(blackboard, h.text, { targetColumn: h.targetColumn });
  }

  agentLog("hypothesisPlanner.done", { turnId, count: hypotheses.length });
  return true;
}

