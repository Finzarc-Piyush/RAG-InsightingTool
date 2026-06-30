import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatCompactNumber } from "../lib/formatCompactNumber.js";

describe("formatCompactNumber (Indian: Cr / Lac / K)", () => {
  it("abbreviates thousands with a spaced K suffix", () => {
    assert.equal(formatCompactNumber(15240), "15.2 K");
    assert.equal(formatCompactNumber(1500), "1.5 K");
    assert.equal(formatCompactNumber(1000), "1 K");
    assert.equal(formatCompactNumber(50_000), "50 K");
  });

  it("abbreviates lakhs (≥ 1e5) with a Lac suffix", () => {
    assert.equal(formatCompactNumber(108547), "1.09 Lac");
    assert.equal(formatCompactNumber(710212), "7.1 Lac");
    assert.equal(formatCompactNumber(389151), "3.89 Lac");
    assert.equal(formatCompactNumber(1_500_000), "15 Lac");
    assert.equal(formatCompactNumber(2_750_000), "27.5 Lac");
    assert.equal(formatCompactNumber(481_000), "4.81 Lac");
  });

  it("abbreviates crores (≥ 1e7) with a Cr suffix", () => {
    assert.equal(formatCompactNumber(15_000_000), "1.5 Cr");
    assert.equal(formatCompactNumber(108_547_000), "10.9 Cr");
    assert.equal(formatCompactNumber(2_400_000_000), "240 Cr");
    assert.equal(formatCompactNumber(15_000_000_000), "1500 Cr");
    // The screenshot case: 1,049,389,992.94 → "104.9 Cr", 311,587,406.72 → "31.2 Cr".
    assert.equal(formatCompactNumber(1_049_389_992.94), "104.9 Cr");
    assert.equal(formatCompactNumber(311_587_406.72), "31.2 Cr");
  });

  it("preserves sub-1000 values with bucketed decimals", () => {
    assert.equal(formatCompactNumber(999), "999");
    assert.equal(formatCompactNumber(123.456), "123");
    assert.equal(formatCompactNumber(42.567), "42.6");
    assert.equal(formatCompactNumber(3.14159), "3.14");
    // W-DEC1 · sub-1 values now cap at 2 decimals (was 3): 0.083 → 0.08.
    assert.equal(formatCompactNumber(0.083), "0.08");
    assert.equal(formatCompactNumber(0.126), "0.13");
    assert.equal(formatCompactNumber(0.5), "0.5");
  });

  it("strips trailing zeros", () => {
    assert.equal(formatCompactNumber(1000), "1 K");
    assert.equal(formatCompactNumber(1100), "1.1 K");
    assert.equal(formatCompactNumber(10_000), "10 K");
    assert.equal(formatCompactNumber(2.0), "2");
  });

  it("handles negatives by mirroring the magnitude rules", () => {
    assert.equal(formatCompactNumber(-15240), "-15.2 K");
    assert.equal(formatCompactNumber(-1_500_000), "-15 Lac");
    assert.equal(formatCompactNumber(-311_587_406.72), "-31.2 Cr");
    assert.equal(formatCompactNumber(-42.5), "-42.5");
  });

  it("handles zero and edge boundaries", () => {
    assert.equal(formatCompactNumber(0), "0");
    assert.equal(formatCompactNumber(999.999), "1000");
    assert.equal(formatCompactNumber(1_000_000), "10 Lac");
  });

  it("passes through non-finite values as-is", () => {
    assert.equal(formatCompactNumber(NaN), "NaN");
    assert.equal(formatCompactNumber(Infinity), "Infinity");
    assert.equal(formatCompactNumber(-Infinity), "-Infinity");
  });
});
