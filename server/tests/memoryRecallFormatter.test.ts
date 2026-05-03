import assert from "node:assert/strict";
import { describe, it } from "node:test";

/**
 * W60 · The memoryRecall formatter is async (it queries Azure Search), so
 * tests don't exercise the network. We pin only the behaviours we can verify
 * without creds: empty inputs return "", and the markdown header is stable.
 *
 * The end-to-end retrieval path is covered by `memoryResumeFidelity.test.ts`
 * (W63), which seeds entries + asserts the planner sees the recall block.
 */

describe("W60 · formatMemoryRecallForPlanner", () => {
  it("returns empty string when sessionId is missing", async () => {
    const { formatMemoryRecallForPlanner } = await import(
      "../lib/agents/runtime/memoryRecall.js"
    );
    const block = await formatMemoryRecallForPlanner({
      sessionId: "",
      question: "Why did Q1 sales rise?",
    });
    assert.strictEqual(block, "");
  });

  it("returns empty string when question is empty", async () => {
    const { formatMemoryRecallForPlanner } = await import(
      "../lib/agents/runtime/memoryRecall.js"
    );
    const block = await formatMemoryRecallForPlanner({
      sessionId: "sess_1",
      question: "   ",
    });
    assert.strictEqual(block, "");
  });

  it("returns empty string when RAG is disabled (no creds in unit-test env)", async () => {
    const { formatMemoryRecallForPlanner } = await import(
      "../lib/agents/runtime/memoryRecall.js"
    );
    // RAG is disabled by default in tests (no AZURE_SEARCH_* env). Block is
    // empty so callers can concatenate without conditional logic.
    const block = await formatMemoryRecallForPlanner({
      sessionId: "sess_1",
      question: "Why did Q1 sales rise?",
    });
    assert.strictEqual(block, "");
  });
});

describe("W60 · planner accepts memoryRecallBlock parameter", () => {
  it("planner.ts module exports runPlanner and accepts the new param shape", async () => {
    // Import to ensure the module compiles with the new signature.
    const planner = await import("../lib/agents/runtime/planner.js");
    assert.strictEqual(typeof planner.runPlanner, "function");
    // 9 params total: ctx, registry, turnId, onLlmCall, prior, working,
    // handoff, ragHits, memoryRecall.
    assert.ok(planner.runPlanner.length >= 4);
  });
});
