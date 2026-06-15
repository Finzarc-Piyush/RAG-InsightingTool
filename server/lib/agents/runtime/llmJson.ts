/**
 * ============================================================================
 * llmJson.ts — call an LLM and get back validated, schema-shaped JSON
 * ============================================================================
 * WHAT THIS FILE DOES
 *   Almost every agent in this codebase needs the LLM to answer in a precise
 *   JSON shape (a query plan, a verdict, a list of actions) rather than free
 *   prose. This file is the single helper that makes that reliable. You give it
 *   a system prompt, a user prompt, and a Zod schema (a runtime description of
 *   the exact JSON you expect); it calls the model, parses the reply, and checks
 *   it against the schema. LLMs frequently emit slightly-wrong JSON, so it runs
 *   a built-in 3-attempt repair loop: (1) try it; (2) feed the validation error
 *   back and ask the model to fix it; (3) one last clean-slate attempt with a
 *   minimal instruction. It also tolerates a model wrapping JSON in extra prose
 *   by extracting the first {...} or [...] block.
 *
 * WHY IT MATTERS
 *   It is the workhorse boundary between "the model said something" and
 *   "structured data the rest of the pipeline can trust". It also picks the
 *   right model per call purpose (cheap MINI tier vs. powerful PRIMARY tier),
 *   emits cost/latency/token telemetry for every attempt, and cleanly
 *   distinguishes an upstream API failure (billing/rate-limit/config) from a
 *   schema failure (prompt/schema needs tightening) so operators know what to
 *   fix. Without it, every agent would re-implement parsing, retries, model
 *   routing, and cost tracking.
 *
 * KEY PIECES
 *   - completeJson(system, user, schema, options) — the main entry point;
 *     returns { ok: true, data } or { ok: false, error, kind }. Owns the
 *     3-attempt repair loop and never relies on the caller to retry.
 *   - CompleteJsonFailureKind — "api_error" vs "schema_error" so callers/ops
 *     can react differently.
 *   - completeJsonStreaming(...) — same contract, but streams the model's
 *     output chunk-by-chunk via `onPartial` for live narration UX; falls back
 *     to `completeJson` whenever streaming is disabled, the model is Anthropic
 *     (no streaming adapter), or anything goes wrong mid-stream.
 *   - isStreamingNarratorEnabled() — env-flag gate (STREAMING_NARRATOR_ENABLED).
 *
 * HOW IT CONNECTS
 *   Called by nearly every runtime agent (planner, verifier, narrator,
 *   businessActionsAgent, quickAnswerPlanner, directive extractor, …). Calls
 *   `callLlm` from ./callLlm.js for the actual request, resolves the model via
 *   `resolveModelFor` in ./llmCallPurpose.js, computes cost via ./llmCostModel.js,
 *   and detects Anthropic models via ./anthropicProvider.js.
 */
import { MODEL, openai } from "../../openai.js";
import type { ZodType } from "zod";
import { agentLog } from "./agentLogger.js";
import {
  callLlm,
  emitLlmUsage,
  needsMaxCompletionTokens,
  type LlmCallUsage,
} from "./callLlm.js";
import { calculateCostUsd, clampMaxTokens, normalizeUsage } from "./llmCostModel.js";
import { resolveModelFor, type LlmCallPurpose } from "./llmCallPurpose.js";
import { isAnthropicModel } from "./anthropicProvider.js";
import { errorMessage } from "../../../utils/errorMessage.js";

export type { LlmCallUsage } from "./callLlm.js";

/**
 * `kind` separates an upstream API failure (HTTP 4xx/5xx — config bug, rate
 * limit, key rejected) from a schema/parse failure (model produced JSON that
 * didn't satisfy the Zod schema after 3 retries). Both surface as `ok: false`
 * but require different operator responses: api_error → check deployment
 * config / billing; schema_error → tighten the prompt or the schema.
 */
export type CompleteJsonFailureKind = "api_error" | "schema_error";

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
    /** Fires once per API call with token counts + computed USD cost. */
    onUsage?: (usage: LlmCallUsage) => void;
    /**
     * When set, selects the model via `resolveModelFor(purpose)` and OVERRIDES
     * `options.model`. Call sites pass this and stop caring which deployment to
     * use — ops flip env vars to route.
     */
    purpose?: LlmCallPurpose;
  }
): Promise<
  | { ok: true; data: T }
  | { ok: false; error: string; kind: CompleteJsonFailureKind }
> {
  const maxTokens = options.maxTokens ?? 2048;
  const temperature = options.temperature ?? 0.2;
  // Pass turnId to keep the model-routing decision stable across retries within
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
    // still publish via the same global emitter so the telemetry sink sees
    // every retry call.
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
        // purpose forwarded so the test stub resolver (in callLlm) can route by
        // purpose. Production cost is one extra `resolveModelFor` call per
        // attempt — idempotent, negligible.
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
        return JSON.parse(match[1]!);
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

    // Pass 3: a last, minimal-instruction attempt that strips the prior
    // attempt's context entirely. Often the model just needed a clean slate.
    text = await runOnce(
      "Return ONLY a single JSON object matching the caller's schema. No prose, no explanation.",
      user
    );
    parsed = schema.safeParse(extractJson(text));
    if (parsed.success) {
      return { ok: true, data: parsed.data };
    }
    return { ok: false, error: parsed.error.message, kind: "schema_error" };
  } catch (e) {
    const msg = errorMessage(e);
    // OpenAI SDK errors carry a numeric `status` (4xx/5xx). Treat anything
    // with a status as an API error so the caller can surface "provider
    // rejected the request" instead of misdiagnosing it as a JSON failure.
    const status =
      typeof (e as { status?: unknown })?.status === "number"
        ? ((e as { status: number }).status)
        : null;
    const kind: CompleteJsonFailureKind = status != null ? "api_error" : "schema_error";
    return { ok: false, error: msg, kind };
  }
}

/**
 * Streaming variant of `completeJson`. Same contract — validates the full
 * response against a Zod schema at the end — but emits each provider chunk to
 * `onPartial(rawTextSoFar, deltaText)` so the caller can forward partial text
 * to the client (e.g. via SSE) for live narration UX.
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
): Promise<
  | { ok: true; data: T }
  | { ok: false; error: string; kind: CompleteJsonFailureKind }
> {
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
    // GPT-5/o-series reject `max_tokens` even on streaming calls — swap to
    // `max_completion_tokens` for those deployments. Mirrors callLlm.ts's
    // non-streaming translation so both paths agree.
    const clampedTokens = clampMaxTokens(effectiveModel, options.maxTokens ?? 2048);
    const tokenLimitParam = needsMaxCompletionTokens(effectiveModel)
      ? { max_completion_tokens: clampedTokens }
      : { max_tokens: clampedTokens };
    const stream = await openai.chat.completions.create({
      model: effectiveModel as string,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
      temperature: options.temperature ?? 0.2,
      ...tokenLimitParam,
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
    const msg = errorMessage(e);
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
      parsed = JSON.parse(match[1]!);
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
