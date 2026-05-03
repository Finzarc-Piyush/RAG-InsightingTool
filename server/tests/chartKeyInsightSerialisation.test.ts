import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { __chartKeyInsight_test__ } from "../controllers/sessionController.js";

const { runSerialisedPerSession } = __chartKeyInsight_test__;

/**
 * RL2 · per-session mutex behaviour. Mirrors the W40 sessionPersistChain
 * pattern: same-sessionId callers serialise; different sessionIds run in
 * parallel; an earlier failure does not block subsequent calls.
 */

describe("chart-key-insight per-session serialisation", () => {
  it("serialises calls for the same sessionId", async () => {
    const events: string[] = [];
    const make = (label: string, ms: number) => async () => {
      events.push(`${label}:start`);
      await new Promise((r) => setTimeout(r, ms));
      events.push(`${label}:end`);
      return label;
    };

    const p1 = runSerialisedPerSession("s1", make("a", 30));
    const p2 = runSerialisedPerSession("s1", make("b", 5));
    const p3 = runSerialisedPerSession("s1", make("c", 5));
    const out = await Promise.all([p1, p2, p3]);
    assert.deepStrictEqual(out, ["a", "b", "c"]);
    // No interleaving — every start is followed by its end before the next start
    assert.deepStrictEqual(events, [
      "a:start",
      "a:end",
      "b:start",
      "b:end",
      "c:start",
      "c:end",
    ]);
  });

  it("runs different sessionIds in parallel", async () => {
    const startedAt: Record<string, number> = {};
    const make = (label: string) => async () => {
      startedAt[label] = Date.now();
      await new Promise((r) => setTimeout(r, 25));
      return label;
    };
    const start = Date.now();
    const [a, b] = await Promise.all([
      runSerialisedPerSession("sA", make("a")),
      runSerialisedPerSession("sB", make("b")),
    ]);
    assert.strictEqual(a, "a");
    assert.strictEqual(b, "b");
    // Both started within a few ms — they ran in parallel.
    const skew = Math.abs(startedAt.a - startedAt.b);
    assert.ok(skew < 15, `expected parallel start (skew ${skew}ms)`);
    // Total wall time well below 50ms (= sequential lower bound)
    const wall = Date.now() - start;
    assert.ok(wall < 60, `expected parallel finish (wall ${wall}ms)`);
  });

  it("an earlier failure does not block subsequent calls", async () => {
    const p1 = runSerialisedPerSession("s2", async () => {
      throw new Error("boom");
    });
    await assert.rejects(p1, /boom/);
    const p2 = await runSerialisedPerSession("s2", async () => "after");
    assert.strictEqual(p2, "after");
  });
});
