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
    max_tokens: params.max_tokens ?? 2048,
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
}

/**
 * Drop-in replacement for `openai.chat.completions.create` when the model is
 * Anthropic. Throws on missing `ANTHROPIC_API_KEY` so the failure surfaces at
 * the same layer as Azure OpenAI's missing-key check.
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

  const { body, prefilledOpenBrace } = buildAnthropicRequest(params);

  const res = await fetchFn(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": process.env.ANTHROPIC_API_VERSION ?? DEFAULT_API_VERSION,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Anthropic /v1/messages failed: ${res.status} ${res.statusText} ${errText}`.trim());
  }

  const json = (await res.json()) as AnthropicResponse;
  return mapResponseToOpenAI(json, prefilledOpenBrace, params.model);
}

// Internal exports for tests.
export const __test__ = { buildAnthropicRequest, mapResponseToOpenAI };
