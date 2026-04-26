import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
  createLlmUsageSink,
} from "../lib/telemetry/llmUsageSink.js";
import {
  emitLlmUsage,
  __clearLlmUsageListenersForTest,
  type LlmCallUsage,
} from "../lib/agents/runtime/llmUsageEmitter.js";
import { withRequestContext } from "../lib/telemetry/requestContext.js";
import type { LlmUsageDoc } from "../models/llmUsage.model.js";

/**
 * W1.3 · The sink bridges the in-process emitter to Cosmos. These tests
 * exercise every failure mode that could drop or double-count rows:
 *   - size-triggered flush, interval-triggered flush
 *   - write errors swallowed (telemetry must never break a turn)
 *   - dispose cleans up timers + subscription
 *   - ALS request context stamped into docs
 *   - missing turnId falls back to the no-turn partition
 */

const usage = (overrides: Partial<LlmCallUsage> = {}): LlmCallUsage => ({
  model: "gpt-4o",
  promptTokens: 100,
  completionTokens: 50,
  costUsd: 0.001,
  latencyMs: 123,
  attempt: 1,
  turnId: "turn_x",
  ...overrides,
});

describe("createLlmUsageSink", () => {
  afterEach(() => {
    __clearLlmUsageListenersForTest();
  });

  it("flushes when the buffer reaches maxBuffer", async () => {
    const batches: LlmUsageDoc[][] = [];
    const sink = createLlmUsageSink({
      writeBatch: async (docs) => {
        batches.push(docs);
      },
      maxBuffer: 3,
      flushIntervalMs: 60_000, // never fires during this test
    });
    sink.start();
    emitLlmUsage(usage());
    emitLlmUsage(usage());
    assert.strictEqual(sink.pendingCount(), 2, "below threshold: still buffered");
    emitLlmUsage(usage());
    // Size trigger fires asynchronously (void flushNow). Yield once for the
    // microtask queue to drain.
    await sleep(5);
    assert.strictEqual(batches.length, 1, "size trigger fired exactly once");
    assert.strictEqual(batches[0].length, 3, "batch contained all 3 events");
    sink.dispose();
  });

  it("flushes on the interval timer", async () => {
    const batches: LlmUsageDoc[][] = [];
    const sink = createLlmUsageSink({
      writeBatch: async (docs) => {
        batches.push(docs);
      },
      maxBuffer: 1000, // size trigger disabled for this test
      flushIntervalMs: 15,
    });
    sink.start();
    emitLlmUsage(usage());
    emitLlmUsage(usage());
    await sleep(50);
    assert.ok(batches.length >= 1, `expected ≥1 timer flush, got ${batches.length}`);
    assert.strictEqual(batches[0].length, 2);
    sink.dispose();
  });

  it("swallows writer errors — telemetry must never propagate", async () => {
    const errors: Array<{ err: unknown; dropped: number }> = [];
    const sink = createLlmUsageSink({
      writeBatch: async () => {
        throw new Error("cosmos unreachable");
      },
      maxBuffer: 2,
      flushIntervalMs: 60_000,
      onWriteError: (err, dropped) => {
        errors.push({ err, dropped });
      },
    });
    sink.start();
    // Fire two events → triggers flush → writer throws → onWriteError fires.
    emitLlmUsage(usage());
    emitLlmUsage(usage());
    await sleep(5);
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].dropped, 2);
    // Sink keeps running: next event goes into a fresh buffer.
    emitLlmUsage(usage());
    assert.strictEqual(sink.pendingCount(), 1);
    sink.dispose();
  });

  it("dispose unsubscribes from the emitter and cancels the timer", async () => {
    const batches: LlmUsageDoc[][] = [];
    const sink = createLlmUsageSink({
      writeBatch: async (docs) => {
        batches.push(docs);
      },
      maxBuffer: 1,
      flushIntervalMs: 60_000,
    });
    sink.start();
    sink.dispose();
    emitLlmUsage(usage());
    await sleep(5);
    assert.strictEqual(batches.length, 0, "no batches after dispose");
    assert.strictEqual(sink.pendingCount(), 0, "events after dispose are ignored");
  });

  it("start() is idempotent — a second call does not create duplicate listeners", async () => {
    const batches: LlmUsageDoc[][] = [];
    const sink = createLlmUsageSink({
      writeBatch: async (docs) => {
        batches.push(docs);
      },
      maxBuffer: 1,
      flushIntervalMs: 60_000,
    });
    sink.start();
    sink.start();
    emitLlmUsage(usage());
    await sleep(5);
    assert.strictEqual(batches.length, 1);
    assert.strictEqual(batches[0].length, 1, "event received once, not twice");
    sink.dispose();
  });

  it("flushNow is a no-op when buffer is empty", async () => {
    const batches: LlmUsageDoc[][] = [];
    const sink = createLlmUsageSink({
      writeBatch: async (docs) => {
        batches.push(docs);
      },
      maxBuffer: 100,
      flushIntervalMs: 60_000,
    });
    sink.start();
    await sink.flushNow();
    assert.strictEqual(batches.length, 0);
    sink.dispose();
  });

  it("stamps docs with sessionId/userId from the async-local request context", async () => {
    const batches: LlmUsageDoc[][] = [];
    const sink = createLlmUsageSink({
      writeBatch: async (docs) => {
        batches.push(docs);
      },
      maxBuffer: 1,
      flushIntervalMs: 60_000,
    });
    sink.start();
    await withRequestContext(
      { sessionId: "sess_123", userId: "user@example.com", turnId: "turn_als" },
      async () => {
        emitLlmUsage(usage({ turnId: undefined })); // falls back to ctx.turnId
        await sleep(5);
      }
    );
    assert.strictEqual(batches.length, 1);
    const [doc] = batches[0];
    assert.strictEqual(doc.sessionId, "sess_123");
    assert.strictEqual(doc.userId, "user@example.com");
    assert.strictEqual(doc.turnId, "turn_als");
    sink.dispose();
  });

  it("uses the no-turn partition when neither usage.turnId nor ALS provides one", async () => {
    const batches: LlmUsageDoc[][] = [];
    const sink = createLlmUsageSink({
      writeBatch: async (docs) => {
        batches.push(docs);
      },
      maxBuffer: 1,
      flushIntervalMs: 60_000,
    });
    sink.start();
    emitLlmUsage(usage({ turnId: undefined }));
    await sleep(5);
    assert.strictEqual(batches.length, 1);
    assert.strictEqual(batches[0][0].turnId, "__no_turn__");
    sink.dispose();
  });

  it("propagates optional fields (purpose, cachedPromptTokens) verbatim", async () => {
    const batches: LlmUsageDoc[][] = [];
    const sink = createLlmUsageSink({
      writeBatch: async (docs) => {
        batches.push(docs);
      },
      maxBuffer: 1,
      flushIntervalMs: 60_000,
    });
    sink.start();
    emitLlmUsage(
      usage({ purpose: "mode_classify", cachedPromptTokens: 40, attempt: 2 })
    );
    await sleep(5);
    assert.strictEqual(batches.length, 1);
    const [doc] = batches[0];
    assert.strictEqual(doc.purpose, "mode_classify");
    assert.strictEqual(doc.cachedPromptTokens, 40);
    assert.strictEqual(doc.attempt, 2);
    sink.dispose();
  });

  it("generates unique ids for events in the same turn", async () => {
    const batches: LlmUsageDoc[][] = [];
    const sink = createLlmUsageSink({
      writeBatch: async (docs) => {
        batches.push(docs);
      },
      maxBuffer: 10,
      flushIntervalMs: 60_000,
    });
    sink.start();
    for (let i = 0; i < 10; i++) emitLlmUsage(usage());
    await sink.flushNow();
    const ids = new Set(batches[0].map((d) => d.id));
    assert.strictEqual(ids.size, 10, "all ids unique within the turn");
    sink.dispose();
  });
});
