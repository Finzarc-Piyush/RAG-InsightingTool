/**
 * ============================================================================
 * llmUsageEmitter.ts — tiny pub/sub for "we just made an LLM call" events
 * ============================================================================
 * WHAT THIS FILE DOES
 *   A lightweight event bus (publish/subscribe). Whenever the code makes an LLM
 *   API call, it publishes a usage record here (model, token counts, cost in
 *   USD, latency, which step). Anything interested — cost meters, tests —
 *   subscribes to receive each record.
 *
 * WHY IT MATTERS
 *   It is deliberately split out from callLlm.ts so tests (and other listeners)
 *   can use it WITHOUT importing ../../openai.js, which spins up Azure
 *   credentials the moment it loads. Keep this file free of SDK imports.
 *
 * KEY PIECES
 *   - LlmCallUsage — the payload shape emitted once per API call.
 *   - registerLlmUsageListener(fn) — subscribe; returns a disposer to unsubscribe.
 *   - emitLlmUsage(usage) — publish to all listeners (errors per-listener are
 *     swallowed so telemetry never breaks a turn).
 *   - __clearLlmUsageListenersForTest() — drop all subscribers (test-only).
 *
 * HOW IT CONNECTS
 *   Published to by callLlm / completeJson; subscribed to by the usage-sink
 *   module that records spend. CallTokenUsage comes from llmCostModel.ts.
 */

import type { CallTokenUsage } from "./llmCostModel.js";

/** Payload emitted once per API call. */
export interface LlmCallUsage extends CallTokenUsage {
  model: string;
  costUsd: number;
  latencyMs: number;
  /** 1-indexed attempt number for this logical call; direct callers always emit 1. */
  attempt: number;
  /** Optional label supplied by the caller (an LlmCallPurpose). */
  purpose?: string;
  /** Optional turn correlation id (used by completeJson; direct callers may omit). */
  turnId?: string;
}

type UsageListener = (usage: LlmCallUsage) => void;

const listeners = new Set<UsageListener>();

/**
 * Subscribe to usage events. Returns a disposer that removes the listener.
 * Intended for the `llmUsageSink` module; tests may also subscribe.
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
