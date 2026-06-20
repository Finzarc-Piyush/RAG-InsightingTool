import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  hasHedge,
  STAT_NUMBER_RE,
} from "../lib/agents/runtime/verifierCausalCheck.js";

/**
 * Wave 1 (chart-insight convergence) · the per-chart insight generator reuses
 * the SAME hedge rail as the answer envelope's likelyDrivers lane, instead of
 * rolling its own. That requires `hasHedge` and `STAT_NUMBER_RE` — previously
 * module-private — to be exported. This pins their availability + behavior so a
 * future refactor can't silently un-export them out from under the generator
 * (L-022: the gate primitive must be available before the prompt opens the WHY
 * permission). Behavior-parity with verifierCausalCheck.test.ts.
 */
describe("hedge gate primitives are exported and behave", () => {
  it("hasHedge accepts a clearly-hedged hypothesis", () => {
    assert.equal(hasHedge("likely seasonal demand"), true);
    assert.equal(hasHedge("may reflect stronger metro distribution"), true);
    assert.equal(hasHedge("consistent with a festive uplift"), true);
  });

  it("hasHedge rejects a bare causal assertion", () => {
    assert.equal(hasHedge("prices fell"), false);
    assert.equal(hasHedge("X caused Y"), false);
  });

  it("STAT_NUMBER_RE matches statistic-shaped numbers", () => {
    assert.equal(STAT_NUMBER_RE.test("up 12%"), true);
    assert.equal(STAT_NUMBER_RE.test("nearly 4x higher"), true);
    assert.equal(STAT_NUMBER_RE.test("0.742 share"), true);
  });

  it("STAT_NUMBER_RE leaves ordinals / category labels alone", () => {
    assert.equal(STAT_NUMBER_RE.test("first-class passengers"), false);
    assert.equal(STAT_NUMBER_RE.test("Pclass 3"), false);
  });
});
