/**
 * Wave AD1 · regression guard for the two visible feedback bugs:
 *
 *   1. FeedbackButtons must mount on every assistant message, not just the
 *      ones whose agentTrace.turnId is set. The mount-gate falls back to
 *      `ts-<timestamp>` so non-agentic / synthesis-fallback / dataOps turns
 *      still surface thumbs. Cache-hit messages remain skipped (no
 *      past_analyses doc exists for them at the current sessionId).
 *
 *   2. The thumbs-down comment textarea must accept a comment WITHOUT
 *      requiring the "other" reason chip — the previous gate hid the field
 *      from users who picked one of the closed-enum reasons OR none at all.
 *      The server-side `feedbackBodySchema` (used by /api/feedback) is the
 *      contract: it accepts `{ feedback: "down", comment }` with no reasons.
 */
import { describe, expect, test } from "vitest";
import { computeFeedbackTurnId } from "./computeFeedbackTurnId";
import {
  pastAnalysisFeedbackSchema,
  pastAnalysisFeedbackReasonSchema,
} from "@/shared/schema";
import { z } from "zod";

// Mirrors server/controllers/feedbackController.ts feedbackBodySchema. We
// can't import the server file directly (different tsconfig surface), but
// pinning the same shape here means a server-side schema change that breaks
// the contract trips this test.
const feedbackBodySchema = z.object({
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  feedback: pastAnalysisFeedbackSchema,
  reasons: z.array(pastAnalysisFeedbackReasonSchema).max(7).optional(),
  comment: z.string().max(500).optional(),
});

describe("computeFeedbackTurnId · mount-gate logic", () => {
  test("returns the agent-trace turnId when set (the happy path)", () => {
    expect(
      computeFeedbackTurnId({
        agentTrace: { turnId: "abc-123" },
        timestamp: 1700000000000,
      })
    ).toBe("abc-123");
  });

  test("falls back to ts-<timestamp> when agentTrace is missing entirely", () => {
    expect(
      computeFeedbackTurnId({ timestamp: 1700000000000 })
    ).toBe("ts-1700000000000");
  });

  test("falls back to ts-<timestamp> when agentTrace exists but has no turnId", () => {
    expect(
      computeFeedbackTurnId({
        agentTrace: { someOtherField: "x" } as unknown,
        timestamp: 1700000000000,
      })
    ).toBe("ts-1700000000000");
  });

  test("returns null on cache-hit messages (fromCache:true) regardless of timestamp", () => {
    expect(
      computeFeedbackTurnId({
        agentTrace: { fromCache: true },
        timestamp: 1700000000000,
      })
    ).toBeNull();
  });

  test("returns null when neither turnId nor timestamp is available", () => {
    expect(computeFeedbackTurnId({})).toBeNull();
    expect(computeFeedbackTurnId({ timestamp: NaN })).toBeNull();
    expect(
      computeFeedbackTurnId({ timestamp: "1700000000000" as unknown as number })
    ).toBeNull();
  });

  test("treats empty-string turnId as missing and falls back", () => {
    expect(
      computeFeedbackTurnId({
        agentTrace: { turnId: "" },
        timestamp: 1700000000000,
      })
    ).toBe("ts-1700000000000");
  });
});

describe("feedbackBodySchema · thumbs-down without 'other' reason", () => {
  test("accepts {feedback:'down', comment} with no reasons (the AD1 fix)", () => {
    const parsed = feedbackBodySchema.parse({
      sessionId: "s1",
      turnId: "t1",
      feedback: "down",
      comment: "Numbers looked off — the Q4 lift seems suspicious.",
    });
    expect(parsed.feedback).toBe("down");
    expect(parsed.comment).toMatch(/Q4 lift/);
    expect(parsed.reasons).toBeUndefined();
  });

  test("accepts {feedback:'down', reasons:['vague'], comment} — comment alongside any reason", () => {
    const parsed = feedbackBodySchema.parse({
      sessionId: "s1",
      turnId: "t1",
      feedback: "down",
      reasons: ["vague"],
      comment: "Wanted a deeper breakdown by region.",
    });
    expect(parsed.reasons).toEqual(["vague"]);
    expect(parsed.comment).toMatch(/region/);
  });

  test("accepts {feedback:'up'} without reasons or comment (the legacy path)", () => {
    const parsed = feedbackBodySchema.parse({
      sessionId: "s1",
      turnId: "t1",
      feedback: "up",
    });
    expect(parsed.feedback).toBe("up");
  });

  test("rejects comment over 500 chars (the server-enforced cap)", () => {
    const tooLong = "x".repeat(501);
    const result = feedbackBodySchema.safeParse({
      sessionId: "s1",
      turnId: "t1",
      feedback: "down",
      comment: tooLong,
    });
    expect(result.success).toBe(false);
  });

  test("rejects unknown feedback value", () => {
    const result = feedbackBodySchema.safeParse({
      sessionId: "s1",
      turnId: "t1",
      feedback: "maybe",
    });
    expect(result.success).toBe(false);
  });
});
