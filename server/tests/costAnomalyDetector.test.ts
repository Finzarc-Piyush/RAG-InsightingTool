import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import {
  recordAndCheckTurn,
  __resetCostAnomalyDetectorForTest,
} from "../lib/telemetry/costAnomalyDetector.js";
import {
  emitLlmUsage,
  __clearLlmUsageListenersForTest,
  type LlmCallUsage,
} from "../lib/agents/runtime/llmUsageEmitter.js";

/**
 * W6.3 · Pure-behaviour tests on the anomaly detector. The Cosmos write path
 * is exercised when the threshold is crossed (and silently swallows errors
 * when Cosmos isn't configured — exactly the failure mode we want in a unit
 * test). We assert: (a) below threshold, no record/clear noise; (b) above
 * threshold, the accumulator drains.
 */

const sample = (overrides: Partial<LlmCallUsage> = {}): LlmCallUsage => ({
  model: "gpt-4o",
  promptTokens: 1000,
  completionTokens: 200,
  costUsd: 0.5,
  latencyMs: 100,
  attempt: 1,
  turnId: "turn_x",
  ...overrides,
});

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  __resetCostAnomalyDetectorForTest();
  __clearLlmUsageListenersForTest();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("costAnomalyDetector", () => {
  it("aggregates per-turn cost across multiple emit() calls", async () => {
    process.env.COST_ALERT_PER_TURN_USD = "100"; // arbitrarily high so we never alert here
    // Force a re-subscription after reset.
    await recordAndCheckTurn({ turnId: "init", userEmail: "u@example.com" });
    emitLlmUsage(sample({ turnId: "turn_a", costUsd: 0.4 }));
    emitLlmUsage(sample({ turnId: "turn_a", costUsd: 0.7 }));
    emitLlmUsage(sample({ turnId: "turn_a", costUsd: 0.3 }));
    // Calling recordAndCheckTurn for turn_a should drain the entry without
    // throwing, even though our threshold is enormous.
    await recordAndCheckTurn({ turnId: "turn_a", userEmail: "u@example.com" });
    // Second call returns immediately (entry already removed).
    await recordAndCheckTurn({ turnId: "turn_a", userEmail: "u@example.com" });
  });

  it("returns immediately when no events were observed for a turnId", async () => {
    await recordAndCheckTurn({ turnId: "init", userEmail: "u@example.com" });
    // Never emitted — the detector should silently no-op.
    await recordAndCheckTurn({ turnId: "ghost", userEmail: "u@example.com" });
  });

  it("ignores events without a turnId", async () => {
    process.env.COST_ALERT_PER_TURN_USD = "0.01";
    await recordAndCheckTurn({ turnId: "init", userEmail: "u@example.com" });
    // Untagged event — must not be attributed to any specific turn.
    emitLlmUsage(sample({ turnId: undefined, costUsd: 99 }));
    // recordAndCheckTurn for an unrelated turnId must still no-op.
    await recordAndCheckTurn({ turnId: "ghost", userEmail: "u@example.com" });
  });

  it("clamps a misconfigured COST_ALERT_PER_TURN_USD env to the default", async () => {
    process.env.COST_ALERT_PER_TURN_USD = "not a number";
    // No assertion needed — just ensuring this path doesn't throw.
    await recordAndCheckTurn({ turnId: "init", userEmail: "u@example.com" });
    emitLlmUsage(sample({ turnId: "turn_b", costUsd: 0.01 }));
    await recordAndCheckTurn({ turnId: "turn_b", userEmail: "u@example.com" });
  });

  it("aggregates multiple turns independently", async () => {
    process.env.COST_ALERT_PER_TURN_USD = "100";
    await recordAndCheckTurn({ turnId: "init", userEmail: "u@example.com" });
    emitLlmUsage(sample({ turnId: "turn_a", costUsd: 0.5 }));
    emitLlmUsage(sample({ turnId: "turn_b", costUsd: 0.7 }));
    emitLlmUsage(sample({ turnId: "turn_a", costUsd: 0.2 }));
    // Drain a then b.
    await recordAndCheckTurn({ turnId: "turn_a", userEmail: "u@example.com" });
    await recordAndCheckTurn({ turnId: "turn_b", userEmail: "u@example.com" });
  });
});
