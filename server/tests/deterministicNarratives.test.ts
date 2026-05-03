import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildPatternDrivenFallback,
  selectFallbackFamily,
} from "../lib/insightGenerator/deterministicNarratives.js";
import type { PivotPatterns } from "../lib/insightGenerator/pivotPatterns.js";

const formatY = (n: number): string => {
  if (!isFinite(n)) return String(n);
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
};

const basePatterns: PivotPatterns = {
  rowCount: 5,
  total: 1000,
  isCategoricalX: true,
  isTemporal: false,
  dualAxis: false,
  topPerformers: [
    { x: "West", y: 600, share: 0.6 },
    { x: "East", y: 200, share: 0.2 },
    { x: "North", y: 100, share: 0.1 },
  ],
  bottomPerformers: [
    { x: "Central", y: 40, share: 0.04 },
    { x: "South", y: 60, share: 0.06 },
    { x: "North", y: 100, share: 0.1 },
  ],
  segmentsAboveP75: ["West"],
  segmentsBelowP25: ["Central"],
};

describe("selectFallbackFamily", () => {
  it("picks 'concentration' when HHI is high", () => {
    const p: PivotPatterns = {
      ...basePatterns,
      hhi: 0.42,
      top1Share: 0.6,
      cv: 0.2,
    };
    assert.equal(selectFallbackFamily(p), "concentration");
  });

  it("picks 'dispersion' when CV > 0.30 and concentration is low", () => {
    const p: PivotPatterns = {
      ...basePatterns,
      hhi: 0.12,
      top1Share: 0.25,
      cv: 0.45,
    };
    assert.equal(selectFallbackFamily(p), "dispersion");
  });

  it("picks 'trend' when temporal with significant recent-vs-prior delta", () => {
    const p: PivotPatterns = {
      ...basePatterns,
      isTemporal: true,
      trendDirection: "up",
      recentVsPriorDelta: 0.18,
      cv: 0.1,
      hhi: 0.1,
    };
    assert.equal(selectFallbackFamily(p), "trend");
  });

  it("picks 'relationship' when dual-axis and correlation is strong", () => {
    const p: PivotPatterns = {
      ...basePatterns,
      dualAxis: true,
      yY2Strength: "strong",
      yY2Correlation: 0.91,
      cv: 0.1,
      hhi: 0.1,
    };
    assert.equal(selectFallbackFamily(p), "relationship");
  });

  it("picks 'diagnostic' when no signal is dominant", () => {
    const p: PivotPatterns = {
      ...basePatterns,
      hhi: 0.15,
      top1Share: 0.25,
      cv: 0.12,
    };
    assert.equal(selectFallbackFamily(p), "diagnostic");
  });
});

describe("buildPatternDrivenFallback — narratives", () => {
  it("concentration narrative names the leader, share, and risk + a quantified next-check", () => {
    const p: PivotPatterns = {
      ...basePatterns,
      hhi: 0.42,
      top1Share: 0.6,
      top3Share: 0.9,
      leaderVsMedianMultiple: 6,
      cv: 0.2,
      longTailCount: 2,
      longTailShare: 0.1,
    };
    const out = buildPatternDrivenFallback({
      patterns: p,
      chartSpec: { x: "Region", y: "Sales" },
      dimensionLabel: "Region",
      formatY,
    });
    assert.equal(out.family, "concentration");
    assert.match(out.text, /West/);
    assert.match(out.text, /60%/);
    assert.match(out.text, /Next:/);
    // Anti-pattern: must not produce the shallow "lift the laggards" template.
    assert.doesNotMatch(out.text, /target moving weaker segments/i);
    assert.doesNotMatch(out.text, /increase Sales where/i);
  });

  it("trend narrative includes direction, peak, trough, and a quantified next-check", () => {
    const p: PivotPatterns = {
      ...basePatterns,
      isTemporal: true,
      trendDirection: "up",
      recentVsPriorDelta: 0.18,
      peakLabel: "2024-06",
      troughLabel: "2024-01",
      hhi: 0.1,
      top1Share: 0.25,
      cv: 0.1,
    };
    const out = buildPatternDrivenFallback({
      patterns: p,
      chartSpec: { x: "Month", y: "Revenue" },
      dimensionLabel: "Month",
      formatY,
    });
    assert.equal(out.family, "trend");
    assert.match(out.text, /rising/);
    assert.match(out.text, /\+18\.0%/);
    assert.match(out.text, /2024-06/);
    assert.match(out.text, /2024-01/);
    assert.match(out.text, /Next:/);
  });

  it("dispersion narrative names above-P75 / below-P25 segments and avoids generic 'lift bottom' phrasing", () => {
    const p: PivotPatterns = {
      ...basePatterns,
      hhi: 0.15,
      top1Share: 0.25,
      cv: 0.45,
      topToBottomRatio: 8.5,
      segmentsAboveP75: ["West", "East"],
      segmentsBelowP25: ["Central", "South"],
    };
    const out = buildPatternDrivenFallback({
      patterns: p,
      chartSpec: { x: "Region", y: "Sales" },
      dimensionLabel: "Region",
      formatY,
    });
    assert.equal(out.family, "dispersion");
    assert.match(out.text, /West/);
    assert.match(out.text, /Central/);
    assert.match(out.text, /Next:/);
    assert.doesNotMatch(out.text, /lift the bottom|prioritize the leader/i);
  });

  it("diagnostic narrative proposes a deeper cut instead of a recommendation", () => {
    const p: PivotPatterns = {
      ...basePatterns,
      hhi: 0.12,
      top1Share: 0.22,
      cv: 0.1,
      median: 180,
    };
    const out = buildPatternDrivenFallback({
      patterns: p,
      chartSpec: { x: "Region", y: "Sales" },
      dimensionLabel: "Region",
      formatY,
    });
    assert.equal(out.family, "diagnostic");
    assert.match(out.text, /Next:/);
    assert.match(out.text, /re-pivot|second dimension/);
    // Diagnostic should NOT push a generic action.
    assert.doesNotMatch(out.text, /increase Sales|prioritize/i);
  });

  it("relationship narrative names the link and warns against confusing it with causation (G3-P2: plain English)", () => {
    const p: PivotPatterns = {
      ...basePatterns,
      dualAxis: true,
      yY2Correlation: 0.91,
      yY2Strength: "strong",
      hhi: 0.1,
      top1Share: 0.25,
      cv: 0.1,
    };
    const out = buildPatternDrivenFallback({
      patterns: p,
      chartSpec: { x: "Period", y: "Sales", y2: "Spend" } as any,
      dimensionLabel: "Period",
      formatY,
    });
    assert.equal(out.family, "relationship");
    // G3-P2 — plain English replaces "Pearson r 0.91": narrative now says
    // "strong link" and "moves in the same direction". Explicit Pearson-r
    // numerical citation is gone from the user-visible text.
    assert.match(out.text, /strong/);
    assert.match(out.text, /same direction/i);
    // Anti-causation framing in plainer English.
    assert.match(out.text, /not mean one causes the other|does not mean/i);
    assert.match(out.text, /Next:/);
    // G3-P2 — assert the banned jargon is not present.
    assert.doesNotMatch(out.text, /\bPearson\b/i);
    assert.doesNotMatch(out.text, /\bHHI\b/);
    assert.doesNotMatch(out.text, /\bCV\b/);
    assert.doesNotMatch(out.text, /\bIQR\b/);
    assert.doesNotMatch(out.text, /\bP25\b|\bP75\b/);
  });
});
