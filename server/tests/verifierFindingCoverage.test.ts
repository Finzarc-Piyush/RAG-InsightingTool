import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createBlackboard,
  addFinding,
} from "../lib/agents/runtime/analyticalBlackboard.js";
import { checkMissingFindings, buildFinalEvidence } from "../lib/agents/runtime/verifierHelpers.js";

describe("checkMissingFindings", () => {
  it("returns MISSING_FINDING issue when anomalous finding label absent from candidate", () => {
    const bb = createBlackboard();
    addFinding(bb, {
      sourceRef: "call_001",
      label: "East region spike anomaly",
      detail: "East region shows unexpected +340% in March vs prior year",
      significance: "anomalous",
    });

    const candidate = "Sales declined overall due to market conditions.";
    const issues = checkMissingFindings(candidate, bb);

    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].code, "MISSING_FINDING");
    assert.strictEqual(issues[0].severity, "medium");
    assert.ok(issues[0].description.includes("East region spike anomaly"));
    assert.deepStrictEqual(issues[0].evidenceRefs, ["f1"]);
  });

  it("returns no issues when label text appears in candidate", () => {
    const bb = createBlackboard();
    addFinding(bb, {
      sourceRef: "call_002",
      label: "East region anomaly",
      detail: "Spike detected",
      significance: "anomalous",
    });

    const candidate = "The East region anomaly was the primary driver of the Q1 decline.";
    const issues = checkMissingFindings(candidate, bb);

    assert.strictEqual(issues.length, 0);
  });

  it("skips routine and notable findings — only flags anomalous", () => {
    const bb = createBlackboard();
    addFinding(bb, {
      sourceRef: "c1",
      label: "routine query result",
      detail: "10 rows returned",
      significance: "routine",
    });
    addFinding(bb, {
      sourceRef: "c2",
      label: "notable metric shift",
      detail: "Sales dropped 15%",
      significance: "notable",
    });

    const candidate = "Nothing unusual here.";
    const issues = checkMissingFindings(candidate, bb);

    assert.strictEqual(issues.length, 0);
  });

  it("multiple anomalous findings each get their own issue when uncited", () => {
    const bb = createBlackboard();
    addFinding(bb, {
      sourceRef: "c1",
      label: "Region spike in East",
      detail: "East unexpected jump",
      significance: "anomalous",
    });
    addFinding(bb, {
      sourceRef: "c2",
      label: "Category outlier Electronics",
      detail: "Electronics anomalous drop",
      significance: "anomalous",
    });

    const candidate = "Overall sales were mixed.";
    const issues = checkMissingFindings(candidate, bb);

    assert.strictEqual(issues.length, 2);
    assert.ok(issues.every((i) => i.code === "MISSING_FINDING"));
  });

  it("returns empty array when blackboard has no findings", () => {
    const bb = createBlackboard();
    const issues = checkMissingFindings("any candidate", bb);
    assert.strictEqual(issues.length, 0);
  });
});

describe("buildFinalEvidence (W12b)", () => {
  it("includes blackboard finding detail text in output", () => {
    const bb = createBlackboard();
    addFinding(bb, {
      sourceRef: "c1",
      label: "East region decline",
      detail: "East region shows a 34% drop in Q1 vs prior year",
      significance: "anomalous",
    });

    const result = buildFinalEvidence(["obs1"], "SalesChart:Region/Sales", bb, undefined);

    assert.ok(result.includes("34% drop"), "finding detail should be in evidence");
    assert.ok(result.includes("BLACKBOARD"), "should have BLACKBOARD section");
    assert.ok(result.includes("obs1"), "should include observations");
    assert.ok(result.includes("SalesChart"), "should include chart titles");
  });

  it("includes MAGNITUDES block when magnitudes provided", () => {
    const result = buildFinalEvidence(
      [],
      "",
      undefined,
      [{ label: "East tech decline", value: "-23.4%", confidence: "high" }]
    );

    assert.ok(result.includes("MAGNITUDES"), "should have MAGNITUDES section");
    assert.ok(result.includes("-23.4%"), "should include magnitude value");
    assert.ok(result.includes("East tech decline"), "should include magnitude label");
    assert.ok(result.includes("(high)"), "should include confidence");
  });

  it("observations-only path when blackboard and magnitudes absent", () => {
    const result = buildFinalEvidence(["observation text"], "Chart1:x/y", undefined, undefined);

    assert.ok(result.includes("observation text"));
    assert.ok(result.includes("Chart1:x/y"));
    assert.ok(!result.includes("BLACKBOARD"));
    assert.ok(!result.includes("MAGNITUDES"));
  });

  it("caps output at 14000 chars", () => {
    const obs = Array.from({ length: 200 }, (_, i) => `observation_${i}: ${"x".repeat(100)}`);
    const bb = createBlackboard();
    addFinding(bb, { sourceRef: "c1", label: "Big finding", detail: "y".repeat(5000), significance: "anomalous" });
    const result = buildFinalEvidence(obs, "", bb, undefined);
    assert.ok(result.length <= 14000, `expected ≤14000, got ${result.length}`);
  });
});
