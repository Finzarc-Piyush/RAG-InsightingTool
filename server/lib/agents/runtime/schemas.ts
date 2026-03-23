import { z } from "zod";

export const planStepSchema = z.object({
  id: z.string(),
  tool: z.string(),
  args: z.preprocess(
    (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {}),
    z.record(z.any())
  ),
  dependsOn: z.string().optional(),
});

export const plannerOutputSchema = z.object({
  rationale: z.string(),
  steps: z.array(planStepSchema),
});

export type PlannerOutput = z.infer<typeof plannerOutputSchema>;

export const reflectorOutputSchema = z.object({
  action: z.enum(["continue", "replan", "finish", "clarify"]),
  note: z.string().optional(),
  clarify_message: z.string().optional(),
});

export type ReflectorOutput = z.infer<typeof reflectorOutputSchema>;

export const verifierIssueSchema = z.object({
  code: z.string(),
  severity: z.enum(["low", "medium", "high"]),
  description: z.string(),
  evidence_refs: z.array(z.string()).default([]),
});

export const verifierOutputSchema = z.object({
  verdict: z.enum([
    "pass",
    "revise_narrative",
    "retry_tool",
    "replan",
    "ask_user",
    "abort_partial",
  ]),
  scores: z
    .object({
      goal_alignment: z.number().min(0).max(1).optional(),
      evidence_consistency: z.number().min(0).max(1).optional(),
      completeness: z.number().min(0).max(1).optional(),
    })
    .optional(),
  issues: z.array(verifierIssueSchema).default([]),
  course_correction: z.enum([
    "pass",
    "revise_narrative",
    "retry_tool",
    "replan",
    "ask_user",
    "abort_partial",
  ]),
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
