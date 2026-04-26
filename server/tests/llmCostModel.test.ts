import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import {
  calculateCostUsd,
  normalizeUsage,
  RATE_USD_PER_MTOK,
} from "../lib/agents/runtime/llmCostModel.js";

/**
 * W1.1 · Token & cost extraction. Validates the rate math and the
 * shape-tolerant usage normalizer. Zero behaviour impact on the agent
 * runtime; this is pure measurement infrastructure.
 */
describe("llmCostModel · calculateCostUsd", () => {
  it("charges full input + output rates when there are no cached tokens", () => {
    const cost = calculateCostUsd("gpt-4o", {
      promptTokens: 1_000_000,
      completionTokens: 500_000,
    });
    // 1M * $2.50 + 500K * $10/1M = $2.50 + $5.00 = $7.50
    assert.strictEqual(cost, 7.5);
  });

  it("applies the cached-input discount to the cached portion only", () => {
    const cost = calculateCostUsd("gpt-4o", {
      promptTokens: 1_000_000,
      completionTokens: 0,
      cachedPromptTokens: 400_000,
    });
    // 600K @ $2.50/1M + 400K @ $1.25/1M = $1.50 + $0.50 = $2.00
    assert.strictEqual(cost, 2.0);
  });

  it("uses the full input rate when a model has no cachedInput rate", () => {
    // Seed a model entry without a cached rate for this test.
    RATE_USD_PER_MTOK["test-no-cache"] = { input: 1.0, output: 2.0 };
    const cost = calculateCostUsd("test-no-cache", {
      promptTokens: 1_000_000,
      completionTokens: 0,
      cachedPromptTokens: 500_000,
    });
    // 500K @ $1/1M + 500K @ $1/1M (no discount) = $1.00
    assert.strictEqual(cost, 1.0);
    delete RATE_USD_PER_MTOK["test-no-cache"];
  });

  it("returns zero for unknown models so telemetry surfaces the gap", () => {
    const cost = calculateCostUsd("some-unreleased-model", {
      promptTokens: 10_000,
      completionTokens: 10_000,
    });
    assert.strictEqual(cost, 0);
  });

  it("is case-insensitive on the model key", () => {
    const a = calculateCostUsd("GPT-4O", { promptTokens: 1000, completionTokens: 500 });
    const b = calculateCostUsd("gpt-4o", { promptTokens: 1000, completionTokens: 500 });
    assert.strictEqual(a, b);
    assert.ok(a > 0);
  });

  it("never returns a negative cost when cached exceeds promptTokens (guard)", () => {
    // Shouldn't happen in practice but a defensive guard prevents ledger pollution.
    const cost = calculateCostUsd("gpt-4o", {
      promptTokens: 100,
      completionTokens: 0,
      cachedPromptTokens: 1_000_000,
    });
    assert.ok(cost >= 0, `cost must be non-negative, got ${cost}`);
  });

  it("prices gpt-4o-mini at 17x less than gpt-4o for identical usage", () => {
    const usage = { promptTokens: 1_000_000, completionTokens: 1_000_000 };
    const full = calculateCostUsd("gpt-4o", usage);
    const mini = calculateCostUsd("gpt-4o-mini", usage);
    // 4o:  1M * $2.50 + 1M * $10   = $12.50
    // mini:1M * $0.15 + 1M * $0.60 = $0.75
    // ratio 12.5 / 0.75 ≈ 16.67
    assert.ok(full / mini > 15, `expected ratio > 15, got ${full / mini}`);
    assert.ok(full / mini < 18, `expected ratio < 18, got ${full / mini}`);
  });

  describe("env overrides", () => {
    const originalEnv = { ...process.env };
    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it("reads OPENAI_RATE_<MODEL>_INPUT env as an override", () => {
      process.env.OPENAI_RATE_GPT_4O_INPUT = "5.00";
      const cost = calculateCostUsd("gpt-4o", {
        promptTokens: 1_000_000,
        completionTokens: 0,
      });
      assert.strictEqual(cost, 5.0);
    });

    it("ignores a malformed env override and falls back to the table", () => {
      process.env.OPENAI_RATE_GPT_4O_INPUT = "not a number";
      const cost = calculateCostUsd("gpt-4o", {
        promptTokens: 1_000_000,
        completionTokens: 0,
      });
      assert.strictEqual(cost, 2.5);
    });

    it("ignores a negative env override", () => {
      process.env.OPENAI_RATE_GPT_4O_OUTPUT = "-1";
      const cost = calculateCostUsd("gpt-4o", {
        promptTokens: 0,
        completionTokens: 1_000_000,
      });
      assert.strictEqual(cost, 10.0);
    });
  });
});

describe("llmCostModel · normalizeUsage", () => {
  it("normalizes a fully-populated SDK usage object", () => {
    const n = normalizeUsage({
      prompt_tokens: 1234,
      completion_tokens: 567,
      total_tokens: 1801,
      prompt_tokens_details: { cached_tokens: 900 },
    });
    assert.deepStrictEqual(n, {
      promptTokens: 1234,
      completionTokens: 567,
      cachedPromptTokens: 900,
    });
  });

  it("omits cachedPromptTokens when the detail block is missing", () => {
    const n = normalizeUsage({ prompt_tokens: 100, completion_tokens: 50 });
    assert.deepStrictEqual(n, { promptTokens: 100, completionTokens: 50 });
  });

  it("omits cachedPromptTokens when the detail block is present but cached_tokens is missing", () => {
    const n = normalizeUsage({
      prompt_tokens: 100,
      completion_tokens: 50,
      prompt_tokens_details: {},
    });
    assert.deepStrictEqual(n, { promptTokens: 100, completionTokens: 50 });
  });

  it("returns null for an undefined / unusable usage value", () => {
    assert.strictEqual(normalizeUsage(undefined), null);
    assert.strictEqual(normalizeUsage(null), null);
    assert.strictEqual(normalizeUsage("some string"), null);
    assert.strictEqual(normalizeUsage({ prompt_tokens: "oops" }), null);
    assert.strictEqual(
      normalizeUsage({ prompt_tokens: 10 }),
      null,
      "missing completion_tokens must yield null"
    );
  });

  it("rejects a negative cached_tokens (shouldn't happen but be defensive)", () => {
    const n = normalizeUsage({
      prompt_tokens: 100,
      completion_tokens: 50,
      prompt_tokens_details: { cached_tokens: -1 },
    });
    assert.deepStrictEqual(n, { promptTokens: 100, completionTokens: 50 });
  });
});
