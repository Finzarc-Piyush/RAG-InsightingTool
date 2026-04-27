import { MODEL, openai } from "../../openai.js";
import type { ZodType } from "zod";
import { agentLog } from "./agentLogger.js";
import { callLlm, emitLlmUsage, type LlmCallUsage } from "./callLlm.js";
import { calculateCostUsd, normalizeUsage } from "./llmCostModel.js";
import { resolveModelFor, type LlmCallPurpose } from "./llmCallPurpose.js";
import { isAnthropicModel } from "./anthropicProvider.js";

export type { LlmCallUsage } from "./callLlm.js";

export async function completeJson<T>(
  system: string,
  user: string,
  schema: ZodType<T>,
  options: {
    maxTokens?: number;
    temperature?: number;
    /** Defaults to main chat deployment; set INSIGHT_MODEL for a dedicated insights deployment. */
    model?: string;
    turnId?: string;
    onLlmCall?: () => void;
    /** Fires once per API call with token counts + computed USD cost (W1.1 telemetry). */
    onUsage?: (usage: LlmCallUsage) => void;
    /**
     * W3.2 · When set, selects the model via `resolveModelFor(purpose)` and
     * OVERRIDES `options.model`. Migrated call sites pass this and stop caring
     * which deployment to use — ops flip env vars to route.
     */
    purpose?: LlmCallPurpose;
  }
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const maxTokens = options.maxTokens ?? 2048;
  const temperature = options.temperature ?? 0.2;
  // W3.10 · pass turnId to keep the ramp decision stable across retries within
  // the same logical turn. completeJson owns the retry loop (attempt 1..3)
  // and we want every attempt to hit the same side of the MINI/PRIMARY ramp.
  const model = options.purpose
    ? resolveModelFor(options.purpose, { turnId: options.turnId })
    : (options.model ?? MODEL);
  const mark = () => options.onLlmCall?.();

  let attempt = 0;

  const runOnce = async (sys: string, usr: string) => {
    mark();
    attempt += 1;
    const startedAt = Date.now();
    // Bypass `callLlm`'s default single-attempt emit because completeJson owns
    // the retry loop — we need to publish with the correct `attempt` index. We
    // still publish via the same global emitter so the sink (W1.3) sees every
    // retry call.
    const res = await callLlm(
      {
        model: model as string,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: usr },
        ],
        response_format: { type: "json_object" },
        temperature,
        max_tokens: maxTokens,
      },
      {
        // completeJson owns the retry loop — suppress callLlm's default emit
        // and re-emit below with the correct `attempt` index.
        skipGlobalEmit: true,
        turnId: options.turnId,
        // W18 · purpose forwarded so the test stub resolver (in callLlm) can
        // route by purpose. Production cost is one extra `resolveModelFor`
        // call per attempt — idempotent, negligible.
        purpose: options.purpose,
      }
    );
    const text = res.choices[0]?.message?.content || "{}";
    const normalized = normalizeUsage(res.usage);
    if (normalized) {
      const usage: LlmCallUsage = {
        ...normalized,
        model: model as string,
        costUsd: calculateCostUsd(model as string, normalized),
        latencyMs: Date.now() - startedAt,
        attempt,
        turnId: options.turnId,
        purpose: options.purpose,
      };
      emitLlmUsage(usage);
      options.onUsage?.(usage);
    }
    return text;
  };

  // Robust JSON.parse that tolerates the "{…}\n\nmore prose" variant LLMs
  // sometimes produce even under response_format=json_object.
  const extractJson = (raw: string): unknown => {
    try {
      return JSON.parse(raw);
    } catch {
      // Fall back to first {..} / [..] match.
      const match = raw.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
      if (match) {
        return JSON.parse(match[1]);
      }
      throw new Error("No JSON object found in model output");
    }
  };

  try {
    let text = await runOnce(system, user);
    let parsed = schema.safeParse(extractJson(text));
    if (parsed.success) {
      return { ok: true, data: parsed.data };
    }
    agentLog("llm_json_retry", { turnId: options.turnId, err: parsed.error.message });

    // Pass 2: feed back the validation error and the raw output.
    const repairUser = `Your previous output was invalid JSON for the schema. Errors: ${parsed.error.message}\n\nRaw:\n${text}\n\nReturn ONLY corrected JSON.`;
    text = await runOnce(
      system + "\nOutput ONLY valid JSON matching the schema.",
      repairUser
    );
    parsed = schema.safeParse(extractJson(text));
    if (parsed.success) {
      return { ok: true, data: parsed.data };
    }
    agentLog("llm_json_retry2", { turnId: options.turnId, err: parsed.error.message });

    // Pass 3 (P-021): a last, minimal-instruction attempt that strips the
    // prior attempt's context entirely. Often the model just needed a clean slate.
    text = await runOnce(
      "Return ONLY a single JSON object matching the caller's schema. No prose, no explanation.",
      user
    );
    parsed = schema.safeParse(extractJson(text));
    if (parsed.success) {
      return { ok: true, data: parsed.data };
    }
    return { ok: false, error: parsed.error.message };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}

/**
 * W38 · streaming variant of `completeJson`. Same contract — validates the
 * full response against a Zod schema at the end — but emits each provider
 * chunk to `onPartial(rawTextSoFar, deltaText)` so the caller can forward
 * partial text to the client (e.g. via SSE) for live narration UX.
 *
 * Streaming is gated by env flag `STREAMING_NARRATOR_ENABLED=true` AND the
 * effective model not being Anthropic (the existing Anthropic adapter at
 * `anthropicProvider.ts` doesn't yet expose a streaming surface). Both
 * fallbacks route to the existing `completeJson` for full backward
 * compatibility — the caller's contract is unchanged.
 *
 * On any failure during streaming (network error, parse failure, schema
 * validation fail), this function falls back to the non-streaming path so
 * the existing 3-pass retry machinery still protects callers.
 *
 * Telemetry: emits a `LlmCallUsage` event with `attempt: 1` and
 * `streamed: true` so dashboards can split streamed vs. non-streamed.
 */
export function isStreamingNarratorEnabled(): boolean {
  return process.env.STREAMING_NARRATOR_ENABLED === "true";
}

export interface StreamingChunkInfo {
  /** Accumulated raw text so far (the full response stream-to-date). */
  rawSoFar: string;
  /** This chunk's delta (just the new tokens). */
  delta: string;
}

export async function completeJsonStreaming<T>(
  system: string,
  user: string,
  schema: ZodType<T>,
  options: {
    maxTokens?: number;
    temperature?: number;
    model?: string;
    turnId?: string;
    onLlmCall?: () => void;
    onUsage?: (usage: LlmCallUsage) => void;
    purpose?: LlmCallPurpose;
    /** Fires for each provider chunk; safe to throw — errors are caught and the stream continues. */
    onPartial?: (chunk: StreamingChunkInfo) => void;
  }
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const fallback = () =>
    completeJson(system, user, schema, {
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      model: options.model,
      turnId: options.turnId,
      onLlmCall: options.onLlmCall,
      onUsage: options.onUsage,
      purpose: options.purpose,
    });

  // Gate: env-flag off OR Anthropic model → fall back to non-streaming.
  // Anthropic streaming would route through `anthropicProvider.ts`, which
  // doesn't currently expose a streaming surface (one-shot adapter only).
  if (!isStreamingNarratorEnabled()) return fallback();
  const effectiveModel = options.purpose
    ? resolveModelFor(options.purpose, { turnId: options.turnId })
    : (options.model ?? MODEL);
  if (isAnthropicModel(effectiveModel)) return fallback();

  options.onLlmCall?.();
  const startedAt = Date.now();
  let raw = "";
  try {
    const stream = await openai.chat.completions.create({
      model: effectiveModel as string,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
      temperature: options.temperature ?? 0.2,
      max_tokens: options.maxTokens ?? 2048,
      stream: true,
    } as never) as unknown as AsyncIterable<{
      choices?: Array<{ delta?: { content?: string | null } }>;
      usage?: unknown;
    }>;

    for await (const chunk of stream) {
      const delta = chunk?.choices?.[0]?.delta?.content ?? "";
      if (!delta) continue;
      raw += delta;
      try {
        options.onPartial?.({ rawSoFar: raw, delta });
      } catch {
        // onPartial errors must not break the stream — best-effort UI hook.
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    agentLog("llm_streaming_failed", {
      turnId: options.turnId,
      err: msg.slice(0, 300),
    });
    return fallback();
  }

  // Validate the accumulated response. On schema-fail, the non-streaming
  // fallback runs the existing 3-pass retry — so a malformed stream still
  // produces a valid envelope (slower path, no perceived stream cost lost
  // to the user since they already saw partial text).
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const match = raw.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (!match) {
      agentLog("llm_streaming_no_json", { turnId: options.turnId });
      return fallback();
    }
    try {
      parsed = JSON.parse(match[1]);
    } catch {
      agentLog("llm_streaming_bad_json", { turnId: options.turnId });
      return fallback();
    }
  }

  const validated = schema.safeParse(parsed);
  if (!validated.success) {
    agentLog("llm_streaming_schema_fail", {
      turnId: options.turnId,
      err: validated.error.message.slice(0, 300),
    });
    return fallback();
  }

  // Synthetic usage record. Provider streaming chunks omit usage on Azure
  // OpenAI's chat.completions endpoint by default, so we record latency
  // only and leave token counts at 0 (a follow-up could request usage via
  // `stream_options`, but the streaming Azure endpoint's support is patchy).
  const usage: LlmCallUsage = {
    // Streaming Azure OpenAI doesn't return usage in chunks; record latency
    // only and leave token counts at 0. Cost dashboards can split streamed
    // calls by checking `latencyMs > 0 && promptTokens === 0`.
    promptTokens: 0,
    completionTokens: 0,
    model: effectiveModel as string,
    costUsd: 0,
    latencyMs: Date.now() - startedAt,
    attempt: 1,
    turnId: options.turnId,
    purpose: options.purpose,
  };
  emitLlmUsage(usage);
  options.onUsage?.(usage);
  return { ok: true, data: validated.data };
}
