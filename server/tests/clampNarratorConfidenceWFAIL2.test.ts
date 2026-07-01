import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { clampConfidenceToBlackboard } from "../lib/agents/runtime/clampNarratorConfidence.js";
import type { ConfidenceOverclaimReport } from "../lib/agents/runtime/verifierConfidenceCheck.js";

/**
 * W-FAIL2 · Deterministic confidence clamp. When the verifier flags a
 * CONFIDENCE_OVERCLAIM but the single-flow policy suppresses the rewrite, we
 * clamp the structured magnitude/implication confidence labels to what the
 * blackboard supports (no prose touched).
 */

type Mag = { label: string; value: string; confidence?: "low" | "medium" | "high" };
type Imp = { statement: string; soWhat: string; confidence?: "low" | "medium" | "high" };

const report = (over: Partial<ConfidenceOverclaimReport>): ConfidenceOverclaimReport => ({
  claimed: { high: 0, medium: 0, low: 0, total: 0 },
  actual: { high: 0, medium: 0, low: 0, total: 0 },
  flags: [],
  shouldRevise: false,
  ...over,
});

describe("W-FAIL2 clampConfidenceToBlackboard", () => {
  it("downgrades surplus highs to medium (the reproduced PCNO(R) bug)", () => {
    // claimed 2 high (1 magnitude + 1 implication), blackboard supports 0 high / 1 medium.
    const mags: Mag[] = [{ label: "PCNO(R) · gap", value: "1.35B", confidence: "high" }];
    const imps: Imp[] = [{ statement: "PCNO(R) leads the gap", soWhat: "scrutinise GTN", confidence: "high" }];
    const r = report({
      claimed: { high: 2, medium: 0, low: 0, total: 2 },
      actual: { high: 0, medium: 1, low: 0, total: 1 },
      flags: [
        {
          kind: "narrator_high_exceeds_blackboard_high",
          severity: "warning",
          numbers: { narrator: 2, blackboard: 0 },
          message: "…",
        },
      ],
      shouldRevise: true,
    });

    const out = clampConfidenceToBlackboard(mags, imps, r);
    assert.equal(out.changed, true);
    assert.equal(out.downgradedHigh, 2);
    assert.equal(out.magnitudes![0]!.confidence, "medium");
    assert.equal(out.implications![0]!.confidence, "medium");
    // inputs untouched (pure)
    assert.equal(mags[0]!.confidence, "high");
  });

  it("keeps `actual.high` highs and downgrades the rest, magnitudes first", () => {
    const mags: Mag[] = [
      { label: "A", value: "1", confidence: "high" },
      { label: "B", value: "2", confidence: "high" },
    ];
    const imps: Imp[] = [{ statement: "C", soWhat: "c", confidence: "high" }];
    const r = report({
      claimed: { high: 3, medium: 0, low: 0, total: 3 },
      actual: { high: 1, medium: 2, low: 0, total: 3 },
      flags: [
        { kind: "narrator_high_exceeds_blackboard_high", severity: "warning", numbers: { narrator: 3, blackboard: 1 }, message: "…" },
      ],
      shouldRevise: true,
    });
    const out = clampConfidenceToBlackboard(mags, imps, r);
    assert.equal(out.downgradedHigh, 2);
    assert.equal(out.magnitudes![0]!.confidence, "high"); // first kept
    assert.equal(out.magnitudes![1]!.confidence, "medium");
    assert.equal(out.implications![0]!.confidence, "medium");
  });

  it("block rule forces one low when blackboard carries a low finding", () => {
    const mags: Mag[] = [
      { label: "A", value: "1", confidence: "high" },
      { label: "B", value: "2", confidence: "high" },
    ];
    const r = report({
      claimed: { high: 2, medium: 0, low: 0, total: 2 },
      actual: { high: 0, medium: 0, low: 1, total: 1 },
      flags: [
        { kind: "narrator_all_high_with_low_in_blackboard", severity: "block", numbers: { narrator: 2, blackboard: 1 }, message: "…" },
      ],
      shouldRevise: true,
    });
    const out = clampConfidenceToBlackboard(mags, undefined, r);
    assert.equal(out.forcedLow, true);
    assert.ok(out.magnitudes!.some((m) => m.confidence === "low"));
  });

  it("no-op when shouldRevise is false (identity preserved)", () => {
    const mags: Mag[] = [{ label: "A", value: "1", confidence: "high" }];
    const out = clampConfidenceToBlackboard(mags, undefined, report({ shouldRevise: false }));
    assert.equal(out.changed, false);
    assert.strictEqual(out.magnitudes, mags); // same reference
  });
});
