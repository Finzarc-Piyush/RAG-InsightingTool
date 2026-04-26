import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  pastAnalysisDocSchema,
  pastAnalysisToolCallSchema,
  pastAnalysisOutcomeSchema,
  pastAnalysisFeedbackSchema,
  type PastAnalysisDoc,
} from "../shared/schema.js";

/**
 * W2.1 · The `past_analyses` Cosmos doc shape is the contract between the
 * chat-stream writer (W2.3), the AI Search indexer (W2.4), the semantic
 * cache (W5.*), and the budget / feedback UI (W5.5). Every field matters.
 */

const validDoc = (overrides: Partial<PastAnalysisDoc> = {}): PastAnalysisDoc => ({
  id: "session_abc__turn_001",
  sessionId: "session_abc",
  userId: "user@example.com",
  turnId: "turn_001",
  dataVersion: 1,
  question: "What is the sales trend over time?",
  normalizedQuestion: "what is the sales trend over time",
  answer: "Sales rose 12% Q1→Q3 driven by West region.",
  charts: [],
  toolCalls: [],
  costUsd: 0.0825,
  latencyMs: 14_231,
  tokenTotals: { input: 42_000, output: 5_100 },
  outcome: "ok",
  feedback: "none",
  createdAt: 1_773_000_000_000,
  ...overrides,
});

describe("pastAnalysisDocSchema", () => {
  it("accepts a fully-populated valid doc", () => {
    const r = pastAnalysisDocSchema.safeParse(validDoc());
    assert.strictEqual(r.success, true);
  });

  it("defaults toolCalls to empty array when omitted", () => {
    const { toolCalls: _discard, ...rest } = validDoc();
    const r = pastAnalysisDocSchema.parse(rest);
    assert.deepStrictEqual(r.toolCalls, []);
  });

  it("defaults feedback to 'none' when omitted", () => {
    const { feedback: _discard, ...rest } = validDoc();
    const r = pastAnalysisDocSchema.parse(rest);
    assert.strictEqual(r.feedback, "none");
  });

  it("rejects negative costUsd", () => {
    const r = pastAnalysisDocSchema.safeParse(validDoc({ costUsd: -1 }));
    assert.strictEqual(r.success, false);
  });

  it("rejects negative latencyMs", () => {
    const r = pastAnalysisDocSchema.safeParse(validDoc({ latencyMs: -5 }));
    assert.strictEqual(r.success, false);
  });

  it("rejects negative tokenTotals.input / output", () => {
    assert.strictEqual(
      pastAnalysisDocSchema.safeParse(
        validDoc({ tokenTotals: { input: -1, output: 5 } })
      ).success,
      false
    );
    assert.strictEqual(
      pastAnalysisDocSchema.safeParse(
        validDoc({ tokenTotals: { input: 5, output: -1 } })
      ).success,
      false
    );
  });

  it("rejects non-integer / fractional dataVersion", () => {
    assert.strictEqual(
      pastAnalysisDocSchema.safeParse(validDoc({ dataVersion: 1.5 })).success,
      false
    );
  });

  it("rejects negative dataVersion", () => {
    assert.strictEqual(
      pastAnalysisDocSchema.safeParse(validDoc({ dataVersion: -1 })).success,
      false
    );
  });

  it("rejects missing required fields (id, sessionId, userId, turnId, question, answer)", () => {
    for (const field of ["id", "sessionId", "userId", "turnId", "question", "answer"] as const) {
      const doc = validDoc();
      // @ts-expect-error — deliberately removing a required key
      delete doc[field];
      assert.strictEqual(
        pastAnalysisDocSchema.safeParse(doc).success,
        false,
        `expected missing ${field} to fail validation`
      );
    }
  });

  it("accepts all four outcome values", () => {
    for (const outcome of ["ok", "verifier_failed", "budget_exceeded", "tool_error"] as const) {
      const r = pastAnalysisDocSchema.safeParse(validDoc({ outcome }));
      assert.strictEqual(r.success, true, `outcome '${outcome}' must validate`);
    }
  });

  it("rejects an unknown outcome string", () => {
    const r = pastAnalysisDocSchema.safeParse(validDoc({ outcome: "mystery" as never }));
    assert.strictEqual(r.success, false);
  });

  it("accepts all three feedback values", () => {
    for (const feedback of ["up", "down", "none"] as const) {
      const r = pastAnalysisDocSchema.safeParse(validDoc({ feedback }));
      assert.strictEqual(r.success, true);
    }
  });
});

describe("pastAnalysisToolCallSchema", () => {
  it("accepts a minimal tool call", () => {
    const r = pastAnalysisToolCallSchema.safeParse({
      id: "call_1",
      tool: "execute_query_plan",
      argsHash: "abc123",
      ok: true,
    });
    assert.strictEqual(r.success, true);
  });

  it("rejects missing id / tool / argsHash / ok", () => {
    for (const field of ["id", "tool", "argsHash", "ok"] as const) {
      const base = { id: "c", tool: "t", argsHash: "h", ok: true };
      // @ts-expect-error — deliberately removing required key
      delete base[field];
      assert.strictEqual(
        pastAnalysisToolCallSchema.safeParse(base).success,
        false,
        `missing ${field} must fail`
      );
    }
  });
});

describe("enum schemas", () => {
  it("pastAnalysisOutcomeSchema is exhaustive", () => {
    const all: ReadonlyArray<string> = pastAnalysisOutcomeSchema.options;
    assert.deepStrictEqual(
      [...all].sort(),
      ["budget_exceeded", "ok", "tool_error", "verifier_failed"]
    );
  });

  it("pastAnalysisFeedbackSchema is exhaustive", () => {
    const all: ReadonlyArray<string> = pastAnalysisFeedbackSchema.options;
    assert.deepStrictEqual([...all].sort(), ["down", "none", "up"]);
  });
});
