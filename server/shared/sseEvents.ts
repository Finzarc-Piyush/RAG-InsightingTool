/**
 * Wave W6 · typed SSE event contract.
 *
 * Single source of truth for the events the chat-stream endpoint can emit.
 * Every event has a Zod schema so:
 *   - The server can validate payloads in dev (warn-and-pass) before they go
 *     out the wire, catching shape regressions at the emit call site instead
 *     of silently in the client.
 *   - The client can validate inbound events on receive (warn-and-discard
 *     malformed) instead of relying on `as any` casts and runtime crashes.
 *
 * All schemas are intentionally LENIENT (`.passthrough()` where useful) so
 * adding a new field to an emit site is non-breaking; only changing the type
 * or removing a required field surfaces as a validation warning. This keeps
 * the contract a check, not a straitjacket.
 *
 * To extend the contract: add a kind to `SSE_EVENT_KIND`, add an entry to
 * `sseEventSchemas`, and (optionally) update the test in
 * `server/tests/sseContract.test.ts`.
 */

import { z } from "zod";

export const SSE_EVENT_KIND = {
  QUEUED: "queued",
  INTENT_PARSED: "intent_parsed",
  PLAN: "plan",
  PARALLEL_GROUP_RESOLVED: "parallel_group_resolved",
  TOOL_CALL: "tool_call",
  TOOL_RESULT: "tool_result",
  WORKBENCH: "workbench",
  CRITIC_VERDICT: "critic_verdict",
  SKILL_EXECUTION: "skill_execution",
  SKILL_PARALLEL_BATCH: "skill_parallel_batch",
  SUB_QUESTION_SPAWNED: "sub_question_spawned",
  MAGNITUDES: "magnitudes",
  UNEXPLAINED: "unexplained",
  DASHBOARD_DRAFT: "dashboard_draft",
  DASHBOARD_CREATED: "dashboard_created",
  CACHE_HIT: "cache_hit",
  INTERMEDIATE: "intermediate",
  RESPONSE: "response",
  RESPONSE_CHARTS: "response_charts",
  DONE: "done",
  ERROR: "error",
} as const;

export type SseEventKind = (typeof SSE_EVENT_KIND)[keyof typeof SSE_EVENT_KIND];

// ── Per-event schemas ──────────────────────────────────────────────────────
//
// Each schema describes the MINIMUM shape required for the client to render
// the event correctly. Use `.passthrough()` so the server can extend payloads
// (e.g. add provenance / telemetry) without a coordinated client release.

const queuedSchema = z
  .object({
    sessionId: z.string().optional(),
    queuedAt: z.number().optional(),
  })
  .passthrough();

const intentParsedSchema = z
  .object({
    mode: z.string().optional(),
    intent: z.string().optional(),
  })
  .passthrough();

const planSchema = z
  .object({
    steps: z.array(z.unknown()).optional(),
    rationale: z.string().optional(),
  })
  .passthrough();

const parallelGroupResolvedSchema = z
  .object({
    group_id: z.string().optional(),
    branches: z.number().optional(),
  })
  .passthrough();

const toolCallSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    args_summary: z.string().optional(),
  })
  .passthrough();

const toolResultSchema = z
  .object({
    id: z.string().optional(),
    ok: z.boolean().optional(),
    summary: z.string().optional(),
  })
  .passthrough();

const workbenchEntrySchema = z
  .object({
    id: z.string(),
    kind: z.string(),
    title: z.string().optional(),
    code: z.string().optional(),
    language: z.string().optional(),
  })
  .passthrough();

const workbenchSchema = z
  .object({
    entry: workbenchEntrySchema,
  })
  .passthrough();

const criticVerdictSchema = z
  .object({
    stepId: z.string().optional(),
    verdict: z.string(),
    issue_codes: z.array(z.string()).optional(),
    course_correction: z.string().nullable().optional(),
  })
  .passthrough();

const skillExecutionSchema = z
  .object({
    skill: z.string(),
    status: z.string().optional(),
  })
  .passthrough();

const skillParallelBatchSchema = z
  .object({
    skills: z.array(z.string()),
  })
  .passthrough();

const subQuestionSpawnedSchema = z
  .object({
    questions: z.array(z.string()),
  })
  .passthrough();

const magnitudesSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            label: z.string(),
            value: z.string(),
            confidence: z.enum(["low", "medium", "high"]).optional(),
          })
          .passthrough()
      )
      .max(8),
  })
  .passthrough();

const unexplainedSchema = z
  .object({
    note: z.string(),
  })
  .passthrough();

const dashboardDraftSchema = z
  .object({
    spec: z.unknown(),
  })
  .passthrough();

const dashboardCreatedSchema = z
  .object({
    dashboardId: z.string(),
    name: z.string().optional(),
    sheetCount: z.number().int().nonnegative().optional(),
    chartCount: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const cacheHitSchema = z
  .object({
    source: z.string().optional(),
    ageMs: z.number().optional(),
  })
  .passthrough();

const intermediateSchema = z.object({}).passthrough();

const responseSchema = z
  .object({
    answer: z.string().optional(),
    charts: z.array(z.unknown()).optional(),
  })
  .passthrough();

const responseChartsSchema = z
  .object({
    charts: z.array(z.unknown()),
  })
  .passthrough();

const doneSchema = z
  .object({
    success: z.boolean().optional(),
  })
  .passthrough();

const errorSchema = z
  .object({
    error: z.string(),
    code: z.string().optional(),
  })
  .passthrough();

export const sseEventSchemas: Record<SseEventKind, z.ZodTypeAny> = {
  [SSE_EVENT_KIND.QUEUED]: queuedSchema,
  [SSE_EVENT_KIND.INTENT_PARSED]: intentParsedSchema,
  [SSE_EVENT_KIND.PLAN]: planSchema,
  [SSE_EVENT_KIND.PARALLEL_GROUP_RESOLVED]: parallelGroupResolvedSchema,
  [SSE_EVENT_KIND.TOOL_CALL]: toolCallSchema,
  [SSE_EVENT_KIND.TOOL_RESULT]: toolResultSchema,
  [SSE_EVENT_KIND.WORKBENCH]: workbenchSchema,
  [SSE_EVENT_KIND.CRITIC_VERDICT]: criticVerdictSchema,
  [SSE_EVENT_KIND.SKILL_EXECUTION]: skillExecutionSchema,
  [SSE_EVENT_KIND.SKILL_PARALLEL_BATCH]: skillParallelBatchSchema,
  [SSE_EVENT_KIND.SUB_QUESTION_SPAWNED]: subQuestionSpawnedSchema,
  [SSE_EVENT_KIND.MAGNITUDES]: magnitudesSchema,
  [SSE_EVENT_KIND.UNEXPLAINED]: unexplainedSchema,
  [SSE_EVENT_KIND.DASHBOARD_DRAFT]: dashboardDraftSchema,
  [SSE_EVENT_KIND.DASHBOARD_CREATED]: dashboardCreatedSchema,
  [SSE_EVENT_KIND.CACHE_HIT]: cacheHitSchema,
  [SSE_EVENT_KIND.INTERMEDIATE]: intermediateSchema,
  [SSE_EVENT_KIND.RESPONSE]: responseSchema,
  [SSE_EVENT_KIND.RESPONSE_CHARTS]: responseChartsSchema,
  [SSE_EVENT_KIND.DONE]: doneSchema,
  [SSE_EVENT_KIND.ERROR]: errorSchema,
};

export type SseValidateResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string; data: unknown };

/**
 * Validate an SSE event payload against the registered schema.
 *
 * - Unknown event kinds pass through with `ok: true` (we don't yet know about
 *   every event the codebase will emit; better not-strict than strict-and-wrong).
 * - Known event kinds with shape mismatches return `ok: false` so the caller
 *   can log a structured warning and decide whether to drop or pass.
 *
 * Servers should call this in dev only (sendSSE wraps it). Clients can call
 * it on every inbound event regardless of environment — discarding malformed
 * payloads beats crashing the chat.
 */
export function validateSseEvent(name: string, data: unknown): SseValidateResult {
  const schema = sseEventSchemas[name as SseEventKind];
  if (!schema) {
    // Unknown event — pass through so adding a new kind never blocks.
    return { ok: true, data };
  }
  const parsed = schema.safeParse(data);
  if (parsed.success) {
    return { ok: true, data: parsed.data };
  }
  return { ok: false, error: parsed.error.message, data };
}

/** Type guard for the registered event-kind enum. */
export function isKnownSseEventKind(name: string): name is SseEventKind {
  return Object.prototype.hasOwnProperty.call(sseEventSchemas, name);
}
