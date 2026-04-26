import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import {
  takeTurnTotals,
  __resetTurnAggregatorForTest,
} from "../lib/telemetry/turnUsageAggregator.js";
import {
  emitLlmUsage,
  __clearLlmUsageListenersForTest,
  type LlmCallUsage,
} from "../lib/agents/runtime/llmUsageEmitter.js";

const usage = (overrides: Partial<LlmCallUsage> = {}): LlmCallUsage => ({
  model: "gpt-4o",
  promptTokens: 100,
  completionTokens: 50,
  costUsd: 0.001,
  latencyMs: 100,
  attempt: 1,
  turnId: "turn_a",
  ...overrides,
});

describe("turnUsageAggregator", () => {
  beforeEach(() => {
    // Reset clears state, then re-subscribe via takeTurnTotals (which calls ensureStarted).
    __resetTurnAggregatorForTest();
    __clearLlmUsageListenersForTest();
  });

  it("returns null for an unknown turnId", () => {
    assert.strictEqual(takeTurnTotals("never-fired"), null);
  });

  it("accumulates events across multiple emits for the same turn", () => {
    // Trigger ensureStarted by calling takeTurnTotals first
    takeTurnTotals("warmup");
    emitLlmUsage(usage({ promptTokens: 100, completionTokens: 50, costUsd: 0.001 }));
    emitLlmUsage(usage({ promptTokens: 200, completionTokens: 75, costUsd: 0.002 }));
    emitLlmUsage(
      usage({ promptTokens: 300, completionTokens: 100, costUsd: 0.003, cachedPromptTokens: 50 })
    );
    const t = takeTurnTotals("turn_a");
    assert.ok(t);
    assert.strictEqual(t!.callCount, 3);
    assert.strictEqual(t!.tokensInput, 600);
    assert.strictEqual(t!.tokensOutput, 225);
    assert.strictEqual(t!.cachedPromptTokens, 50);
    assert.ok(Math.abs(t!.costUsd - 0.006) < 1e-9);
  });

  it("isolates totals between different turnIds", () => {
    takeTurnTotals("warmup");
    emitLlmUsage(usage({ turnId: "turn_a", promptTokens: 100 }));
    emitLlmUsage(usage({ turnId: "turn_b", promptTokens: 200 }));
    emitLlmUsage(usage({ turnId: "turn_a", promptTokens: 50 }));
    const a = takeTurnTotals("turn_a")!;
    const b = takeTurnTotals("turn_b")!;
    assert.strictEqual(a.tokensInput, 150);
    assert.strictEqual(b.tokensInput, 200);
  });

  it("ignores events without a turnId", () => {
    takeTurnTotals("warmup");
    emitLlmUsage(usage({ turnId: undefined, promptTokens: 999 }));
    emitLlmUsage(usage({ turnId: "turn_a", promptTokens: 100 }));
    const a = takeTurnTotals("turn_a")!;
    assert.strictEqual(a.tokensInput, 100, "untagged event must not be counted into any turn");
  });

  it("take() removes the entry — a second take returns null", () => {
    takeTurnTotals("warmup");
    emitLlmUsage(usage());
    const first = takeTurnTotals("turn_a");
    assert.ok(first);
    const second = takeTurnTotals("turn_a");
    assert.strictEqual(second, null);
  });

  it("aggregator survives __reset+rebind without losing the listener contract", () => {
    takeTurnTotals("warmup"); // first ensureStarted
    emitLlmUsage(usage());
    assert.ok(takeTurnTotals("turn_a"));
    __resetTurnAggregatorForTest();
    __clearLlmUsageListenersForTest();
    // Second cycle — must work just as cleanly.
    takeTurnTotals("warmup-2");
    emitLlmUsage(usage({ turnId: "turn_b" }));
    const b = takeTurnTotals("turn_b");
    assert.ok(b);
    assert.strictEqual(b!.callCount, 1);
  });
});
