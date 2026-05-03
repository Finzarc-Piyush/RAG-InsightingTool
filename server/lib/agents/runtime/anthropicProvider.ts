/**
 * Wave W1 · anthropicProvider
 *
 * Fetch-based Anthropic provider that returns OpenAI-shaped `ChatCompletion`
 * objects so `callLlm` can dispatch by model-name prefix without changing any
 * caller. Selected when `resolveModelFor(purpose)` (or an explicit `params.model`)
 * returns a string starting with `claude-`.
 *
 * Why fetch instead of `@anthropic-ai/sdk`: we don't need streaming, file
 * uploads, or beta features — just one POST to /v1/messages. Skipping the SDK
 * keeps the dependency surface flat and the test mock trivial.
 *
 * Why we shape the response like OpenAI's ChatCompletion: every existing call
 * site (completeJson + direct callLlm) expects `res.choices[0].message.content`
 * and `res.usage.{prompt_tokens, completion_tokens, prompt_tokens_details.cached_tokens}`.
 * Mapping at the provider boundary means zero refactor downstream.
 *
 * JSON-mode handling: Anthropic has no `response_format: json_object`. The
 * recommended pattern is "prefill the assistant turn with `{`" — we do that
 * automatically when the OpenAI request has `response_format.type === "json_object"`,
 * and re-prepend the `{` to the response text so callers parse the same shape.
 */

import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
} from "openai/resources/chat/completions";
import { withAnthropicSlot } from "./anthropicSemaphore.js";

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_API_VERSION = "2023-06-01";

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string;
}

interface AnthropicResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: Array<{ type: "text"; text: string } | { type: string; [k: string]: unknown }>;
  stop_reason: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

/** Model name prefix that routes to Anthropic. Centralized for tests. */
export function isAnthropicModel(model: string | undefined | null): boolean {
  if (!model) return false;
  return model.toLowerCase().startsWith("claude-");
}

/**
 * Translate OpenAI's chat-completion params into an Anthropic /v1/messages
 * request. Strips the system message into Anthropic's top-level `system`
 * field; collapses adjacent same-role messages (Anthropic forbids consecutive
 * user/user or assistant/assistant turns).
 */
function buildAnthropicRequest(
  params: ChatCompletionCreateParamsNonStreaming
): {
  body: Record<string, unknown>;
  prefilledOpenBrace: boolean;
} {
  const systems: string[] = [];
  const turns: AnthropicMessage[] = [];

  for (const m of params.messages) {
    if (m.role === "system") {
      const text = typeof m.content === "string" ? m.content : "";
      if (text) systems.push(text);
      continue;
    }
    if (m.role !== "user" && m.role !== "assistant") {
      // tool / function / developer messages — flatten content to user text.
      const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
      turns.push({ role: "user", content: text });
      continue;
    }
    const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
    const last = turns[turns.length - 1];
    if (last && last.role === m.role) {
      last.content = `${last.content}\n\n${text}`;
    } else {
      turns.push({ role: m.role, content: text });
    }
  }

  // Anthropic requires the conversation to start with a user turn.
  if (turns.length === 0 || turns[0].role !== "user") {
    turns.unshift({ role: "user", content: "" });
  }

  const wantsJson =
    typeof params.response_format === "object" &&
    params.response_format !== null &&
    "type" in params.response_format &&
    params.response_format.type === "json_object";

  let prefilledOpenBrace = false;
  if (wantsJson) {
    // Prefill the assistant turn with `{` so Anthropic continues from JSON.
    turns.push({ role: "assistant", content: "{" });
    prefilledOpenBrace = true;
  }

  const body: Record<string, unknown> = {
    model: params.model,
    messages: turns,
    // WTL2 · default fallback 2048 → 4096. Per-call max_tokens still wins.
    max_tokens: params.max_tokens ?? 4096,
  };
  if (systems.length) body.system = systems.join("\n\n");
  if (typeof params.temperature === "number") body.temperature = params.temperature;
  if (typeof params.top_p === "number") body.top_p = params.top_p;
  if (params.stop) body.stop_sequences = Array.isArray(params.stop) ? params.stop : [params.stop];

  return { body, prefilledOpenBrace };
}

/**
 * Map an Anthropic /v1/messages response onto OpenAI's `ChatCompletion`. We
 * return a structurally compatible object (typed `as ChatCompletion`); the
 * fields callers actually read are populated. Anything unused (e.g. `logprobs`,
 * `finish_reason` enum exhaustion) is filled with safe defaults.
 */
function mapResponseToOpenAI(
  resp: AnthropicResponse,
  prefilledOpenBrace: boolean,
  requestedModel: string
): ChatCompletion {
  const text = resp.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
  const fullContent = prefilledOpenBrace ? `{${text}` : text;

  // Anthropic's stop_reason → OpenAI's finish_reason.
  const finishReason: ChatCompletion.Choice["finish_reason"] =
    resp.stop_reason === "end_turn" || resp.stop_reason === "stop_sequence"
      ? "stop"
      : resp.stop_reason === "max_tokens"
        ? "length"
        : "stop";

  const cached = resp.usage.cache_read_input_tokens ?? 0;
  const totalPrompt = resp.usage.input_tokens + cached;

  return {
    id: resp.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: fullContent,
          refusal: null,
        },
        finish_reason: finishReason,
        logprobs: null,
      },
    ],
    usage: {
      // OpenAI's normalizeUsage reads prompt_tokens, completion_tokens, and
      // prompt_tokens_details.cached_tokens — we populate exactly those.
      prompt_tokens: totalPrompt,
      completion_tokens: resp.usage.output_tokens,
      total_tokens: totalPrompt + resp.usage.output_tokens,
      prompt_tokens_details: { cached_tokens: cached },
    },
  } as unknown as ChatCompletion;
}

export interface AnthropicCallOptions {
  /** Override the global fetch — used by tests. */
  fetchImpl?: typeof fetch;
  /** Override env-derived API key (tests). */
  apiKey?: string;
  /** Override env-derived base URL (tests). */
  baseUrl?: string;
  /** Override the sleep used between retries (tests; bypasses real timers). */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Override the env-derived max attempts (initial + retries). Default: 3. */
  maxAttempts?: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_MS = 1000;
const DEFAULT_RETRY_MAX_MS = 30_000;
const RETRY_MIN_DELAY_MS = 500;

function envPositiveNumber(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Parse a Retry-After header value into milliseconds. Anthropic typically
 * sends it as integer seconds, but RFC 7231 also allows an HTTP-date.
 * Returns `null` when the header is absent or unparseable.
 */
function parseRetryAfterMs(headerValue: string | null | undefined): number | null {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  if (!trimmed) return null;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    const delta = dateMs - Date.now();
    return delta > 0 ? delta : 0;
  }
  return null;
}

/**
 * Exponential backoff with ±20 % jitter, clamped to `[baseMs, maxMs]`. Attempt
 * is 1-indexed (first retry = attempt 1).
 */
function jitteredBackoffMs(attempt: number, baseMs: number, maxMs: number): number {
  const exp = baseMs * Math.pow(2, Math.max(0, attempt - 1));
  const capped = Math.min(exp, maxMs);
  const jitter = capped * 0.2 * (Math.random() * 2 - 1);
  return Math.max(RETRY_MIN_DELAY_MS, Math.round(capped + jitter));
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

/**
 * Drop-in replacement for `openai.chat.completions.create` when the model is
 * Anthropic. Throws on missing `ANTHROPIC_API_KEY` so the failure surfaces at
 * the same layer as Azure OpenAI's missing-key check.
 *
 * RL1 · 429 + 5xx are retried with `Retry-After` honoured (clamped to
 * `[RETRY_MIN_DELAY_MS, ANTHROPIC_RETRY_MAX_MS]`) when present, otherwise with
 * jittered exponential backoff. Bounded by `ANTHROPIC_MAX_ATTEMPTS` (default 3
 * = initial + 2 retries). Combined with RL2's process-wide concurrency
 * semaphore, this prevents 429 cascades during dashboard turns that fan out
 * many parallel LLM calls.
 */
export async function callAnthropic(
  params: ChatCompletionCreateParamsNonStreaming,
  opts: AnthropicCallOptions = {}
): Promise<ChatCompletion> {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Required to route this call to Claude — set the env var or change the per-purpose model override back to an OpenAI deployment."
    );
  }
  const baseUrl = (opts.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const fetchFn = opts.fetchImpl ?? fetch;
  const sleep = opts.sleepImpl ?? defaultSleep;
  const maxAttempts = Math.max(
    1,
    opts.maxAttempts ?? envPositiveNumber("ANTHROPIC_MAX_ATTEMPTS", DEFAULT_MAX_ATTEMPTS)
  );
  const baseMs = envPositiveNumber("ANTHROPIC_RETRY_BASE_MS", DEFAULT_RETRY_BASE_MS);
  const maxMs = envPositiveNumber("ANTHROPIC_RETRY_MAX_MS", DEFAULT_RETRY_MAX_MS);

  const { body, prefilledOpenBrace } = buildAnthropicRequest(params);

  // RL2 · semaphore-gated execution. Holding the slot across retries keeps
  // instantaneous outbound pressure bounded; the slot is released only after
  // the call resolves or exhausts its retries.
  return withAnthropicSlot(() => executeAnthropicCall({
    fetchFn,
    sleep,
    baseUrl,
    apiKey,
    body,
    prefilledOpenBrace,
    requestedModel: params.model,
    maxAttempts,
    baseMs,
    maxMs,
  }));
}

interface ExecuteAnthropicCallParams {
  fetchFn: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  baseUrl: string;
  apiKey: string;
  body: Record<string, unknown>;
  prefilledOpenBrace: boolean;
  requestedModel: string;
  maxAttempts: number;
  baseMs: number;
  maxMs: number;
}

async function executeAnthropicCall(p: ExecuteAnthropicCallParams): Promise<ChatCompletion> {
  const { fetchFn, sleep, baseUrl, apiKey, body, prefilledOpenBrace, requestedModel, maxAttempts, baseMs, maxMs } = p;
  let lastStatus = 0;
  let lastStatusText = "";
  let lastErrorText = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetchFn(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": process.env.ANTHROPIC_API_VERSION ?? DEFAULT_API_VERSION,
      },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      const json = (await res.json()) as AnthropicResponse;
      return mapResponseToOpenAI(json, prefilledOpenBrace, requestedModel);
    }

    lastErrorText = await res.text().catch(() => "");
    lastStatus = res.status;
    lastStatusText = res.statusText;

    const retryable = isRetryableStatus(res.status);
    if (!retryable || attempt === maxAttempts) break;

    const retryAfterHeader =
      typeof res.headers?.get === "function" ? res.headers.get("retry-after") : null;
    const retryAfterMs = parseRetryAfterMs(retryAfterHeader);
    const delay =
      retryAfterMs !== null
        ? Math.min(Math.max(retryAfterMs, RETRY_MIN_DELAY_MS), maxMs)
        : jitteredBackoffMs(attempt, baseMs, maxMs);

    if (process.env.NODE_ENV !== "test") {
      console.warn(
        `[anthropic] retry after ${res.status} (attempt ${attempt}/${maxAttempts}, delay ${delay}ms)`
      );
    }
    await sleep(delay);
  }

  throw new Error(
    `Anthropic /v1/messages failed: ${lastStatus} ${lastStatusText} ${lastErrorText}`.trim()
  );
}

// Internal exports for tests.
export const __test__ = {
  buildAnthropicRequest,
  mapResponseToOpenAI,
  parseRetryAfterMs,
  jitteredBackoffMs,
  isRetryableStatus,
};
