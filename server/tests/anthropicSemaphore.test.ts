import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  acquireAnthropicSlot,
  withAnthropicSlot,
  __test__,
} from "../lib/agents/runtime/anthropicSemaphore.js";

/**
 * RL2 · in-process semaphore caps outbound Anthropic /v1/messages concurrency.
 * Pins:
 *  - up to N parallel acquisitions return immediately
 *  - the (N+1)th waits until a release happens
 *  - release is idempotent (calling twice does not free an extra slot)
 *  - withAnthropicSlot releases on success and on failure (try/finally)
 *  - waiters are FIFO
 */

describe("anthropicSemaphore", () => {
  afterEach(() => __test__.reset());

  it("allows up to ANTHROPIC_MAX_CONCURRENCY slots without blocking", async () => {
    process.env.ANTHROPIC_MAX_CONCURRENCY = "3";
    try {
      const r1 = await acquireAnthropicSlot();
      const r2 = await acquireAnthropicSlot();
      const r3 = await acquireAnthropicSlot();
      const state = __test__.state();
      assert.strictEqual(state.inFlight, 3);
      assert.strictEqual(state.queued, 0);
      r1();
      r2();
      r3();
      const after = __test__.state();
      assert.strictEqual(after.inFlight, 0);
    } finally {
      delete process.env.ANTHROPIC_MAX_CONCURRENCY;
    }
  });

  it("queues additional acquisitions until a slot is released", async () => {
    process.env.ANTHROPIC_MAX_CONCURRENCY = "2";
    try {
      const r1 = await acquireAnthropicSlot();
      const r2 = await acquireAnthropicSlot();
      let r3Acquired = false;
      const r3Promise = acquireAnthropicSlot().then((release) => {
        r3Acquired = true;
        return release;
      });
      // Yield so any synchronous resolution would happen
      await Promise.resolve();
      await Promise.resolve();
      assert.strictEqual(r3Acquired, false);
      assert.strictEqual(__test__.state().queued, 1);

      r1();
      const r3 = await r3Promise;
      assert.strictEqual(r3Acquired, true);
      assert.strictEqual(__test__.state().inFlight, 2);
      r2();
      r3();
    } finally {
      delete process.env.ANTHROPIC_MAX_CONCURRENCY;
    }
  });

  it("release is idempotent", async () => {
    process.env.ANTHROPIC_MAX_CONCURRENCY = "1";
    try {
      const r1 = await acquireAnthropicSlot();
      r1();
      r1(); // calling again must not decrement past zero or free a phantom slot
      assert.strictEqual(__test__.state().inFlight, 0);
      // A fresh acquire still works and shows inFlight=1, not 2
      const r2 = await acquireAnthropicSlot();
      assert.strictEqual(__test__.state().inFlight, 1);
      r2();
    } finally {
      delete process.env.ANTHROPIC_MAX_CONCURRENCY;
    }
  });

  it("withAnthropicSlot releases on success", async () => {
    process.env.ANTHROPIC_MAX_CONCURRENCY = "1";
    try {
      const out = await withAnthropicSlot(async () => "ok");
      assert.strictEqual(out, "ok");
      assert.strictEqual(__test__.state().inFlight, 0);
    } finally {
      delete process.env.ANTHROPIC_MAX_CONCURRENCY;
    }
  });

  it("withAnthropicSlot releases on failure", async () => {
    process.env.ANTHROPIC_MAX_CONCURRENCY = "1";
    try {
      await assert.rejects(
        () => withAnthropicSlot(async () => { throw new Error("boom"); }),
        /boom/
      );
      assert.strictEqual(__test__.state().inFlight, 0);
    } finally {
      delete process.env.ANTHROPIC_MAX_CONCURRENCY;
    }
  });

  it("waiters are released FIFO", async () => {
    process.env.ANTHROPIC_MAX_CONCURRENCY = "1";
    try {
      const r1 = await acquireAnthropicSlot();
      const order: number[] = [];
      const p2 = acquireAnthropicSlot().then((release) => {
        order.push(2);
        return release;
      });
      const p3 = acquireAnthropicSlot().then((release) => {
        order.push(3);
        return release;
      });
      r1();
      const r2 = await p2;
      r2();
      const r3 = await p3;
      r3();
      assert.deepStrictEqual(order, [2, 3]);
    } finally {
      delete process.env.ANTHROPIC_MAX_CONCURRENCY;
    }
  });
});
