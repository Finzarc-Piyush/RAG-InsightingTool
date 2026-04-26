import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  callAnthropic,
  isAnthropicModel,
  __test__,
} from "../lib/agents/runtime/anthropicProvider.js";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";

/**
 * W1 · anthropicProvider
 *
 * Pins the contract that lets `callLlm` dispatch by model-name prefix:
 *  - prefix detection covers the families ops will configure
 *  - request shaping splits system out of messages, collapses adjacent same-role
 *    turns, and prefills `{` for JSON-mode requests
 *  - response shaping mirrors the OpenAI ChatCompletion fields that
 *    `completeJson` and `normalizeUsage` actually read
 */

const sampleParams: ChatCompletionCreateParamsNonStreaming = {
  model: "claude-opus-4-7",
  messages: [
    { role: "system", content: "You are a senior analyst." },
    { role: "user", content: "What is 2 + 2?" },
  ],
  response_format: { type: "json_object" },
  temperature: 0.2,
  max_tokens: 256,
};

describe("isAnthropicModel", () => {
  it("returns true for claude-prefixed model names", () => {
    assert.strictEqual(isAnthropicModel("claude-opus-4-7"), true);
    assert.strictEqual(isAnthropicModel("claude-sonnet-4-6"), true);
    assert.strictEqual(isAnthropicModel("Claude-Haiku-4-5"), true);
  });

  it("returns false for OpenAI / Azure deployment names", () => {
    assert.strictEqual(isAnthropicModel("gpt-4o"), false);
    assert.strictEqual(isAnthropicModel("gpt-4o-mini"), false);
    assert.strictEqual(isAnthropicModel("o1-preview"), false);
    assert.strictEqual(isAnthropicModel(undefined), false);
    assert.strictEqual(isAnthropicModel(null), false);
    assert.strictEqual(isAnthropicModel(""), false);
  });
});

describe("buildAnthropicRequest", () => {
  it("strips the system message into the top-level system field", () => {
    const { body } = __test__.buildAnthropicRequest(sampleParams);
    assert.strictEqual(body.system, "You are a senior analyst.");
    const messages = body.messages as Array<{ role: string; content: string }>;
    assert.ok(!messages.some((m) => m.role === "system"));
  });

  it("prefills `{` for json_object response_format", () => {
    const { body, prefilledOpenBrace } = __test__.buildAnthropicRequest(sampleParams);
    assert.strictEqual(prefilledOpenBrace, true);
    const messages = body.messages as Array<{ role: string; content: string }>;
    const last = messages[messages.length - 1];
    assert.strictEqual(last.role, "assistant");
    assert.strictEqual(last.content, "{");
  });

  it("does NOT prefill when response_format is absent", () => {
    const { prefilledOpenBrace } = __test__.buildAnthropicRequest({
      ...sampleParams,
      response_format: undefined,
    });
    assert.strictEqual(prefilledOpenBrace, false);
  });

  it("collapses consecutive same-role messages (Anthropic forbids them)", () => {
    const { body } = __test__.buildAnthropicRequest({
      model: "claude-opus-4-7",
      messages: [
        { role: "user", content: "first" },
        { role: "user", content: "second" },
      ],
      max_tokens: 64,
    });
    const messages = body.messages as Array<{ role: string; content: string }>;
    const userTurns = messages.filter((m) => m.role === "user");
    assert.strictEqual(userTurns.length, 1);
    assert.match(userTurns[0].content, /first[\s\S]*second/);
  });

  it("forwards temperature and max_tokens", () => {
    const { body } = __test__.buildAnthropicRequest(sampleParams);
    assert.strictEqual(body.temperature, 0.2);
    assert.strictEqual(body.max_tokens, 256);
    assert.strictEqual(body.model, "claude-opus-4-7");
  });
});

describe("mapResponseToOpenAI", () => {
  it("merges the prefilled `{` back onto the response text so callers parse identically", () => {
    const oai = __test__.mapResponseToOpenAI(
      {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-7",
        content: [{ type: "text", text: '"answer": 4}' }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      true,
      "claude-opus-4-7"
    );
    assert.strictEqual(oai.choices[0]?.message.content, '{"answer": 4}');
  });

  it("populates usage in OpenAI shape so normalizeUsage reads it correctly", () => {
    const oai = __test__.mapResponseToOpenAI(
      {
        id: "msg_2",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-7",
        content: [{ type: "text", text: "hi" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 80 },
      },
      false,
      "claude-opus-4-7"
    );
    const usage = oai.usage as unknown as {
      prompt_tokens: number;
      completion_tokens: number;
      prompt_tokens_details?: { cached_tokens?: number };
    };
    // Anthropic reports "input_tokens" as fresh + cache_creation; cache_read is
    // separate. We surface the cached tokens as `prompt_tokens_details.cached_tokens`
    // and add them into prompt_tokens so cost rollups see the full base.
    assert.strictEqual(usage.completion_tokens, 20);
    assert.strictEqual(usage.prompt_tokens, 180);
    assert.strictEqual(usage.prompt_tokens_details?.cached_tokens, 80);
  });

  it("maps stop_reason=max_tokens to finish_reason=length", () => {
    const oai = __test__.mapResponseToOpenAI(
      {
        id: "msg_3",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-7",
        content: [{ type: "text", text: "truncated…" }],
        stop_reason: "max_tokens",
        usage: { input_tokens: 5, output_tokens: 256 },
      },
      false,
      "claude-opus-4-7"
    );
    assert.strictEqual(oai.choices[0]?.finish_reason, "length");
  });
});

describe("callAnthropic · end-to-end (mocked fetch)", () => {
  it("posts to /v1/messages with the right headers and parses the response", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const mockFetch: typeof fetch = (async (url, init) => {
      captured = { url: String(url), init: init as RequestInit };
      return new Response(
        JSON.stringify({
          id: "msg_x",
          type: "message",
          role: "assistant",
          model: "claude-opus-4-7",
          content: [{ type: "text", text: '"finding": "ok"}' }],
          stop_reason: "end_turn",
          usage: { input_tokens: 12, output_tokens: 8 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;

    const res = await callAnthropic(sampleParams, {
      apiKey: "test-key",
      baseUrl: "https://api.example.com",
      fetchImpl: mockFetch,
    });

    assert.ok(captured, "fetch was not called");
    assert.strictEqual(captured!.url, "https://api.example.com/v1/messages");
    const headers = captured!.init.headers as Record<string, string>;
    assert.strictEqual(headers["x-api-key"], "test-key");
    assert.strictEqual(headers["content-type"], "application/json");
    assert.ok(headers["anthropic-version"], "anthropic-version header missing");

    assert.strictEqual(res.choices[0]?.message.content, '{"finding": "ok"}');
  });

  it("throws a clear error when ANTHROPIC_API_KEY is missing", async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await assert.rejects(
        () => callAnthropic(sampleParams, { fetchImpl: (() => { throw new Error("should not be called"); }) as typeof fetch }),
        /ANTHROPIC_API_KEY is not set/
      );
    } finally {
      if (prev != null) process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  it("surfaces non-2xx responses with status + body in the error message", async () => {
    const mockFetch: typeof fetch = (async () =>
      new Response("rate limited", { status: 429, statusText: "Too Many Requests" })) as typeof fetch;
    await assert.rejects(
      () =>
        callAnthropic(sampleParams, {
          apiKey: "test-key",
          fetchImpl: mockFetch,
        }),
      /429/
    );
  });
});
