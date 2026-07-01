import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveMetricPolarity } from "../lib/financeMetricAuthority.js";
import {
  resolveTone,
  resolveToneVsTarget,
} from "../lib/scorecard/tone.js";

/**
 * Wave W2 (data-bound cards) · polarity + tone authority. The scorecard's
 * colour must be DIRECTION-AWARE: GC%↑ = good, returns%↑ = bad, and a
 * directionless metric never gets a good/bad colour. This pins that matrix.
 */

describe("W2 · resolveMetricPolarity", () => {
  it("revenue / profit / share / GC% are higher_better", () => {
    for (const n of ["NR", "Net Revenue", "GSV", "Gross Profit", "GC%", "Gross Contribution %", "Market Share", "Value Share", "Growth %"]) {
      assert.equal(resolveMetricPolarity(n), "higher_better", n);
    }
  });

  it("costs / returns / leakage are lower_better", () => {
    for (const n of ["Returns", "COGS", "Cost of Goods Sold", "Trade Spend", "Complaint Count", "Attrition", "Stockout %", "Overheads"]) {
      assert.equal(resolveMetricPolarity(n), "lower_better", n);
    }
  });

  it("directionless / dimension names are neutral", () => {
    for (const n of ["Region", "BrandCode", "Channel", "A&P Spend", "Mix %", "Index", ""]) {
      assert.equal(resolveMetricPolarity(n), "neutral", n);
    }
  });

  it("does NOT mislabel ROI / return-on as lower_better (bare 'return' excluded)", () => {
    // "Return on Investment" contains 'return' but must not be treated as leakage.
    assert.notEqual(resolveMetricPolarity("Return on Investment"), "lower_better");
  });
});

describe("W2 · resolveTone (period-over-period)", () => {
  it("higher_better: up=good, down=bad", () => {
    assert.equal(resolveTone(0.08, "higher_better"), "good");
    assert.equal(resolveTone(-0.08, "higher_better"), "bad");
  });

  it("lower_better: up=bad, down=good", () => {
    assert.equal(resolveTone(0.08, "lower_better"), "bad");
    assert.equal(resolveTone(-0.08, "lower_better"), "good");
  });

  it("neutral polarity never gets good/bad", () => {
    assert.equal(resolveTone(0.5, "neutral"), "neutral");
    assert.equal(resolveTone(-0.5, "neutral"), "neutral");
  });

  it("tiny move inside the neutral band → neutral", () => {
    assert.equal(resolveTone(0.005, "higher_better"), "neutral");
    assert.equal(resolveTone(-0.005, "lower_better"), "neutral");
  });

  it("no comparison (null / NaN) → neutral", () => {
    assert.equal(resolveTone(null, "higher_better"), "neutral");
    assert.equal(resolveTone(undefined, "lower_better"), "neutral");
    assert.equal(resolveTone(NaN, "higher_better"), "neutral");
  });
});

describe("W2 · resolveToneVsTarget", () => {
  it("higher_better: at/above target = good, just below = warn, far below = bad", () => {
    assert.equal(resolveToneVsTarget(105, 100, "higher_better"), "good");
    assert.equal(resolveToneVsTarget(97, 100, "higher_better"), "warn");
    assert.equal(resolveToneVsTarget(80, 100, "higher_better"), "bad");
  });

  it("lower_better: at/below target = good, just above = warn, far above = bad", () => {
    assert.equal(resolveToneVsTarget(95, 100, "lower_better"), "good");
    assert.equal(resolveToneVsTarget(103, 100, "lower_better"), "warn");
    assert.equal(resolveToneVsTarget(130, 100, "lower_better"), "bad");
  });

  it("neutral polarity / bad inputs → neutral", () => {
    assert.equal(resolveToneVsTarget(105, 100, "neutral"), "neutral");
    assert.equal(resolveToneVsTarget(null, 100, "higher_better"), "neutral");
    assert.equal(resolveToneVsTarget(105, 0, "higher_better"), "neutral");
  });
});
