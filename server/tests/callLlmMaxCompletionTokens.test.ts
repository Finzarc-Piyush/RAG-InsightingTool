import assert from "node:assert/strict";
import { describe, it, afterEach, beforeEach } from "node:test";
import {
  callLlm,
  needsMaxCompletionTokens,
  __setLlmStubResolver,
} from "../lib/agents/runtime/callLlm.js";

/**
 * Pins the GPT-5/o-series param translation: when the deployment name matches
 * the family, the OpenAI request must carry `max_completion_tokens` instead of
 * `max_tokens`. Reverse: gpt-4o-family deployments must keep `max_tokens`.
 *
 * The `__setLlmStubResolver` hook short-circuits the actual SDK call and
 * receives `effectiveParams` AFTER param normalization, so the stub is the
 * cleanest assertion point — no mocking of the openai client needed.
 */

const cannedResponse = {
  id: "test-id",
  object: "chat.completion" as const,
  created: 0,
  model: "test",
  choices: [
    {
      index: 0,
      message: { role: "assistant" as const, content: "{}", refusal: null },
      finish_reason: "stop" as const,
      logprobs: null,
    },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

describe("callLlm · needsMaxCompletionTokens (detection)", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("matches gpt-5 family deployment names (gpt-5.4-mini, gpt-5-mini, gpt-5-pro)", () => {
    delete process.env.OPENAI_USE_MAX_COMPLETION_TOKENS;
    assert.strictEqual(needsMaxCompletionTokens("gpt-5.4-mini"), true);
    assert.strictEqual(needsMaxCompletionTokens("gpt-5-mini"), true);
    assert.strictEqual(needsMaxCompletionTokens("gpt-5-pro"), true);
    assert.strictEqual(needsMaxCompletionTokens("GPT-5.4-MINI"), true);
  });

  it("matches o-series deployment names (o1, o3-mini, o4-mini)", () => {
    delete process.env.OPENAI_USE_MAX_COMPLETION_TOKENS;
    assert.strictEqual(needsMaxCompletionTokens("o1"), true);
    assert.strictEqual(needsMaxCompletionTokens("o1-preview"), true);
    assert.strictEqual(needsMaxCompletionTokens("o3-mini"), true);
    assert.strictEqual(needsMaxCompletionTokens("o4-mini"), true);
  });

  it("does NOT match gpt-4o family", () => {
    delete process.env.OPENAI_USE_MAX_COMPLETION_TOKENS;
    assert.strictEqual(needsMaxCompletionTokens("gpt-4o"), false);
    assert.strictEqual(needsMaxCompletionTokens("gpt-4o-mini"), false);
    assert.strictEqual(needsMaxCompletionTokens("gpt-4-turbo"), false);
  });

  it("does NOT match claude deployment names", () => {
    delete process.env.OPENAI_USE_MAX_COMPLETION_TOKENS;
    assert.strictEqual(needsMaxCompletionTokens("claude-opus-4-7"), false);
    assert.strictEqual(needsMaxCompletionTokens("claude-sonnet-4-6"), false);
    assert.strictEqual(needsMaxCompletionTokens("claude-haiku-4-5"), false);
  });

  it("env override OPENAI_USE_MAX_COMPLETION_TOKENS=true forces true on any model", () => {
    process.env.OPENAI_USE_MAX_COMPLETION_TOKENS = "true";
    assert.strictEqual(needsMaxCompletionTokens("gpt-4o-mini"), true);
    assert.strictEqual(needsMaxCompletionTokens("custom-deployment-name"), true);
  });

  it("env override OPENAI_USE_MAX_COMPLETION_TOKENS=false forces false on gpt-5", () => {
    process.env.OPENAI_USE_MAX_COMPLETION_TOKENS = "false";
    assert.strictEqual(needsMaxCompletionTokens("gpt-5.4-mini"), false);
    assert.strictEqual(needsMaxCompletionTokens("o3-mini"), false);
  });
});

describe("callLlm · param translation (max_tokens → max_completion_tokens)", () => {
  const originalEnv = { ...process.env };
  let captured: Record<string, unknown> | null = null;

  beforeEach(() => {
    captured = null;
    __setLlmStubResolver((params) => {
      captured = { ...params } as Record<string, unknown>;
      return cannedResponse as never;
    });
  });

  afterEach(() => {
    __setLlmStubResolver(null);
    process.env = { ...originalEnv };
  });

  it("renames max_tokens → max_completion_tokens for gpt-5.4-mini deployment", async () => {
    delete process.env.OPENAI_USE_MAX_COMPLETION_TOKENS;
    await callLlm({
      model: "gpt-5.4-mini",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1000,
    });
    assert.ok(captured, "stub must have captured the effective params");
    assert.strictEqual(
      (captured as { max_tokens?: number }).max_tokens,
      undefined,
      "max_tokens must be stripped before the SDK call",
    );
    assert.strictEqual(
      (captured as { max_completion_tokens?: number }).max_completion_tokens,
      1000,
      "max_completion_tokens must carry the original budget",
    );
  });

  it("preserves max_tokens (no rename) for gpt-4o-mini deployment", async () => {
    delete process.env.OPENAI_USE_MAX_COMPLETION_TOKENS;
    await callLlm({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 800,
    });
    assert.ok(captured);
    assert.strictEqual((captured as { max_tokens?: number }).max_tokens, 800);
    assert.strictEqual(
      (captured as { max_completion_tokens?: number }).max_completion_tokens,
      undefined,
      "gpt-4o family must NOT receive max_completion_tokens",
    );
  });

  it("env override forces the rename even on gpt-4o-mini", async () => {
    process.env.OPENAI_USE_MAX_COMPLETION_TOKENS = "true";
    await callLlm({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 500,
    });
    assert.ok(captured);
    assert.strictEqual((captured as { max_tokens?: number }).max_tokens, undefined);
    assert.strictEqual(
      (captured as { max_completion_tokens?: number }).max_completion_tokens,
      500,
    );
  });

  it("clamps max_tokens to the model cap THEN renames (gpt-5.4-mini, 99k requested → 16384)", async () => {
    delete process.env.OPENAI_USE_MAX_COMPLETION_TOKENS;
    await callLlm({
      model: "gpt-5.4-mini",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 99_000,
    });
    assert.ok(captured);
    assert.strictEqual(
      (captured as { max_completion_tokens?: number }).max_completion_tokens,
      16_384,
      "clamp must run before rename so the cap applies to gpt-5 family too",
    );
    assert.strictEqual((captured as { max_tokens?: number }).max_tokens, undefined);
  });

  it("leaves params untouched when neither max_tokens is set", async () => {
    delete process.env.OPENAI_USE_MAX_COMPLETION_TOKENS;
    await callLlm({
      model: "gpt-5.4-mini",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.ok(captured);
    assert.strictEqual((captured as { max_tokens?: number }).max_tokens, undefined);
    assert.strictEqual(
      (captured as { max_completion_tokens?: number }).max_completion_tokens,
      undefined,
      "no token budget passed in → don't synthesize one",
    );
  });

  it("does NOT rename for an Anthropic model even if the pattern would match", async () => {
    // The pattern itself doesn't match claude-* but env override does. Verify
    // the anthropic guard keeps max_tokens on the claude path so callAnthropic
    // sees the native param.
    process.env.OPENAI_USE_MAX_COMPLETION_TOKENS = "true";
    // The Anthropic provider routes by model-name prefix; we still expect the
    // request shape coming into the stub to retain max_tokens because the
    // Anthropic branch consumes it natively.
    await callLlm({
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 800,
    });
    assert.ok(captured);
    assert.strictEqual(
      (captured as { max_tokens?: number }).max_tokens,
      800,
      "Anthropic path must keep max_tokens",
    );
    assert.strictEqual(
      (captured as { max_completion_tokens?: number }).max_completion_tokens,
      undefined,
    );
  });
});
