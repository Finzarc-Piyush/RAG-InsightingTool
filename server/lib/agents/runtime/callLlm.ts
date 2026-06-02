/**
 * ============================================================================
 * callLlm.ts — the one doorway every LLM chat call goes through
 * ============================================================================
 * WHAT THIS FILE DOES
 *   This is a thin drop-in replacement for `openai.chat.completions.create`.
 *   Calling code uses `callLlm(params)` instead, and gets back the exact same
 *   ChatCompletion. While passing the call through, it does three quiet jobs:
 *     1. Picks the right model. Each call can declare a "purpose" (planner,
 *        reflector, narrator, ...); when set, the model is chosen by purpose via
 *        the router instead of whatever the caller hard-coded.
 *     2. Fixes per-model quirks. It clamps the requested max output tokens to the
 *        model's cap, and for GPT-5 / o-series models renames `max_tokens` to the
 *        `max_completion_tokens` field those models require.
 *     3. Emits cost/usage telemetry. After the call it computes USD cost and
 *        publishes a `LlmCallUsage` event so a listener can record spend.
 *   It also routes Anthropic Claude models through a separate adapter that returns
 *   an OpenAI-shaped response, so downstream callers don't need to know which
 *   provider answered.
 *
 * WHY IT MATTERS
 *   Funnelling every chat call through one place is what makes per-role model
 *   routing, multi-provider support, and cost tracking possible without touching
 *   dozens of call sites. Telemetry is best-effort: a failing usage listener is
 *   caught and never breaks a turn.
 *
 * KEY PIECES
 *   - callLlm — the wrapper itself (non-streaming completions only).
 *   - needsMaxCompletionTokens — detects models that need the renamed token field.
 *   - CallLlmOptions — per-call knobs: purpose (model routing), turnId (keeps the
 *     routing decision stable within a turn), onUsage, skipGlobalEmit.
 *   - __setLlmStubResolver — TEST-ONLY hook to short-circuit the network call with
 *     a canned response (production never sets it; one null-check cost per call).
 *   - Re-exports the usage emitter API (emitLlmUsage, registerLlmUsageListener).
 *
 * HOW IT CONNECTS
 *   Calls the OpenAI client (../../openai.js) or callAnthropic (anthropicProvider.js)
 *   based on the model name. Uses llmCostModel.js (clampMaxTokens, calculateCostUsd,
 *   normalizeUsage), llmCallPurpose.js (resolveModelFor) and llmUsageEmitter.js.
 *   Used everywhere the server makes a direct chat-completion call, and by the
 *   higher-level completeJson wrapper.
 */

import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
} from "openai/resources/chat/completions";
import { openai } from "../../openai.js";
import { calculateCostUsd, clampMaxTokens, normalizeUsage } from "./llmCostModel.js";
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

/**
 * GPT-5 family + o-series reasoning models reject `max_tokens` and require
 * `max_completion_tokens`. Azure deployment names like "gpt-5.4-mini" pass
 * straight through as the `model` param, so a regex on the deployment string
 * is the reliable detector. Override via env when the deployment name doesn't
 * follow the convention.
 */
export function needsMaxCompletionTokens(model: string): boolean {
  if (process.env.OPENAI_USE_MAX_COMPLETION_TOKENS === "true") return true;
  if (process.env.OPENAI_USE_MAX_COMPLETION_TOKENS === "false") return false;
  return /^(gpt-5|o[1-4])/i.test(model);
}

export interface CallLlmOptions {
  /** Optional per-call usage callback (fires in addition to the global emitter). */
  onUsage?: (usage: LlmCallUsage) => void;
  /**
   * Labels the call site so the router can pick MINI vs PRIMARY model.
   * When set, OVERRIDES `params.model` with `resolveModelFor(purpose)`.
   * Explicit model is honored only when purpose is absent.
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
 * TEST-ONLY stub resolver. Production code never sets this; it is only
 * imported by `tests/helpers/llmStub.ts`. When set, `callLlm` consults the
 * resolver before hitting the real provider; if it returns a `ChatCompletion`,
 * that response short-circuits the network call. Returning `undefined` means
 * "no stub for this call — fall through to the real path."
 *
 * Kept tiny (≤20 LOC) and isolated so production cost is zero (one nullable
 * pointer check per call). Setter has a `__` prefix so the test-only intent
 * is unambiguous to readers.
 */
type LlmStubResolver = (
  params: ChatCompletionCreateParamsNonStreaming,
  opts: CallLlmOptions
) => ChatCompletion | undefined;
let __llmStubResolver: LlmStubResolver | null = null;

/** Test-only: install a stub resolver. Pass `null` to clear. */
export function __setLlmStubResolver(fn: LlmStubResolver | null): void {
  __llmStubResolver = fn;
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
  // purpose (when set) picks the model — callers stop deciding per-site.
  // The ramp resolver uses `turnId` to keep the MINI/PRIMARY decision stable
  // within a single turn for a given purpose.
  const effectiveModel = opts.purpose
    ? resolveModelFor(opts.purpose, { turnId: opts.turnId })
    : params.model;
  let effectiveParams: ChatCompletionCreateParamsNonStreaming =
    effectiveModel === params.model
      ? params
      : { ...params, model: effectiveModel };
  if (effectiveParams.max_tokens != null) {
    const clamped = clampMaxTokens(effectiveModel, effectiveParams.max_tokens);
    // GPT-5/o-series reject `max_tokens`; rename to `max_completion_tokens`.
    // Anthropic path uses native max_tokens via callAnthropic, so only swap
    // when the OpenAI path will actually consume these params.
    if (
      needsMaxCompletionTokens(effectiveModel) &&
      !isAnthropicModel(effectiveModel)
    ) {
      const { max_tokens: _drop, ...rest } = effectiveParams;
      effectiveParams = {
        ...rest,
        max_completion_tokens: clamped,
      } as ChatCompletionCreateParamsNonStreaming;
    } else if (clamped !== effectiveParams.max_tokens) {
      effectiveParams = { ...effectiveParams, max_tokens: clamped };
    }
  }
  // Test-only stub short-circuit. Production never sets the resolver;
  // when set (by installLlmStub in tests), it can return a canned response
  // keyed off `opts.purpose` and the system prompt. Returning `undefined`
  // means "no stub for this call" → fall through to the real path.
  if (__llmStubResolver) {
    const stubbed = __llmStubResolver(effectiveParams, opts);
    if (stubbed) return stubbed;
  }
  // Dispatch by model-name prefix. Claude routes through the Anthropic
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
