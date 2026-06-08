/**
 * Wave WW2 · narrator-side wiring of WQ1 — pure helper tests.
 *
 * Covers:
 *  - `extractFindingEvidence` — regex extraction of n / p / R² / CI.
 *  - `tierBlackboardFindings` — full-pipeline decoration of blackboard findings.
 *  - `buildNarratorConfidenceBlock` — prompt-block shape, empty-blackboard
 *    short-circuit, hedge phrase appears for low/medium only.
 *  - `summarizeNarratorConfidence` — tier counts for telemetry.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  buildNarratorConfidenceBlock,
  extractFindingEvidence,
  summarizeNarratorConfidence,
  tierBlackboardFindings,
} from "../lib/agents/runtime/narratorHintsBlock.js";
import {
  addFinding,
  createBlackboard,
} from "../lib/agents/runtime/analyticalBlackboard.js";

describe("Wave WW2 · extractFindingEvidence", () => {
  it("extracts n from 'n = N' / 'sample of N' / 'across N rows'", () => {
    assert.equal(extractFindingEvidence("Result based on n = 2500.").n, 2500);
    assert.equal(extractFindingEvidence("Sample of 87 customers.").n, 87);
    assert.equal(extractFindingEvidence("Across 1200 records").n, 1200);
  });

  it("tiers a compute_growth TREND summary on its fit (n + R² parsed; not the no-evidence default)", () => {
    // The exact shape summarizeTrend emits — pins the grader-compatibility contract.
    const trendSummary =
      "compute_growth (trend): Sales rose ~145.0% across 30 periods, from 2026-04-01 (105) " +
      "to 2026-04-30 (250). Peak 2026-04-30 (250), trough 2026-04-01 (105). " +
      "Linear fit slope +5/period, R²=1.00 over n=30 points (rising).";
    const ev = extractFindingEvidence(trendSummary);
    assert.equal(ev.n, 30);
    assert.equal(ev.rSquared, 1);
  });

  it("extracts p-value from 'p = 0.03' / 'p < 0.001' / 'p-value: 0.05'", () => {
    assert.equal(extractFindingEvidence("Significant at p = 0.03.").pValue, 0.03);
    assert.equal(extractFindingEvidence("p < 0.001").pValue, 0.001);
    assert.equal(extractFindingEvidence("p-value: 0.045").pValue, 0.045);
  });

  it("extracts R² from 'R² = 0.71' / 'r-squared: 0.42'", () => {
    assert.equal(extractFindingEvidence("Model fit R² = 0.71.").rSquared, 0.71);
    assert.equal(extractFindingEvidence("r-squared: 0.42").rSquared, 0.42);
    assert.equal(extractFindingEvidence("R^2 = 0.91").rSquared, 0.91);
  });

  it("extracts CI relative width from '±15% of the estimate' / 'CI: ±25%'", () => {
    assert.equal(
      extractFindingEvidence("Coefficient ±15% of the estimate").ciRelativeWidth,
      0.15,
    );
    assert.equal(extractFindingEvidence("CI: ±25%").ciRelativeWidth, 0.25);
  });

  it("returns empty object when nothing matches", () => {
    assert.deepEqual(extractFindingEvidence("Plain narrative with no stats."), {});
    assert.deepEqual(extractFindingEvidence(""), {});
  });

  it("extracts multiple fields from a single detail string", () => {
    const ev = extractFindingEvidence(
      "Driver model fit R² = 0.64 across 850 records (p < 0.01).",
    );
    assert.equal(ev.rSquared, 0.64);
    assert.equal(ev.n, 850);
    assert.equal(ev.pValue, 0.01);
  });

  it("ignores out-of-range p-values defensively", () => {
    // p > 1 is nonsensical — first regex alt requires "0.x" / "0?.x" so 2.0
    // doesn't match either alternative and pValue stays undefined.
    assert.equal(
      extractFindingEvidence("p = 2.0 nonsensical.").pValue,
      undefined,
    );
  });
});

describe("Wave WW2 · tierBlackboardFindings", () => {
  it("tiers each finding via assessConfidence based on extracted evidence", () => {
    const bb = createBlackboard();
    addFinding(bb, {
      sourceRef: "tool-1",
      label: "Solid driver",
      detail: "Strong driver: R² = 0.71, n = 850, p = 0.001.",
      significance: "notable",
    });
    addFinding(bb, {
      sourceRef: "tool-2",
      label: "Tentative pattern",
      detail: "Weak signal: n = 8, p = 0.21.",
      significance: "notable",
    });
    addFinding(bb, {
      sourceRef: "tool-3",
      label: "No stats supplied",
      detail: "Revenue grew. No numbers cited.",
      significance: "routine",
    });

    const tiered = tierBlackboardFindings(bb);
    assert.equal(tiered.length, 3);
    assert.equal(tiered[0].assessment.tier, "high");
    assert.equal(tiered[1].assessment.tier, "low");
    assert.equal(tiered[2].assessment.tier, "medium");
  });
});

describe("Wave WW2 · buildNarratorConfidenceBlock", () => {
  it("emits one block with header + per-finding lines", () => {
    const bb = createBlackboard();
    addFinding(bb, {
      sourceRef: "tool-1",
      label: "High",
      detail: "R² = 0.7, n = 500.",
      significance: "notable",
    });
    addFinding(bb, {
      sourceRef: "tool-2",
      label: "Low",
      detail: "n = 5",
      significance: "notable",
    });
    const block = buildNarratorConfidenceBlock(bb);
    assert.match(block, /FINDING_CONFIDENCE/);
    assert.match(block, /\(high\)/);
    assert.match(block, /\(low\)/);
    assert.match(block, /budget: ≤[0-9] sentences/);
  });

  it("includes the hedge phrase line for medium / low but NOT for high", () => {
    const bb = createBlackboard();
    addFinding(bb, {
      sourceRef: "h",
      label: "High",
      detail: "R² = 0.7, n = 500, p < 0.001.",
      significance: "notable",
    });
    const highOnly = buildNarratorConfidenceBlock(bb);
    assert.doesNotMatch(highOnly, /hedge:/);

    const bb2 = createBlackboard();
    addFinding(bb2, {
      sourceRef: "l",
      label: "Low",
      detail: "n = 5",
      significance: "notable",
    });
    const lowOnly = buildNarratorConfidenceBlock(bb2);
    assert.match(lowOnly, /hedge: "/);
    assert.match(lowOnly, /tentative observation/);
  });

  it("returns empty string when the blackboard has no findings", () => {
    const bb = createBlackboard();
    assert.equal(buildNarratorConfidenceBlock(bb), "");
  });

  it("includes the directive about pinning magnitudes[].confidence to the tier", () => {
    const bb = createBlackboard();
    addFinding(bb, {
      sourceRef: "x",
      label: "x",
      detail: "n = 50",
      significance: "notable",
    });
    const block = buildNarratorConfidenceBlock(bb);
    assert.match(block, /magnitudes\[\]\.confidence/);
    assert.match(block, /implications\[\]\.confidence/);
  });
});

describe("Wave WW2 · summarizeNarratorConfidence", () => {
  it("counts findings by tier", () => {
    const bb = createBlackboard();
    addFinding(bb, {
      sourceRef: "a",
      label: "a",
      detail: "R² = 0.7, n = 500, p < 0.001.",
      significance: "notable",
    });
    addFinding(bb, { sourceRef: "b", label: "b", detail: "n = 5", significance: "notable" });
    addFinding(bb, {
      sourceRef: "c",
      label: "c",
      detail: "No stats here",
      significance: "routine",
    });
    const summary = summarizeNarratorConfidence(bb);
    assert.equal(summary.total, 3);
    assert.equal(summary.high, 1);
    assert.equal(summary.medium, 1);
    assert.equal(summary.low, 1);
  });
});
