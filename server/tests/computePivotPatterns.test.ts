import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computePivotPatterns,
  renderPivotPatternsBlock,
} from "../lib/insightGenerator/pivotPatterns.js";

const formatY = (n: number): string => {
  if (!isFinite(n)) return String(n);
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
};

describe("computePivotPatterns — categorical X with skewed data", () => {
  const chartData = [
    { Region: "West", Sales: 600 },
    { Region: "East", Sales: 200 },
    { Region: "North", Sales: 100 },
    { Region: "South", Sales: 60 },
    { Region: "Central", Sales: 40 },
  ];
  const spec = { x: "Region", y: "Sales", type: "bar" as const };

  it("flags high concentration when one segment dominates", () => {
    const p = computePivotPatterns(chartData, spec);
    assert.equal(p.rowCount, 5);
    assert.equal(p.total, 1000);
    assert.equal(p.topPerformers[0]?.x, "West");
    assert.ok(
      p.top1Share !== undefined && p.top1Share >= 0.59 && p.top1Share <= 0.61,
      `top1Share should be ~0.6, got ${p.top1Share}`
    );
    assert.ok(p.hhi !== undefined && p.hhi > 0.25, "HHI > 0.25 = concentrated");
  });

  it("computes top:bottom and leader-vs-median multipliers", () => {
    const p = computePivotPatterns(chartData, spec);
    assert.ok(p.topToBottomRatio !== undefined && p.topToBottomRatio === 15);
    assert.ok(
      p.leaderVsMedianMultiple !== undefined && p.leaderVsMedianMultiple === 6,
      `leader vs median should be 6 (600/100), got ${p.leaderVsMedianMultiple}`
    );
  });

  it("populates segments above P75 and below P25 with names", () => {
    const p = computePivotPatterns(chartData, spec);
    assert.ok(p.segmentsAboveP75.length > 0);
    assert.ok(p.segmentsAboveP75.includes("West"));
    assert.ok(p.segmentsBelowP25.length > 0);
    assert.ok(p.segmentsBelowP25.includes("Central"));
  });

  it("flags high CV variability for the skewed sample", () => {
    const p = computePivotPatterns(chartData, spec);
    assert.equal(p.variability, "high");
  });

  it("renders a non-empty prompt block with concentration, gap, spread, segments (G3-P2: plain English labels)", () => {
    const p = computePivotPatterns(chartData, spec);
    const block = renderPivotPatternsBlock(p, formatY);
    assert.match(block, /PIVOT PATTERNS/);
    assert.match(block, /Concentration/);
    assert.match(block, /Gap/);
    // G3-P2 — "Dispersion" relabelled to "Spread" for non-statistician readers.
    assert.match(block, /Spread/);
    assert.match(block, /Segments/);
    assert.match(block, /West/); // top performer named
    // G3-P2 — banned jargon must not surface in the rendered block.
    assert.doesNotMatch(block, /\bHHI\b/);
    assert.doesNotMatch(block, /\bCV\b/);
    assert.doesNotMatch(block, /\bIQR\b/);
    assert.doesNotMatch(block, /\bP25\b|\bP75\b|\bP90\b|\bP10\b/);
    assert.doesNotMatch(block, /long tail/i);
  });
});

describe("computePivotPatterns — temporal X (line chart)", () => {
  const chartData = [
    { Month: "2024-01-01", Revenue: 100 },
    { Month: "2024-02-01", Revenue: 120 },
    { Month: "2024-03-01", Revenue: 130 },
    { Month: "2024-04-01", Revenue: 140 },
    { Month: "2024-05-01", Revenue: 160 },
    { Month: "2024-06-01", Revenue: 180 },
  ];
  const spec = { x: "Month", y: "Revenue", type: "line" as const };

  it("detects temporal X and an upward trend", () => {
    const p = computePivotPatterns(chartData, spec);
    assert.equal(p.isTemporal, true);
    assert.equal(p.trendDirection, "up");
  });

  it("computes recent-vs-prior delta and labels peak / trough", () => {
    const p = computePivotPatterns(chartData, spec);
    assert.ok(
      p.recentVsPriorDelta !== undefined && p.recentVsPriorDelta > 0,
      "recent vs prior should be positive"
    );
    assert.equal(p.peakLabel, "2024-06-01");
    assert.equal(p.troughLabel, "2024-01-01");
  });

  it("renders a temporal section in the prompt block", () => {
    const p = computePivotPatterns(chartData, spec);
    const block = renderPivotPatternsBlock(p, formatY);
    assert.match(block, /Temporal/);
    assert.match(block, /direction up/);
    assert.match(block, /peak 2024-06-01/);
  });
});

describe("computePivotPatterns — dual axis", () => {
  const chartData = [
    { Period: "2024-01-01", Sales: 100, Spend: 10 },
    { Period: "2024-02-01", Sales: 200, Spend: 20 },
    { Period: "2024-03-01", Sales: 300, Spend: 30 },
    { Period: "2024-04-01", Sales: 400, Spend: 40 },
    { Period: "2024-05-01", Sales: 500, Spend: 50 },
  ];
  const spec = {
    x: "Period",
    y: "Sales",
    y2: "Spend",
    type: "line" as const,
  };

  it("computes Y vs Y2 correlation when dual-axis line", () => {
    const p = computePivotPatterns(chartData, spec);
    assert.equal(p.dualAxis, true);
    assert.ok(
      p.yY2Correlation !== undefined && Math.abs(p.yY2Correlation - 1) < 0.01,
      `r should be ~1, got ${p.yY2Correlation}`
    );
    assert.equal(p.yY2Strength, "strong");
  });
});

describe("computePivotPatterns — sparse data degrades gracefully", () => {
  it("handles single-row data without throwing", () => {
    const p = computePivotPatterns([{ X: "A", Y: 5 }], {
      x: "X",
      y: "Y",
      type: "bar" as const,
    });
    assert.equal(p.rowCount, 1);
    assert.equal(p.total, 5);
    assert.equal(p.topPerformers.length, 1);
    // Trend / temporal should be off — only one point.
    assert.equal(p.trendDirection, undefined);
  });

  it("handles empty data without throwing", () => {
    const p = computePivotPatterns([], {
      x: "X",
      y: "Y",
      type: "bar" as const,
    });
    assert.equal(p.rowCount, 0);
    assert.equal(p.total, 0);
    assert.equal(p.topPerformers.length, 0);
  });

  it("handles all-equal Y values (zero variance)", () => {
    const chartData = [
      { Cat: "A", Val: 100 },
      { Cat: "B", Val: 100 },
      { Cat: "C", Val: 100 },
    ];
    const p = computePivotPatterns(chartData, {
      x: "Cat",
      y: "Val",
      type: "bar" as const,
    });
    assert.equal(p.cv, 0);
    assert.equal(p.variability, "low");
    assert.equal(p.iqr, 0);
  });
});

describe("computePivotPatterns — multi-series ranks series, not X", () => {
  const chartData = [
    { Region: "West", Furniture: 100, Technology: 500 },
    { Region: "East", Furniture: 200, Technology: 300 },
  ];
  const spec = {
    x: "Region",
    y: "Sales",
    type: "bar" as const,
    seriesKeys: ["Furniture", "Technology"],
  };

  it("ranks series labels (Technology > Furniture) instead of X values", () => {
    const p = computePivotPatterns(chartData, spec);
    assert.equal(p.topPerformers[0]?.x, "Technology");
    assert.equal(p.topPerformers[1]?.x, "Furniture");
    assert.equal(p.isCategoricalX, true);
  });
});
