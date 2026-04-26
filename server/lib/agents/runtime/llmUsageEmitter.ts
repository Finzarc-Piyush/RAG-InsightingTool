/**
 * Global usage emitter shared by `callLlm` and `completeJson`.
 *
 * Extracted from `callLlm.ts` so unit tests can exercise the emitter without
 * pulling in `../../openai.js` (which eagerly initializes Azure credentials at
 * module load). Keep this file free of SDK imports.
 */

import type { CallTokenUsage } from "./llmCostModel.js";

/** Payload emitted once per API call. */
export interface LlmCallUsage extends CallTokenUsage {
  model: string;
  costUsd: number;
  latencyMs: number;
  /** 1-indexed attempt number for this logical call; direct callers always emit 1. */
  attempt: number;
  /** Optional label supplied by the caller (W3.1 will populate with an LlmCallPurpose). */
  purpose?: string;
  /** Optional turn correlation id (used by completeJson; direct callers may omit). */
  turnId?: string;
}

type UsageListener = (usage: LlmCallUsage) => void;

const listeners = new Set<UsageListener>();

/**
 * Subscribe to usage events. Returns a disposer that removes the listener.
 * Intended for the W1.3 `llmUsageSink` module; tests may also subscribe.
 */
export function registerLlmUsageListener(fn: UsageListener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Test helper: drop every subscriber. Not exported for production use. */
export function __clearLlmUsageListenersForTest(): void {
  listeners.clear();
}

/** Dispatch with per-listener error isolation — telemetry failures never break a turn. */
export function emitLlmUsage(usage: LlmCallUsage): void {
  for (const fn of listeners) {
    try {
      fn(usage);
    } catch {
      // Swallow silently; a failing listener is still better than a failed LLM call.
    }
  }
}
