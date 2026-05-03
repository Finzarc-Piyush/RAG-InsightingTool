import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  callAnthropic,
  __test__,
} from "../lib/agents/runtime/anthropicProvider.js";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";

/**
 * RL1 · anthropicProvider 429 + 5xx retry handling
 *
 * Pins:
 *  - 200 first response succeeds without sleeping
 *  - 429 with `Retry-After: 1` succeeds on the second attempt and the sleep
 *    matches the header (clamped to >= RETRY_MIN_DELAY_MS)
 *  - HTTP-date Retry-After parses into a positive ms delay
 *  - 5xx is treated as retryable just like 429
 *  - exhausted retries surface the original `Anthropic /v1/messages failed: <status>`
 *    error so callers (insightGenerator → controller → client) still see
 *    something actionable
 *  - non-retryable 4xx (e.g. 400) fails fast on the first attempt
 */

const params: ChatCompletionCreateParamsNonStreaming = {
  model: "claude-opus-4-7",
  messages: [
    { role: "system", content: "system" },
    { role: "user", content: "hello" },
  ],
  max_tokens: 64,
};

const successBody = {
  id: "msg_test",
  type: "message" as const,
  role: "assistant" as const,
  model: "claude-opus-4-7",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 10, output_tokens: 3 },
};

function makeResponse(opts: {
  status: number;
  statusText?: string;
  body?: unknown;
  retryAfter?: string | null;
}): Response {
  const headers = new Headers();
  if (opts.retryAfter != null) headers.set("retry-after", opts.retryAfter);
  return new Response(typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body ?? ""), {
    status: opts.status,
    statusText: opts.statusText ?? "",
    headers,
  });
}

describe("parseRetryAfterMs", () => {
  it("parses integer seconds", () => {
    assert.strictEqual(__test__.parseRetryAfterMs("2"), 2000);
    assert.strictEqual(__test__.parseRetryAfterMs("0"), 0);
  });
  it("parses fractional seconds", () => {
    assert.strictEqual(__test__.parseRetryAfterMs("1.5"), 1500);
  });
  it("parses HTTP-date format", () => {
    const future = new Date(Date.now() + 3000).toUTCString();
    const ms = __test__.parseRetryAfterMs(future);
    assert.ok(ms !== null && ms > 1500 && ms <= 3500, `expected ~3000ms, got ${ms}`);
  });
  it("returns null for missing or unparseable values", () => {
    assert.strictEqual(__test__.parseRetryAfterMs(null), null);
    assert.strictEqual(__test__.parseRetryAfterMs(""), null);
    assert.strictEqual(__test__.parseRetryAfterMs("not-a-date"), null);
  });
});

describe("isRetryableStatus", () => {
  it("flags 429 and 5xx as retryable", () => {
    assert.strictEqual(__test__.isRetryableStatus(429), true);
    assert.strictEqual(__test__.isRetryableStatus(500), true);
    assert.strictEqual(__test__.isRetryableStatus(503), true);
    assert.strictEqual(__test__.isRetryableStatus(599), true);
  });
  it("does not retry 4xx other than 429", () => {
    assert.strictEqual(__test__.isRetryableStatus(400), false);
    assert.strictEqual(__test__.isRetryableStatus(401), false);
    assert.strictEqual(__test__.isRetryableStatus(404), false);
    assert.strictEqual(__test__.isRetryableStatus(200), false);
  });
});

describe("callAnthropic retry behaviour", () => {
  it("succeeds without sleeping on first 200", async () => {
    let calls = 0;
    let sleeps = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return makeResponse({ status: 200, body: successBody });
    }) as unknown as typeof fetch;
    const sleepImpl = async () => {
      sleeps += 1;
    };
    const out = await callAnthropic(params, {
      apiKey: "test",
      fetchImpl,
      sleepImpl,
    });
    assert.strictEqual(calls, 1);
    assert.strictEqual(sleeps, 0);
    assert.strictEqual(out.choices[0].message.content, "ok");
  });

  it("retries once after 429 with Retry-After header and succeeds", async () => {
    let calls = 0;
    const sleepCalls: number[] = [];
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) {
        return makeResponse({
          status: 429,
          statusText: "Too Many Requests",
          retryAfter: "1",
          body: { error: { type: "rate_limit_error" } },
        });
      }
      return makeResponse({ status: 200, body: successBody });
    }) as unknown as typeof fetch;
    const sleepImpl = async (ms: number) => {
      sleepCalls.push(ms);
    };
    const out = await callAnthropic(params, {
      apiKey: "test",
      fetchImpl,
      sleepImpl,
      maxAttempts: 3,
    });
    assert.strictEqual(calls, 2);
    assert.strictEqual(sleepCalls.length, 1);
    // Retry-After=1 second → 1000ms (>= RETRY_MIN_DELAY_MS=500)
    assert.strictEqual(sleepCalls[0], 1000);
    assert.strictEqual(out.choices[0].message.content, "ok");
  });

  it("retries 5xx the same way as 429", async () => {
    let calls = 0;
    const sleepCalls: number[] = [];
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) {
        return makeResponse({ status: 503, statusText: "Service Unavailable" });
      }
      return makeResponse({ status: 200, body: successBody });
    }) as unknown as typeof fetch;
    const sleepImpl = async (ms: number) => {
      sleepCalls.push(ms);
    };
    await callAnthropic(params, {
      apiKey: "test",
      fetchImpl,
      sleepImpl,
      maxAttempts: 3,
    });
    assert.strictEqual(calls, 2);
    assert.strictEqual(sleepCalls.length, 1);
    // No Retry-After → jittered exponential backoff, but always >= 500ms
    assert.ok(sleepCalls[0] >= 500, `expected >=500ms backoff, got ${sleepCalls[0]}`);
  });

  it("throws after exhausting maxAttempts on persistent 429", async () => {
    let calls = 0;
    const sleepCalls: number[] = [];
    const fetchImpl = (async () => {
      calls += 1;
      return makeResponse({ status: 429, statusText: "Too Many Requests", retryAfter: "0" });
    }) as unknown as typeof fetch;
    const sleepImpl = async (ms: number) => {
      sleepCalls.push(ms);
    };
    await assert.rejects(
      () =>
        callAnthropic(params, {
          apiKey: "test",
          fetchImpl,
          sleepImpl,
          maxAttempts: 3,
        }),
      /Anthropic \/v1\/messages failed: 429/
    );
    assert.strictEqual(calls, 3);
    // Slept between attempt 1→2 and 2→3, but not after the final failure
    assert.strictEqual(sleepCalls.length, 2);
  });

  it("does not retry non-retryable 4xx", async () => {
    let calls = 0;
    let sleeps = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return makeResponse({ status: 400, statusText: "Bad Request", body: "bad" });
    }) as unknown as typeof fetch;
    const sleepImpl = async () => {
      sleeps += 1;
    };
    await assert.rejects(
      () =>
        callAnthropic(params, {
          apiKey: "test",
          fetchImpl,
          sleepImpl,
          maxAttempts: 3,
        }),
      /Anthropic \/v1\/messages failed: 400/
    );
    assert.strictEqual(calls, 1);
    assert.strictEqual(sleeps, 0);
  });

  it("clamps Retry-After to RETRY_MIN_DELAY_MS lower bound", async () => {
    let calls = 0;
    const sleepCalls: number[] = [];
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) {
        return makeResponse({ status: 429, retryAfter: "0" });
      }
      return makeResponse({ status: 200, body: successBody });
    }) as unknown as typeof fetch;
    const sleepImpl = async (ms: number) => {
      sleepCalls.push(ms);
    };
    await callAnthropic(params, { apiKey: "test", fetchImpl, sleepImpl, maxAttempts: 2 });
    // Retry-After=0 should be raised to 500ms minimum
    assert.strictEqual(sleepCalls[0], 500);
  });
});
