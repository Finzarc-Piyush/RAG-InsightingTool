/**
 * Wave R2 · reentrancy guard for `withSessionWriteLock`.
 *
 * The lock is a per-session promise chain; a nested call for the SAME session
 * inside an in-flight `fn` would await the outer call's own promise and
 * deadlock forever. The guard converts that hang into a fast, clear error.
 * Different sessions may still nest safely.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  withSessionWriteLock,
  __resetSessionWriteChainForTesting,
} from "../lib/sessionWriteLock.js";

test("reentrant same-session lock throws instead of deadlocking", async () => {
  __resetSessionWriteChainForTesting();
  await assert.rejects(
    () =>
      withSessionWriteLock("S1", async () => {
        // Nested acquire for the SAME session — must fail fast, not hang.
        return withSessionWriteLock("S1", async () => "inner");
      }),
    /non-reentrant/
  );
});

test("nested locks for DIFFERENT sessions are allowed", async () => {
  __resetSessionWriteChainForTesting();
  const result = await withSessionWriteLock("A", async () => {
    const inner = await withSessionWriteLock("B", async () => "B-done");
    return `A:${inner}`;
  });
  assert.equal(result, "A:B-done");
});

test("non-nested sequential acquires still serialize and return", async () => {
  __resetSessionWriteChainForTesting();
  const order: number[] = [];
  const p1 = withSessionWriteLock("S2", async () => {
    order.push(1);
    return 1;
  });
  const p2 = withSessionWriteLock("S2", async () => {
    order.push(2);
    return 2;
  });
  assert.deepEqual(await Promise.all([p1, p2]), [1, 2]);
  assert.deepEqual(order, [1, 2]);
});
