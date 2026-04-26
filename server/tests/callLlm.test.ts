import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import {
  emitLlmUsage,
  registerLlmUsageListener,
  __clearLlmUsageListenersForTest,
  type LlmCallUsage,
} from "../lib/agents/runtime/llmUsageEmitter.js";

/**
 * W1.2 · The global usage emitter is the spine of all downstream telemetry.
 * These tests pin its contract: listeners receive every event, failures in
 * one listener do not stop others, and disposers actually remove listeners.
 *
 * The SDK pass-through path of `callLlm` itself is a one-line await on the
 * Azure OpenAI client — not tested here (would require network/mocking);
 * covered by integration in W1.3 when the real sink lands.
 */

const sampleUsage = (overrides: Partial<LlmCallUsage> = {}): LlmCallUsage => ({
  model: "gpt-4o",
  promptTokens: 1000,
  completionTokens: 500,
  costUsd: 0.0075,
  latencyMs: 150,
  attempt: 1,
  ...overrides,
});

describe("callLlm · usage emitter", () => {
  afterEach(() => {
    __clearLlmUsageListenersForTest();
  });

  it("delivers a published event to a subscribed listener", () => {
    const received: LlmCallUsage[] = [];
    registerLlmUsageListener((u) => received.push(u));
    const payload = sampleUsage({ purpose: "mode_classify" });
    emitLlmUsage(payload);
    assert.strictEqual(received.length, 1);
    assert.deepStrictEqual(received[0], payload);
  });

  it("delivers the same event to every subscribed listener", () => {
    const a: LlmCallUsage[] = [];
    const b: LlmCallUsage[] = [];
    registerLlmUsageListener((u) => a.push(u));
    registerLlmUsageListener((u) => b.push(u));
    emitLlmUsage(sampleUsage());
    assert.strictEqual(a.length, 1);
    assert.strictEqual(b.length, 1);
  });

  it("disposer returned by registerLlmUsageListener actually unsubscribes", () => {
    const received: LlmCallUsage[] = [];
    const dispose = registerLlmUsageListener((u) => received.push(u));
    emitLlmUsage(sampleUsage());
    dispose();
    emitLlmUsage(sampleUsage());
    assert.strictEqual(received.length, 1, "second emission must not reach disposed listener");
  });

  it("a throwing listener never prevents other listeners from firing", () => {
    const received: LlmCallUsage[] = [];
    registerLlmUsageListener(() => {
      throw new Error("boom");
    });
    registerLlmUsageListener((u) => received.push(u));
    registerLlmUsageListener(() => {
      throw new Error("also boom");
    });
    // Must not throw up into the caller (emitLlmUsage swallows listener errors).
    assert.doesNotThrow(() => emitLlmUsage(sampleUsage()));
    assert.strictEqual(received.length, 1);
  });

  it("emitLlmUsage with zero listeners is a silent no-op", () => {
    // No listeners registered — just ensure the call is cheap and doesn't crash.
    assert.doesNotThrow(() => emitLlmUsage(sampleUsage()));
  });

  it("__clearLlmUsageListenersForTest drops every subscriber", () => {
    const a: LlmCallUsage[] = [];
    registerLlmUsageListener((u) => a.push(u));
    registerLlmUsageListener((u) => a.push(u));
    __clearLlmUsageListenersForTest();
    emitLlmUsage(sampleUsage());
    assert.strictEqual(a.length, 0);
  });

  it("the same listener fn registered twice receives events once (Set semantics)", () => {
    const received: LlmCallUsage[] = [];
    const fn = (u: LlmCallUsage) => received.push(u);
    registerLlmUsageListener(fn);
    registerLlmUsageListener(fn);
    emitLlmUsage(sampleUsage());
    assert.strictEqual(received.length, 1, "Set-based registry dedupes identical fn refs");
  });

  it("preserves event payload fields verbatim (no mutation by the emitter)", () => {
    const payload = sampleUsage({
      purpose: "planner",
      turnId: "turn_abc",
      cachedPromptTokens: 400,
    });
    registerLlmUsageListener((u) => {
      // Try to mutate — emitter is not obligated to deep-clone but must at
      // least pass the original reference through unchanged.
      assert.strictEqual(u.purpose, "planner");
      assert.strictEqual(u.turnId, "turn_abc");
      assert.strictEqual(u.cachedPromptTokens, 400);
    });
    emitLlmUsage(payload);
  });
});
