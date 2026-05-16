/**
 * Wave WV1 · verifier-side confidence overclaim detector tests.
 *
 * Covers:
 *  - Aggregate tier counting from narrator magnitudes + implications.
 *  - All three flag kinds (high-exceeds, all-high-with-low, over-hedge).
 *  - shouldRevise true iff a warning or block flag fires.
 *  - Empty-blackboard short-circuit (no flags when WQ1 can't classify).
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { detectConfidenceOverclaims } from "../lib/agents/runtime/verifierConfidenceCheck.js";
import {
  addFinding,
  createBlackboard,
} from "../lib/agents/runtime/analyticalBlackboard.js";
import type { NarratorOutput } from "../lib/agents/runtime/narratorAgent.js";

function magnitudes(...tiers: Array<"high" | "medium" | "low" | undefined>) {
  return tiers.map((confidence, i) => ({
    label: `m${i}`,
    value: `${i}`,
    confidence,
  }));
}

function implications(...tiers: Array<"high" | "medium" | "low" | undefined>) {
  return tiers.map((confidence, i) => ({
    statement: `s${i}`,
    soWhat: `w${i}`,
    confidence,
  }));
}

describe("Wave WV1 · detectConfidenceOverclaims · tier counting", () => {
  it("counts claimed tiers across magnitudes + implications", () => {
    const out: NarratorOutput = {
      body: "",
      magnitudes: magnitudes("high", "low"),
      implications: implications("medium", "high"),
    };
    const bb = createBlackboard();
    const report = detectConfidenceOverclaims(out, bb);
    assert.equal(report.claimed.total, 4);
    assert.equal(report.claimed.high, 2);
    assert.equal(report.claimed.medium, 1);
    assert.equal(report.claimed.low, 1);
  });

  it("treats missing confidence field as medium", () => {
    const out: NarratorOutput = {
      body: "",
      magnitudes: magnitudes(undefined, undefined, "high"),
    };
    const report = detectConfidenceOverclaims(out, createBlackboard());
    assert.equal(report.claimed.medium, 2);
    assert.equal(report.claimed.high, 1);
  });

  it("counts actual tiers from blackboard findings via WQ1", () => {
    const bb = createBlackboard();
    addFinding(bb, {
      sourceRef: "a",
      label: "Solid",
      detail: "R² = 0.7, n = 500, p < 0.001.",
      significance: "notable",
    });
    addFinding(bb, { sourceRef: "b", label: "Tentative", detail: "n = 5", significance: "notable" });
    const report = detectConfidenceOverclaims({ body: "" }, bb);
    assert.equal(report.actual.total, 2);
    assert.equal(report.actual.high, 1);
    assert.equal(report.actual.low, 1);
  });
});

describe("Wave WV1 · flag rules", () => {
  it("fires narrator_high_exceeds_blackboard_high (warning) when narrator claims more high than evidence supports", () => {
    const out: NarratorOutput = {
      body: "",
      magnitudes: magnitudes("high", "high", "high"),
    };
    const bb = createBlackboard();
    addFinding(bb, { sourceRef: "a", label: "x", detail: "n = 5", significance: "notable" });
    const report = detectConfidenceOverclaims(out, bb);
    const flag = report.flags.find((f) => f.kind === "narrator_high_exceeds_blackboard_high");
    assert.ok(flag, "expected high-exceeds flag");
    assert.equal(flag?.severity, "warning");
    assert.equal(report.shouldRevise, true);
  });

  it("fires narrator_all_high_with_low_in_blackboard (block) when narrator marks every magnitude high but blackboard has low findings", () => {
    const out: NarratorOutput = {
      body: "",
      magnitudes: magnitudes("high", "high"),
    };
    const bb = createBlackboard();
    addFinding(bb, { sourceRef: "a", label: "low", detail: "n = 5", significance: "notable" });
    addFinding(bb, {
      sourceRef: "b",
      label: "high",
      detail: "R² = 0.7, n = 500, p < 0.001.",
      significance: "notable",
    });
    const report = detectConfidenceOverclaims(out, bb);
    const blockFlag = report.flags.find((f) => f.kind === "narrator_all_high_with_low_in_blackboard");
    assert.ok(blockFlag, "expected block-level flag");
    assert.equal(blockFlag?.severity, "block");
    assert.equal(report.shouldRevise, true);
  });

  it("fires narrator_low_exceeds_blackboard_lowish (info) when narrator over-hedges", () => {
    const out: NarratorOutput = {
      body: "",
      magnitudes: magnitudes("low", "low", "low"),
    };
    const bb = createBlackboard();
    addFinding(bb, {
      sourceRef: "a",
      label: "high",
      detail: "R² = 0.7, n = 500, p < 0.001.",
      significance: "notable",
    });
    const report = detectConfidenceOverclaims(out, bb);
    const infoFlag = report.flags.find((f) => f.kind === "narrator_low_exceeds_blackboard_lowish");
    assert.ok(infoFlag, "expected info-level flag");
    assert.equal(infoFlag?.severity, "info");
    // info alone does NOT trigger revise — verifier should only re-run on
    // warning/block flags.
    assert.equal(report.shouldRevise, false);
  });

  it("emits zero flags when claimed tiers match actual exactly", () => {
    const out: NarratorOutput = {
      body: "",
      magnitudes: magnitudes("high", "low"),
    };
    const bb = createBlackboard();
    addFinding(bb, {
      sourceRef: "a",
      label: "high",
      detail: "R² = 0.7, n = 500, p < 0.001.",
      significance: "notable",
    });
    addFinding(bb, { sourceRef: "b", label: "low", detail: "n = 5", significance: "notable" });
    const report = detectConfidenceOverclaims(out, bb);
    assert.equal(report.flags.length, 0);
    assert.equal(report.shouldRevise, false);
  });

  it("does not fire high-exceeds when the blackboard has zero findings (WQ1 cannot classify)", () => {
    const out: NarratorOutput = {
      body: "",
      magnitudes: magnitudes("high", "high"),
    };
    const report = detectConfidenceOverclaims(out, createBlackboard());
    assert.equal(report.flags.length, 0);
    assert.equal(report.shouldRevise, false);
  });

  it("suppresses all-high+low flag when narrator has at least one non-high magnitude", () => {
    const out: NarratorOutput = {
      body: "",
      // Even one medium prevents the "all high" claim — only the
      // high-exceeds rule fires here.
      magnitudes: magnitudes("high", "high", "medium"),
    };
    const bb = createBlackboard();
    addFinding(bb, { sourceRef: "a", label: "low", detail: "n = 5", significance: "notable" });
    const report = detectConfidenceOverclaims(out, bb);
    assert.equal(
      report.flags.find((f) => f.kind === "narrator_all_high_with_low_in_blackboard"),
      undefined,
    );
    // High-exceeds still fires because claimed.high (2) > actual.high (0).
    assert.ok(report.flags.find((f) => f.kind === "narrator_high_exceeds_blackboard_high"));
  });
});

describe("Wave WV1 · shouldRevise gate", () => {
  it("is true when at least one warning fires", () => {
    const out: NarratorOutput = { body: "", magnitudes: magnitudes("high") };
    const bb = createBlackboard();
    addFinding(bb, { sourceRef: "a", label: "x", detail: "n = 5", significance: "notable" });
    assert.equal(detectConfidenceOverclaims(out, bb).shouldRevise, true);
  });

  it("is false when only an info flag fires (over-hedge)", () => {
    const out: NarratorOutput = {
      body: "",
      magnitudes: magnitudes("low"),
    };
    const bb = createBlackboard();
    addFinding(bb, {
      sourceRef: "a",
      label: "x",
      detail: "R² = 0.7, n = 500, p < 0.001.",
      significance: "notable",
    });
    assert.equal(detectConfidenceOverclaims(out, bb).shouldRevise, false);
  });
});
