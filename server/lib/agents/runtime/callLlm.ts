/**
 * Thin wrapper around `openai.chat.completions.create` that emits token-usage
 * telemetry without changing call semantics. W1.2 · purely additive.
 *
 * Every direct chat-completion call in the server flows through `callLlm`.
 * Each call publishes a `LlmCallUsage` event to the global emitter; a sink
 * (W1.3) subscribes and persists to Cosmos. Until the sink lands the emitter
 * has no listeners and this wrapper is indistinguishable from calling the SDK
 * directly.
 *
 * Design contracts:
 *   - callLlm's signature mirrors `openai.chat.completions.create` for
 *     non-streaming completions. Caller code changes only the function name.
 *   - Telemetry failures never propagate to the caller (sinks run in a
 *     try/catch; a bad listener cannot break a turn).
 *   - Streaming is out of scope (no current call site streams).
 */

import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
} from "openai/resources/chat/completions";
import { openai } from "../../openai.js";
import { calculateCostUsd, normalizeUsage } from "./llmCostModel.js";
import {
  emitLlmUsage,
  type LlmCallUsage,
} from "./llmUsageEmitter.js";
import { resolveModelFor, type LlmCallPurpose } from "./llmCallPurpose.js";
import { callAnthropic, isAnthropicModel } from "./anthropicProvider.js";

export {
  emitLlmUsage,
  registerLlmUsageListener,
  __clearLlmUsageListenersForTest,
  type LlmCallUsage,
} from "./llmUsageEmitter.js";

export interface CallLlmOptions {
  /** Optional per-call usage callback (fires in addition to the global emitter). */
  onUsage?: (usage: LlmCallUsage) => void;
  /**
   * Labels the call site so the router can pick MINI vs PRIMARY model.
   * When set, OVERRIDES `params.model` with `resolveModelFor(purpose)`.
   * Explicit model is honored only when purpose is absent (W3.2).
   */
  purpose?: LlmCallPurpose;
  /** Optional turn correlation id. */
  turnId?: string;
  /**
   * Suppress the default global-emitter publish. Used by `completeJson` which
   * owns a retry loop and re-publishes with the correct `attempt` index.
   */
  skipGlobalEmit?: boolean;
}

/**
 * Drop-in replacement for `openai.chat.completions.create(params)` that emits
 * usage telemetry. Preserves return type; does not retry, does not translate
 * errors — just measures.
 */
export async function callLlm(
  params: ChatCompletionCreateParamsNonStreaming,
  opts: CallLlmOptions = {}
): Promise<ChatCompletion> {
  const startedAt = Date.now();
  // W3.2 · purpose (when set) picks the model — callers stop deciding per-site.
  // W3.10 · the ramp resolver uses `turnId` to keep the MINI/PRIMARY decision
  // stable within a single turn for a given purpose.
  const effectiveModel = opts.purpose
    ? resolveModelFor(opts.purpose, { turnId: opts.turnId })
    : params.model;
  const effectiveParams: ChatCompletionCreateParamsNonStreaming =
    effectiveModel === params.model
      ? params
      : { ...params, model: effectiveModel };
  // W1 · dispatch by model-name prefix. Claude routes through the Anthropic
  // /v1/messages adapter, which returns an OpenAI-shaped ChatCompletion so
  // every downstream caller (completeJson, direct callers) is unaffected.
  const res = isAnthropicModel(effectiveModel)
    ? await callAnthropic(effectiveParams)
    : ((await openai.chat.completions.create(effectiveParams)) as ChatCompletion);
  const normalized = normalizeUsage(res.usage);
  if (normalized) {
    const usage: LlmCallUsage = {
      ...normalized,
      model: effectiveModel,
      costUsd: calculateCostUsd(effectiveModel, normalized),
      latencyMs: Date.now() - startedAt,
      attempt: 1,
      purpose: opts.purpose,
      turnId: opts.turnId,
    };
    if (!opts.skipGlobalEmit) {
      emitLlmUsage(usage);
    }
    if (opts.onUsage) {
      try {
        opts.onUsage(usage);
      } catch {
        // Same contract — per-call callback errors must not break the caller.
      }
    }
  }
  return res;
}
