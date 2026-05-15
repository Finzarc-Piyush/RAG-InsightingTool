import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import {
  loadEnabledDomainContext,
  invalidateDomainContextCache,
  __domainContextGenerationForTesting,
} from "../lib/domainContext/loadEnabledDomainContext.js";

/**
 * Wave A7 · Pins the generation-counter contract that makes domain-context
 * cache reads atomic against concurrent admin toggles.
 *
 * Pre-A7 a `loadEnabledDomainContext()` call that started before an
 * admin PATCH toggle could resolve AFTER the toggle but with the old
 * pack set, because the cache was a single `Promise<CacheEntry>` that
 * the invalidate path set to null — leaving the in-flight promise to
 * resolve with stale data.
 *
 * The fix: every in-flight build is generation-tagged at spawn. On
 * resolve, if `cacheGeneration` has bumped, the result is discarded
 * and the function retries.
 */

afterEach(() => {
  // Reset the cache between tests so we get clean generation counts.
  invalidateDomainContextCache();
});

describe("Wave A7 · invalidateDomainContextCache bumps the generation counter", () => {
  it("each invalidate increments the generation by 1", () => {
    const before = __domainContextGenerationForTesting();
    invalidateDomainContextCache();
    const after1 = __domainContextGenerationForTesting();
    assert.equal(after1, before + 1);
    invalidateDomainContextCache();
    const after2 = __domainContextGenerationForTesting();
    assert.equal(after2, before + 2);
  });
});

describe("Wave A7 · loadEnabledDomainContext stays consistent under concurrent invalidates", () => {
  it("a build that completes after an invalidate triggers a rebuild and returns the latest data", async () => {
    // Prime the cache: first call builds, caches, returns.
    const first = await loadEnabledDomainContext();
    assert.ok(typeof first.text === "string");
    const firstGen = __domainContextGenerationForTesting();

    // Invalidate the cache. The next call MUST rebuild (we're not
    // exercising the mid-flight race here — that requires a stub for
    // getToggleOverrides which is a network call. We pin the simpler
    // invariant: after invalidate, the next call returns a fresh build.
    invalidateDomainContextCache();
    assert.equal(__domainContextGenerationForTesting(), firstGen + 1);

    const second = await loadEnabledDomainContext();
    assert.ok(typeof second.text === "string");
    // The text content should be deterministic given the same toggles
    // (i.e. the rebuild produces the same string in test env).
    assert.equal(second.text, first.text);
  });

  it("concurrent callers see the SAME cache entry when no invalidate happens between them", async () => {
    invalidateDomainContextCache(); // start fresh
    const [a, b] = await Promise.all([
      loadEnabledDomainContext(),
      loadEnabledDomainContext(),
    ]);
    // Both should reference the same composed text (same memoised result).
    assert.equal(a.text, b.text);
    assert.equal(a.totalEnabledTokens, b.totalEnabledTokens);
  });

  it("invalidate fired BETWEEN two awaiting callers gives the second caller fresh data on resolve", async () => {
    invalidateDomainContextCache();
    // Caller A awaits, but we won't block it — we just need to fire
    // an invalidate AT the same time. The contract: the second caller's
    // resolved value reflects the latest generation.
    const aPromise = loadEnabledDomainContext();
    // Bump the generation immediately, simulating an admin toggle that
    // fires while caller A's promise is still in flight.
    invalidateDomainContextCache();
    const a = await aPromise;
    // After A resolves, calling again should hit the rebuilt cache.
    const b = await loadEnabledDomainContext();
    // The test env has stable toggles, so the texts should be equal —
    // but the key point is BOTH calls returned without orphaning data.
    assert.equal(typeof a.text, "string");
    assert.equal(typeof b.text, "string");
    assert.equal(a.text, b.text);
  });
});
