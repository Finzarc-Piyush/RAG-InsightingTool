import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.AZURE_OPENAI_API_KEY ??= "test";
process.env.AZURE_OPENAI_ENDPOINT ??= "https://test.openai.azure.com";
process.env.AZURE_OPENAI_DEPLOYMENT_NAME ??= "test-deployment";

const { isStreamingNarratorEnabled, completeJsonStreaming } = await import(
  "../lib/agents/runtime/llmJson.js"
);
const { z } = await import("zod");

describe("W38 · isStreamingNarratorEnabled gate", () => {
  it("is false unless STREAMING_NARRATOR_ENABLED === 'true'", () => {
    const prev = process.env.STREAMING_NARRATOR_ENABLED;
    delete process.env.STREAMING_NARRATOR_ENABLED;
    assert.equal(isStreamingNarratorEnabled(), false);
    process.env.STREAMING_NARRATOR_ENABLED = "1";
    assert.equal(isStreamingNarratorEnabled(), false);
    process.env.STREAMING_NARRATOR_ENABLED = "TRUE";
    assert.equal(isStreamingNarratorEnabled(), false);
    process.env.STREAMING_NARRATOR_ENABLED = "true";
    assert.equal(isStreamingNarratorEnabled(), true);
    if (prev === undefined) delete process.env.STREAMING_NARRATOR_ENABLED;
    else process.env.STREAMING_NARRATOR_ENABLED = prev;
  });
});

describe("W38 · completeJsonStreaming env-gated fallback", () => {
  it("falls back to non-streaming completeJson when env flag is unset", async () => {
    // With no env flag set, completeJsonStreaming should immediately
    // delegate to completeJson. Stub the LLM via the W18 harness.
    const { installLlmStub, clearLlmStub } = await import("./helpers/llmStub.js");
    const { LLM_PURPOSE } = await import(
      "../lib/agents/runtime/llmCallPurpose.js"
    );

    const prev = process.env.STREAMING_NARRATOR_ENABLED;
    delete process.env.STREAMING_NARRATOR_ENABLED;

    let chunkCount = 0;
    installLlmStub({
      [LLM_PURPOSE.NARRATOR]: () => ({ body: "stub answer", keyInsight: null, ctas: [] }),
    });
    const schema = z.object({
      body: z.string(),
      keyInsight: z.string().nullable().optional(),
      ctas: z.array(z.string()).optional(),
    });
    const result = await completeJsonStreaming("sys", "user", schema, {
      purpose: LLM_PURPOSE.NARRATOR,
      onPartial: () => {
        chunkCount++;
      },
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.data.body, "stub answer");
    }
    // Non-streaming fallback never invokes onPartial.
    assert.equal(chunkCount, 0);

    clearLlmStub();
    if (prev !== undefined) process.env.STREAMING_NARRATOR_ENABLED = prev;
  });

  it("falls back to non-streaming when model is Anthropic (no streaming adapter)", async () => {
    // Same fallback behaviour: anthropic-prefixed model → non-streaming path.
    // We don't actually drive an Anthropic stream here; just verify the
    // fallback logic kicks in (covered indirectly: when stub returns,
    // onPartial wasn't called → fallback path was taken).
    const { installLlmStub, clearLlmStub } = await import("./helpers/llmStub.js");
    const { LLM_PURPOSE } = await import(
      "../lib/agents/runtime/llmCallPurpose.js"
    );

    process.env.STREAMING_NARRATOR_ENABLED = "true";
    let chunkCount = 0;
    installLlmStub({
      [LLM_PURPOSE.NARRATOR]: () => ({ body: "anthropic-stub" }),
    });
    const schema = z.object({ body: z.string() });
    const result = await completeJsonStreaming("sys", "user", schema, {
      model: "claude-sonnet-4-6",
      purpose: LLM_PURPOSE.NARRATOR,
      onPartial: () => {
        chunkCount++;
      },
    });

    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.data.body, "anthropic-stub");
    assert.equal(chunkCount, 0, "anthropic model should not invoke streaming chunks");

    clearLlmStub();
    delete process.env.STREAMING_NARRATOR_ENABLED;
  });
});
