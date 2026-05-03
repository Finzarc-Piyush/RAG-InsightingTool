import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

// F3 · This test verifies the AbortSignal contract on AgentExecutionContext —
// the signal is read at major step boundaries via `checkAbort` in agentLoop.
// We assert the type-level contract here; full agent-loop runtime testing of
// the abort path lives in the W18 stub harness suite.
import type { AgentExecutionContext } from "../lib/agents/runtime/types.js";

describe("F3 · client-disconnect abort signal", () => {
  it("AgentExecutionContext type accepts an abortSignal", () => {
    const ctrl = new AbortController();
    const ctx: Partial<AgentExecutionContext> = {
      sessionId: "s",
      question: "q",
      data: [],
      abortSignal: ctrl.signal,
    };
    assert.equal(ctx.abortSignal?.aborted, false);
    ctrl.abort();
    assert.equal(ctx.abortSignal?.aborted, true);
  });

  it("AbortController.abort() flips signal.aborted synchronously", () => {
    const ctrl = new AbortController();
    assert.equal(ctrl.signal.aborted, false);
    ctrl.abort();
    assert.equal(ctrl.signal.aborted, true);
  });
});
