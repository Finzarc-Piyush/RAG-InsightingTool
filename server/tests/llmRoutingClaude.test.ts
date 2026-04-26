import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { LLM_PURPOSE, resolveModelFor } from "../lib/agents/runtime/llmCallPurpose.js";
import { isAnthropicModel } from "../lib/agents/runtime/anthropicProvider.js";

/**
 * W2 · pin the recommended synthesis routing.
 *
 * `.env.example` documents:
 *    OPENAI_MODEL_FOR_NARRATOR=claude-opus-4-7
 *    OPENAI_MODEL_FOR_VERIFIER_DEEP=claude-opus-4-7
 *    OPENAI_MODEL_FOR_COORDINATOR=claude-opus-4-7
 *    OPENAI_MODEL_FOR_HYPOTHESIS=claude-opus-4-7
 *
 * Two invariants worth pinning:
 *   1. The per-purpose override always wins (so renaming/typos surface as test
 *      failures, not silent reverts to GPT-4o).
 *   2. The model name passes `isAnthropicModel`, which is what `callLlm` uses
 *      to dispatch to the Anthropic provider — i.e. the routing config is
 *      actually reachable end-to-end.
 */

const ORIGINAL_ENV = { ...process.env };

function clearOpenaiEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("OPENAI_MODEL_") || key === "AZURE_OPENAI_DEPLOYMENT_NAME") {
      delete process.env[key];
    }
  }
}

beforeEach(() => clearOpenaiEnv());
afterEach(() => {
  clearOpenaiEnv();
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    if (k.startsWith("OPENAI_MODEL_") || k === "AZURE_OPENAI_DEPLOYMENT_NAME") {
      if (v !== undefined) process.env[k] = v;
    }
  }
});

describe("W2 · synthesis purposes route to Claude Opus 4.7 when env is set", () => {
  const SYNTHESIS_PURPOSES = [
    LLM_PURPOSE.NARRATOR,
    LLM_PURPOSE.VERIFIER_DEEP,
    LLM_PURPOSE.COORDINATOR,
    LLM_PURPOSE.HYPOTHESIS,
  ] as const;

  for (const purpose of SYNTHESIS_PURPOSES) {
    it(`${purpose} → claude-opus-4-7 via OPENAI_MODEL_FOR_${purpose.toUpperCase()}`, () => {
      process.env[`OPENAI_MODEL_FOR_${purpose.toUpperCase()}`] = "claude-opus-4-7";
      const resolved = resolveModelFor(purpose);
      assert.strictEqual(resolved, "claude-opus-4-7");
      assert.strictEqual(
        isAnthropicModel(resolved),
        true,
        "resolved model must dispatch to Anthropic provider in callLlm"
      );
    });
  }

  it("planner stays on PRIMARY (GPT-4o) when only synthesis purposes are routed to Claude", () => {
    process.env.OPENAI_MODEL_FOR_NARRATOR = "claude-opus-4-7";
    process.env.OPENAI_MODEL_FOR_VERIFIER_DEEP = "claude-opus-4-7";
    process.env.OPENAI_MODEL_PRIMARY = "gpt-4o";
    const resolved = resolveModelFor(LLM_PURPOSE.PLANNER);
    assert.strictEqual(resolved, "gpt-4o");
    assert.strictEqual(isAnthropicModel(resolved), false);
  });

  it("classifiers stay on MINI when only synthesis purposes are routed to Claude", () => {
    process.env.OPENAI_MODEL_FOR_NARRATOR = "claude-opus-4-7";
    process.env.OPENAI_MODEL_MINI = "gpt-4o-mini";
    const resolved = resolveModelFor(LLM_PURPOSE.MODE_CLASSIFY);
    assert.strictEqual(resolved, "gpt-4o-mini");
    assert.strictEqual(isAnthropicModel(resolved), false);
  });

  it("falls back to GPT-4o when Claude env is unset (safe default)", () => {
    process.env.OPENAI_MODEL_PRIMARY = "gpt-4o";
    const resolved = resolveModelFor(LLM_PURPOSE.NARRATOR);
    assert.strictEqual(resolved, "gpt-4o");
    assert.strictEqual(isAnthropicModel(resolved), false);
  });
});
