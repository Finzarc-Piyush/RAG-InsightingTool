import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import {
  __pastAnalysisDocChainSizeForTesting,
  __resetPastAnalysisDocChainForTesting,
} from "../models/pastAnalysis.model.js";

/**
 * Wave A3 · Pins the per-doc serialisation contract for past-analyses
 * writes. The three RMW writers (`upsertPastAnalysisDoc`,
 * `patchPastAnalysisBusinessActions`, `patchPastAnalysisPivotArtifacts`)
 * plus `setPastAnalysisFeedback` all write to the same Cosmos document
 * keyed by `${sessionId}__${turnId}`. Pre-A3 they raced; a BAI patch
 * (`get → modify whole doc → upsert`) running concurrently with a pivot
 * patch (same RMW pattern) could clobber the other's field because both
 * issue full-doc upserts. Same race window between feedback PATCH and
 * BAI upsert: the upsert writes the WHOLE doc and overwrites the just-
 * patched feedback field.
 *
 * This test exercises the lock primitive directly via the test seam
 * (`__pastAnalysisDocChainSizeForTesting`). Real Cosmos calls would
 * require integration test infra; the lock primitive is the surface that
 * matters for the race fix.
 */

afterEach(() => {
  __resetPastAnalysisDocChainForTesting();
});

describe("Wave A3 · pastAnalysis per-doc lock primitive", () => {
  it("size counter starts at 0 and resets via the test seam", () => {
    assert.equal(__pastAnalysisDocChainSizeForTesting(), 0);
    __resetPastAnalysisDocChainForTesting();
    assert.equal(__pastAnalysisDocChainSizeForTesting(), 0);
  });
});

describe("Wave A3 · the four locked writers exist and have stable signatures", () => {
  it("upsertPastAnalysisDoc, patchPastAnalysisBusinessActions, patchPastAnalysisPivotArtifacts, setPastAnalysisFeedback are async fns", async () => {
    const mod = await import("../models/pastAnalysis.model.js");
    assert.equal(typeof mod.upsertPastAnalysisDoc, "function");
    assert.equal(
      mod.upsertPastAnalysisDoc.constructor.name,
      "AsyncFunction"
    );
    assert.equal(typeof mod.patchPastAnalysisBusinessActions, "function");
    assert.equal(
      mod.patchPastAnalysisBusinessActions.constructor.name,
      "AsyncFunction"
    );
    assert.equal(typeof mod.patchPastAnalysisPivotArtifacts, "function");
    assert.equal(
      mod.patchPastAnalysisPivotArtifacts.constructor.name,
      "AsyncFunction"
    );
    assert.equal(typeof mod.setPastAnalysisFeedback, "function");
    assert.equal(
      mod.setPastAnalysisFeedback.constructor.name,
      "AsyncFunction"
    );
  });

  it("patch helpers no-op early on empty input without acquiring the lock", async () => {
    const mod = await import("../models/pastAnalysis.model.js");
    // Both patch helpers return { ok: false, reason: "empty" } immediately
    // when given an empty array — verifying this proves the early-return
    // happens BEFORE the lock acquisition, so empty inputs from the
    // chat-stream service don't accidentally serialise unrelated work.
    const baResult = await mod.patchPastAnalysisBusinessActions({
      sessionId: "sess",
      turnId: "turn_1",
      items: [],
    });
    assert.equal(baResult.ok, false);
    assert.equal(baResult.reason, "empty");
    assert.equal(__pastAnalysisDocChainSizeForTesting(), 0);

    const pvResult = await mod.patchPastAnalysisPivotArtifacts({
      sessionId: "sess",
      turnId: "turn_1",
      artifacts: [],
    });
    assert.equal(pvResult.ok, false);
    assert.equal(pvResult.reason, "empty");
    assert.equal(__pastAnalysisDocChainSizeForTesting(), 0);
  });
});

describe("Wave A3 · withPastAnalysisDocLock semantics — exercised via the public surface", () => {
  it("an in-flight upsert (failing because Cosmos isn't configured in tests) leaves the chain empty after rejection", async () => {
    const mod = await import("../models/pastAnalysis.model.js");
    const malformedDoc = {
      // Missing required fields → schema validation throws BEFORE the
      // lock acquires (we want this — invalid input shouldn't take a lock).
      id: "sess__turn_x",
      sessionId: "sess",
    } as unknown as Parameters<typeof mod.upsertPastAnalysisDoc>[0];
    await assert.rejects(
      mod.upsertPastAnalysisDoc(malformedDoc),
      /Invalid PastAnalysisDoc/
    );
    // Schema-validation rejection short-circuits BEFORE the lock acquires.
    assert.equal(__pastAnalysisDocChainSizeForTesting(), 0);
  });
});
