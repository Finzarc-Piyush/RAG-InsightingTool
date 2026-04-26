/**
 * Buffered async sink that drains the LLM-usage emitter into Cosmos.
 *
 * Subscribes to `registerLlmUsageListener`. Buffers up to N events in memory;
 * flushes on a size trigger (100 by default) or on a timer (5s by default).
 * Write failures are swallowed after a warning — telemetry must never block
 * or fail a chat turn. A failing sink simply drops its batch.
 *
 * Design notes:
 *   - `createLlmUsageSink({ writeBatch })` returns an isolated sink instance
 *     for tests. The default production sink (started by `createApp`) writes
 *     to Cosmos via `waitForLlmUsageContainer` + `writeLlmUsageBatch`.
 *   - The `LLM_USAGE_TELEMETRY_ENABLED=false` env flag short-circuits
 *     `startDefaultLlmUsageSink` to a no-op.
 *   - ALS-driven `getRequestContext` supplies sessionId/userId when the
 *     caller is inside a `withRequestContext` scope (W2.3 will wire this at
 *     the chat-stream entry point).
 */

import { randomBytes } from "node:crypto";
import {
  registerLlmUsageListener,
  type LlmCallUsage,
} from "../agents/runtime/llmUsageEmitter.js";
import { getRequestContext } from "./requestContext.js";
import {
  waitForLlmUsageContainer,
  writeLlmUsageBatch,
  type LlmUsageDoc,
} from "../../models/llmUsage.model.js";

const DEFAULT_MAX_BUFFER = 100;
const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
const NO_TURN_PARTITION = "__no_turn__";

export interface LlmUsageSinkConfig {
  /** Injected writer — swapped in tests for a stub. */
  writeBatch: (docs: LlmUsageDoc[]) => Promise<void>;
  maxBuffer?: number;
  flushIntervalMs?: number;
  /** Called when the write function throws. Defaults to console.warn. */
  onWriteError?: (err: unknown, droppedCount: number) => void;
}

export interface LlmUsageSink {
  /** Subscribe to the global emitter + start the timer. Idempotent. */
  start(): void;
  /** Flush now. Resolves once the in-flight batch (if any) completes. */
  flushNow(): Promise<void>;
  /** Number of events currently buffered (for tests + metrics). */
  pendingCount(): number;
  /** Stop the timer + unsubscribe. Does not flush remaining events. */
  dispose(): void;
}

function toDoc(usage: LlmCallUsage): LlmUsageDoc {
  const ctx = getRequestContext();
  const turnId = usage.turnId ?? ctx.turnId ?? NO_TURN_PARTITION;
  const nonce = randomBytes(6).toString("hex");
  const doc: LlmUsageDoc = {
    id: turnId === NO_TURN_PARTITION ? nonce : `${turnId}__${Date.now()}__${nonce}`,
    turnId,
    model: usage.model,
    attempt: usage.attempt,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    costUsd: usage.costUsd,
    latencyMs: usage.latencyMs,
    timestamp: Date.now(),
  };
  if (usage.cachedPromptTokens != null) doc.cachedPromptTokens = usage.cachedPromptTokens;
  if (usage.purpose) doc.purpose = usage.purpose;
  if (ctx.sessionId) doc.sessionId = ctx.sessionId;
  if (ctx.userId) doc.userId = ctx.userId;
  return doc;
}

export function createLlmUsageSink(config: LlmUsageSinkConfig): LlmUsageSink {
  const maxBuffer = config.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const flushIntervalMs = config.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const onError =
    config.onWriteError ??
    ((err, dropped) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`⚠️ llmUsageSink dropped ${dropped} telemetry row(s): ${msg}`);
    });

  let buffer: LlmUsageDoc[] = [];
  let timer: NodeJS.Timeout | null = null;
  let unsubscribe: (() => void) | null = null;
  let inflight: Promise<void> | null = null;

  const flushNow = async () => {
    // Serialize flushes. If one is already running, await its completion
    // then recurse so any events buffered meanwhile are also drained.
    if (inflight) {
      await inflight;
      if (buffer.length === 0) return;
    }
    if (buffer.length === 0) return;

    const batch = buffer;
    buffer = [];

    inflight = (async () => {
      try {
        await config.writeBatch(batch);
      } catch (err) {
        onError(err, batch.length);
      }
    })();

    const current = inflight;
    try {
      await current;
    } finally {
      if (inflight === current) inflight = null;
    }
  };

  const onUsage = (usage: LlmCallUsage) => {
    buffer.push(toDoc(usage));
    if (buffer.length >= maxBuffer) {
      void flushNow();
    }
  };

  return {
    start() {
      if (unsubscribe) return;
      unsubscribe = registerLlmUsageListener(onUsage);
      timer = setInterval(() => {
        void flushNow();
      }, flushIntervalMs);
      // Don't keep the event loop alive just for the flush timer.
      timer.unref?.();
    },
    async flushNow() {
      await flushNow();
    },
    pendingCount() {
      return buffer.length;
    },
    dispose() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Default production sink
// ──────────────────────────────────────────────────────────────────────────

let defaultSink: LlmUsageSink | null = null;

/**
 * Start the app-wide default sink. No-ops when `LLM_USAGE_TELEMETRY_ENABLED=false`
 * or when already started. Called once from `createApp`.
 */
export function startDefaultLlmUsageSink(): void {
  if (process.env.LLM_USAGE_TELEMETRY_ENABLED === "false") {
    return;
  }
  if (defaultSink) return;

  defaultSink = createLlmUsageSink({
    writeBatch: async (docs) => {
      const container = await waitForLlmUsageContainer(10, 500);
      const { failed } = await writeLlmUsageBatch(container, docs);
      if (failed > 0) {
        console.warn(`⚠️ llmUsageSink: ${failed}/${docs.length} rows failed to persist`);
      }
    },
  });
  defaultSink.start();
}

/** Test / shutdown helper — stops and forgets the default sink. */
export function __stopDefaultLlmUsageSinkForTest(): void {
  defaultSink?.dispose();
  defaultSink = null;
}
