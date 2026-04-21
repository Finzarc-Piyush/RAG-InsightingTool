import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reflectorOutputSchema, spawnedQuestionSchema } from "../lib/agents/runtime/schemas.js";

/**
 * Wave W8 · questionSpawner unit tests.
 *
 * Tests the Zod schema extensions added to the reflector output and the
 * spawnedQuestion type. The runtime emission path in agentLoop requires a
 * live LLM so we verify the schema contract only.
 */

describe("spawnedQuestionSchema", () => {
  it("accepts a valid spawned question with all fields", () => {
    const r = spawnedQuestionSchema.safeParse({
      question: "What drove the March spike in East region?",
      spawnReason: "East showed +340% in March vs period mean",
      priority: "high",
      suggestedColumns: ["Region", "Month", "Sales"],
    });
    assert.ok(r.success);
    assert.strictEqual(r.data?.priority, "high");
    assert.deepStrictEqual(r.data?.suggestedColumns, ["Region", "Month", "Sales"]);
  });

  it("defaults suggestedColumns to empty array when omitted", () => {
    const r = spawnedQuestionSchema.safeParse({
      question: "Q",
      spawnReason: "reason",
      priority: "medium",
    });
    assert.ok(r.success);
    assert.deepStrictEqual(r.data?.suggestedColumns, []);
  });

  it("rejects invalid priority value", () => {
    const r = spawnedQuestionSchema.safeParse({
      question: "Q",
      spawnReason: "r",
      priority: "critical",
    });
    assert.ok(!r.success);
  });

  it("rejects missing question field", () => {
    const r = spawnedQuestionSchema.safeParse({ spawnReason: "r", priority: "low" });
    assert.ok(!r.success);
  });
});

describe("reflectorOutputSchema — spawnedQuestions extension", () => {
  it("accepts reflector output with no spawnedQuestions (continue action)", () => {
    const r = reflectorOutputSchema.safeParse({ action: "continue" });
    assert.ok(r.success);
    assert.deepStrictEqual(r.data?.spawnedQuestions, []);
  });

  it("accepts reflector finish with spawnedQuestions", () => {
    const r = reflectorOutputSchema.safeParse({
      action: "finish",
      spawnedQuestions: [
        {
          question: "Is East anomaly consistent across categories?",
          spawnReason: "East +340% is anomalous",
          priority: "high",
          suggestedColumns: ["Category", "Region"],
        },
      ],
    });
    assert.ok(r.success);
    assert.strictEqual(r.data?.spawnedQuestions.length, 1);
    assert.strictEqual(r.data?.spawnedQuestions[0].priority, "high");
  });

  it("defaults spawnedQuestions to empty when omitted", () => {
    const r = reflectorOutputSchema.safeParse({ action: "finish", note: "all done" });
    assert.ok(r.success);
    assert.deepStrictEqual(r.data?.spawnedQuestions, []);
  });

  it("rejects spawned question with invalid priority inside reflector output", () => {
    const r = reflectorOutputSchema.safeParse({
      action: "finish",
      spawnedQuestions: [{ question: "Q", spawnReason: "r", priority: "urgent" }],
    });
    assert.ok(!r.success);
  });

  it("accepts replan action (backward compat — spawnedQuestions empty)", () => {
    const r = reflectorOutputSchema.safeParse({ action: "replan", note: "missing dimension" });
    assert.ok(r.success);
    assert.deepStrictEqual(r.data?.spawnedQuestions, []);
  });

  it("clarify action with clarify_message still works", () => {
    const r = reflectorOutputSchema.safeParse({
      action: "clarify",
      clarify_message: "Which region are you asking about?",
    });
    assert.ok(r.success);
    assert.strictEqual(r.data?.clarify_message, "Which region are you asking about?");
    assert.deepStrictEqual(r.data?.spawnedQuestions, []);
  });
});
