/**
 * shouldRunFeatureSweep — the single depth-budget enforcement point for the
 * cross-dimension feature sweep (one "outcome by <dim>" chart per categorical
 * column).
 *
 * Pins the contract that fixes the "pointed question → 16 charts" report:
 *   - a `standard` descriptive/trend ask does NOT sweep,
 *   - an explicit dashboard ask, `full` (diagnostic/strategic) depth, or an
 *     explicit breadth request DOES sweep.
 *
 * The previous gate fired on `!minimal`, which let every `standard` trend
 * question fan out one chart per dimension. This locks that door.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldRunFeatureSweep } from "../lib/agents/runtime/dashboardFeatureSweep.js";

const base = {
  isExplicitDashboardAsk: false,
  breadthSignal: false,
  breadthEnabled: true,
  mode: "analysis" as const,
};

describe("shouldRunFeatureSweep · depth-budget gate", () => {
  it("standard depth (pointed trend/descriptive) → NO sweep", () => {
    assert.equal(
      shouldRunFeatureSweep({ ...base, depthBudget: "standard" }),
      false
    );
  });

  it("minimal depth (plain lookup) → NO sweep", () => {
    assert.equal(
      shouldRunFeatureSweep({ ...base, depthBudget: "minimal" }),
      false
    );
  });

  it("full depth (diagnostic/strategic) → sweep", () => {
    assert.equal(
      shouldRunFeatureSweep({ ...base, depthBudget: "full" }),
      true
    );
  });

  it("explicit breadth signal on a standard turn → sweep", () => {
    assert.equal(
      shouldRunFeatureSweep({
        ...base,
        depthBudget: "standard",
        breadthSignal: true,
      }),
      true
    );
  });

  it("explicit dashboard ask → sweep regardless of depth/flag/mode", () => {
    assert.equal(
      shouldRunFeatureSweep({
        isExplicitDashboardAsk: true,
        depthBudget: "minimal",
        breadthSignal: false,
        breadthEnabled: false,
        mode: "chat",
      }),
      true
    );
  });

  it("breadth disabled (flag off) → no sweep even for full depth", () => {
    assert.equal(
      shouldRunFeatureSweep({
        ...base,
        breadthEnabled: false,
        depthBudget: "full",
      }),
      false
    );
  });

  it("non-analysis mode → no sweep (unless explicit dashboard ask)", () => {
    assert.equal(
      shouldRunFeatureSweep({ ...base, mode: "chat", depthBudget: "full" }),
      false
    );
  });

  it("undefined depthBudget without breadth signal → no sweep", () => {
    assert.equal(
      shouldRunFeatureSweep({ ...base, depthBudget: undefined }),
      false
    );
  });
});
