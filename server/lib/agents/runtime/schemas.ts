/**
 * ============================================================================
 * schemas.ts — the data shapes (validators) for everything the agent's brain
 * passes around
 * ============================================================================
 * WHAT THIS FILE DOES
 *   This file defines the "shapes" of the structured messages the agentic loop
 *   produces and consumes, using Zod (a runtime validator: you describe the
 *   shape once and get both a TypeScript type AND a parser that rejects bad
 *   data). It covers the planner's output (a list of tool steps), the
 *   reflector's decision (continue / replan / finish / clarify / investigate a
 *   gap), the verifier's verdict and issues, and the lightweight event payloads
 *   that get streamed to the UI and saved into the turn's trace.
 *
 * WHY IT MATTERS
 *   These schemas are the contracts between the LLM-driven stages. Because each
 *   LLM reply is parsed against a schema, a malformed or hallucinated response
 *   is caught at the boundary instead of corrupting the loop downstream. The
 *   `VERIFIER_VERDICT` constants are the single source of truth for verdict
 *   strings — callers must reference them (never raw string literals) so a typo
 *   becomes a compile error rather than a silently-missed retry branch.
 *
 * KEY PIECES
 *   - planStepSchema / plannerOutputSchema — a planner step (tool + args + deps) and the full plan
 *   - reflectorOutputSchema — the reflector's next-action decision + spawned sub-questions + gap-fill
 *   - VERIFIER_VERDICT + verifierOutputSchema — verdict constants and the verifier's structured output
 *   - agent*EventSchema / agentTraceBlobSchema — SSE event + persisted trace shapes
 *
 * HOW IT CONNECTS
 *   Imported across the runtime — the planner, reflector, verifier, and the
 *   agent loop (agentLoop.service.ts) parse their LLM outputs and emit SSE rows
 *   using these shapes. Keep `VERIFIER_VERDICT` and its zod enum tuple in
 *   lockstep (the type system flags drift).
 */
import { z } from "zod";

export const planStepSchema = z.object({
  id: z.string(),
  tool: z.string(),
  args: z.preprocess(
    (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {}),
    z.record(z.any())
  ),
  dependsOn: z.string().optional(),
  /** Steps sharing the same parallelGroup execute concurrently when no dependsOn links exist. */
  parallelGroup: z.string().optional(),
  /** ID of the hypothesis (from INVESTIGATION_HYPOTHESES) this step primarily tests. */
  hypothesisId: z.string().optional(),
});

export const plannerOutputSchema = z.object({
  rationale: z.string(),
  steps: z.array(planStepSchema),
});

export type PlannerOutput = z.infer<typeof plannerOutputSchema>;

export const spawnedQuestionSchema = z.object({
  /**
   * Stable id (UUID) generated when the reflector emits this question. Lets the
   * UI attach per-sub-question feedback that survives reorders and edits.
   * Optional in the schema for back-compat with persisted reflector output —
   * the agent loop fills missing ids in before the SSE event fires.
   */
  id: z.string().optional(),
  question: z.string(),
  spawnReason: z.string(),
  priority: z.enum(["high", "medium", "low"]),
  suggestedColumns: z.array(z.string()).default([]),
});

/**
 * Intra-node gap-fill tool call for the investigate_gap action.
 * Points to a specific open hypothesis and the tool to run to address it.
 */
export const gapFillSchema = z.object({
  hypothesisId: z.string(),
  tool: z.string(),
  rationale: z.string(),
  // Real tool args (e.g. {question_override:…} for run_analytical_query).
  // When absent the agent loop derives a question_override from hypothesis.text.
  args: z.record(z.unknown()).optional(),
});

export const reflectorOutputSchema = z.object({
  action: z.enum(["continue", "replan", "finish", "clarify", "investigate_gap"]),
  note: z.string().optional(),
  clarify_message: z.string().optional(),
  /**
   * Sub-questions to spawn when an anomalous or surprising finding
   * warrants deeper investigation. Only populated when action="finish"
   * and a concrete unexpected pattern was found. Empty otherwise.
   */
  spawnedQuestions: z.array(spawnedQuestionSchema).default([]),
  /**
   * Populated when action="investigate_gap" — identifies which open
   * hypothesis still has no evidence and which tool should address it.
   */
  gapFill: gapFillSchema.optional(),
});

export type ReflectorOutput = z.infer<typeof reflectorOutputSchema>;

export const verifierIssueSchema = z.object({
  code: z.string(),
  severity: z.enum(["low", "medium", "high"]),
  description: z.string(),
  evidence_refs: z.array(z.string()).default([]),
});

/**
 * Single source of truth for verifier verdict strings. Keep the
 * `VERIFIER_VERDICT` object and the zod enum tuple in lockstep — the
 * type system will flag any drift. Callers that compare verdict
 * values (`agentLoop.service.ts`) MUST reference `VERIFIER_VERDICT.*`
 * rather than string literals so a typo is a compile error, not a
 * silently-missed retry branch.
 */
export const VERIFIER_VERDICT = {
  pass: "pass",
  reviseNarrative: "revise_narrative",
  retryTool: "retry_tool",
  replan: "replan",
  askUser: "ask_user",
  abortPartial: "abort_partial",
} as const;

export type VerifierVerdict =
  (typeof VERIFIER_VERDICT)[keyof typeof VERIFIER_VERDICT];

const verifierVerdictValues = [
  VERIFIER_VERDICT.pass,
  VERIFIER_VERDICT.reviseNarrative,
  VERIFIER_VERDICT.retryTool,
  VERIFIER_VERDICT.replan,
  VERIFIER_VERDICT.askUser,
  VERIFIER_VERDICT.abortPartial,
] as const;

export const verifierOutputSchema = z.object({
  verdict: z.enum(verifierVerdictValues),
  scores: z
    .object({
      goal_alignment: z.number().min(0).max(1).optional(),
      evidence_consistency: z.number().min(0).max(1).optional(),
      completeness: z.number().min(0).max(1).optional(),
    })
    .optional(),
  issues: z.array(verifierIssueSchema).default([]),
  course_correction: z.enum(verifierVerdictValues),
  user_visible_note: z.string().optional(),
});

export type VerifierOutputJson = z.infer<typeof verifierOutputSchema>;

/** SSE payloads (subset persisted in trace) */
export const agentPlanEventSchema = z.object({
  rationale: z.string(),
  steps: z.array(
    z.object({
      id: z.string(),
      tool: z.string(),
      args_summary: z.string().optional(),
    })
  ),
});

export const agentToolCallEventSchema = z.object({
  id: z.string(),
  name: z.string(),
  args_summary: z.string(),
});

export const agentToolResultEventSchema = z.object({
  id: z.string(),
  ok: z.boolean(),
  summary: z.string(),
  preview: z.string().optional(),
});

export const agentCriticVerdictEventSchema = z.object({
  stepId: z.string(),
  verdict: z.string(),
  issue_codes: z.array(z.string()),
  course_correction: z.string(),
});

export const agentTraceBlobSchema = z.object({
  turnId: z.string(),
  planRationale: z.string().optional(),
  toolCalls: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      ok: z.boolean(),
      resultSummary: z.string().optional(),
    })
  ),
  criticRounds: z.array(
    z.object({
      stepId: z.string(),
      verdict: z.string(),
      issueCodes: z.array(z.string()),
    })
  ),
});
