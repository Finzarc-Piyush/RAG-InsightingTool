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
});

export const plannerOutputSchema = z.object({
  rationale: z.string(),
  steps: z.array(planStepSchema),
});

export type PlannerOutput = z.infer<typeof plannerOutputSchema>;

export const spawnedQuestionSchema = z.object({
  question: z.string(),
  spawnReason: z.string(),
  priority: z.enum(["high", "medium", "low"]),
  suggestedColumns: z.array(z.string()).default([]),
});

export const reflectorOutputSchema = z.object({
  action: z.enum(["continue", "replan", "finish", "clarify"]),
  note: z.string().optional(),
  clarify_message: z.string().optional(),
  /**
   * W8: sub-questions to spawn when an anomalous or surprising finding
   * warrants deeper investigation. Only populated when action="finish"
   * and a concrete unexpected pattern was found. Empty otherwise.
   */
  spawnedQuestions: z.array(spawnedQuestionSchema).default([]),
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
