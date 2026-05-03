/**
 * Wave A3 · persistence queue contract.
 *
 * Pins:
 *   1. Successful enqueue calls the writer and fires onSuccess exactly once.
 *   2. Transient failures retry with backoff and ultimately succeed.
 *   3. Exhausted retries fire onFailure exactly once with the last error.
 *   4. Concurrent enqueues for the same session are serialised (ordered).
 *   5. Concurrent enqueues for different sessions run in parallel.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.AZURE_OPENAI_API_KEY ??= "test";
process.env.AZURE_OPENAI_ENDPOINT ??= "https://test.openai.azure.com";
process.env.AZURE_OPENAI_DEPLOYMENT_NAME ??= "test-deployment";

const {
  enqueuePersist,
  __setPersistWriter,
  __setPersistSleeper,
} = await import("../lib/persistenceQueue.js");
import type { Message } from "../shared/schema.js";

const fakeMessages = (n = 1): Message[] =>
  Array.from({ length: n }, (_, i) => ({
    role: "assistant" as const,
    content: `m${i}`,
    timestamp: 1000 + i,
  }));

describe("persistenceQueue · A3 contract", () => {
  it("calls the writer once and fires onSuccess on a clean save", async () => {
    let writerCalls = 0;
    const restoreW = __setPersistWriter(async () => {
      writerCalls++;
      return {} as never;
    });
    const restoreS = __setPersistSleeper(async () => {});
    let okCount = 0;
    let failCount = 0;
    try {
      const { promise } = enqueuePersist({
        sessionId: "s-clean",
        messages: fakeMessages(),
        onSuccess: () => okCount++,
        onFailure: () => failCount++,
      });
      const outcome = await promise;
      assert.equal(outcome, "succeeded");
      assert.equal(writerCalls, 1);
      assert.equal(okCount, 1);
      assert.equal(failCount, 0);
    } finally {
      restoreW();
      restoreS();
    }
  });

  it("retries transient failures and ultimately succeeds", async () => {
    let writerCalls = 0;
    const restoreW = __setPersistWriter(async () => {
      writerCalls++;
      if (writerCalls < 3) throw new Error("transient");
      return {} as never;
    });
    const restoreS = __setPersistSleeper(async () => {});
    let attemptFailures: number[] = [];
    let okCount = 0;
    try {
      const { promise } = enqueuePersist({
        sessionId: "s-flaky",
        messages: fakeMessages(),
        onAttemptFailed: (_e, n) => attemptFailures.push(n),
        onSuccess: () => okCount++,
      });
      const outcome = await promise;
      assert.equal(outcome, "succeeded");
      assert.equal(writerCalls, 3);
      assert.deepEqual(attemptFailures, [1, 2]);
      assert.equal(okCount, 1);
    } finally {
      restoreW();
      restoreS();
    }
  });

  it("fires onFailure once after maxAttempts is exhausted", async () => {
    const restoreW = __setPersistWriter(async () => {
      throw new Error("permanent");
    });
    const restoreS = __setPersistSleeper(async () => {});
    let okCount = 0;
    let failCount = 0;
    let lastErr: Error | null = null;
    try {
      const { promise } = enqueuePersist({
        sessionId: "s-doomed",
        messages: fakeMessages(),
        maxAttempts: 2,
        onSuccess: () => okCount++,
        onFailure: (err) => {
          failCount++;
          lastErr = err;
        },
      });
      const outcome = await promise;
      assert.equal(outcome, "failed");
      assert.equal(okCount, 0);
      assert.equal(failCount, 1);
      assert.match(lastErr?.message ?? "", /permanent/);
    } finally {
      restoreW();
      restoreS();
    }
  });

  it("serialises concurrent enqueues for the SAME session", async () => {
    const order: string[] = [];
    const restoreW = __setPersistWriter(async (sessionId, messages) => {
      const tag = `${sessionId}:${(messages[0]?.content ?? "").slice(0, 4)}`;
      order.push(`start-${tag}`);
      await new Promise((r) => setTimeout(r, 10));
      order.push(`end-${tag}`);
      return {} as never;
    });
    const restoreS = __setPersistSleeper(async () => {});
    try {
      const a = enqueuePersist({
        sessionId: "s-serial",
        messages: [{ role: "user", content: "AAAA", timestamp: 1 }],
      }).promise;
      const b = enqueuePersist({
        sessionId: "s-serial",
        messages: [{ role: "user", content: "BBBB", timestamp: 2 }],
      }).promise;
      await Promise.all([a, b]);
      // A must complete before B starts — same session.
      assert.deepEqual(order, [
        "start-s-serial:AAAA",
        "end-s-serial:AAAA",
        "start-s-serial:BBBB",
        "end-s-serial:BBBB",
      ]);
    } finally {
      restoreW();
      restoreS();
    }
  });

  it("does NOT serialise enqueues for DIFFERENT sessions", async () => {
    let concurrent = 0;
    let peakConcurrent = 0;
    const restoreW = __setPersistWriter(async () => {
      concurrent++;
      peakConcurrent = Math.max(peakConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 10));
      concurrent--;
      return {} as never;
    });
    const restoreS = __setPersistSleeper(async () => {});
    try {
      const a = enqueuePersist({
        sessionId: "s-A",
        messages: fakeMessages(),
      }).promise;
      const b = enqueuePersist({
        sessionId: "s-B",
        messages: fakeMessages(),
      }).promise;
      await Promise.all([a, b]);
      assert.equal(peakConcurrent, 2, "different sessions should run in parallel");
    } finally {
      restoreW();
      restoreS();
    }
  });
});
