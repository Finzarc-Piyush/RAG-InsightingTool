import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatCompactNumber } from "../lib/formatCompactNumber.js";

describe("formatCompactNumber", () => {
  it("abbreviates thousands with K suffix", () => {
    assert.equal(formatCompactNumber(108547), "109K");
    assert.equal(formatCompactNumber(15240), "15.2K");
    assert.equal(formatCompactNumber(1500), "1.5K");
    assert.equal(formatCompactNumber(1000), "1K");
    assert.equal(formatCompactNumber(710212), "710K");
    assert.equal(formatCompactNumber(389151), "389K");
  });

  it("abbreviates millions with M suffix", () => {
    assert.equal(formatCompactNumber(1_500_000), "1.5M");
    assert.equal(formatCompactNumber(2_750_000), "2.75M");
    assert.equal(formatCompactNumber(15_000_000), "15M");
    assert.equal(formatCompactNumber(108_547_000), "109M");
  });

  it("abbreviates billions with B suffix", () => {
    assert.equal(formatCompactNumber(2_400_000_000), "2.4B");
    assert.equal(formatCompactNumber(15_000_000_000), "15B");
  });

  it("preserves sub-1000 values with bucketed decimals", () => {
    assert.equal(formatCompactNumber(999), "999");
    assert.equal(formatCompactNumber(123.456), "123");
    assert.equal(formatCompactNumber(42.567), "42.6");
    assert.equal(formatCompactNumber(3.14159), "3.14");
    assert.equal(formatCompactNumber(0.083), "0.083");
    assert.equal(formatCompactNumber(0.5), "0.5");
  });

  it("strips trailing zeros", () => {
    assert.equal(formatCompactNumber(1000), "1K");
    assert.equal(formatCompactNumber(1100), "1.1K");
    assert.equal(formatCompactNumber(10_000), "10K");
    assert.equal(formatCompactNumber(2.0), "2");
  });

  it("handles negatives by mirroring the magnitude rules", () => {
    assert.equal(formatCompactNumber(-15240), "-15.2K");
    assert.equal(formatCompactNumber(-1_500_000), "-1.5M");
    assert.equal(formatCompactNumber(-42.5), "-42.5");
  });

  it("handles zero and edge boundaries", () => {
    assert.equal(formatCompactNumber(0), "0");
    assert.equal(formatCompactNumber(999.999), "1000");
    assert.equal(formatCompactNumber(1_000_000), "1M");
  });

  it("passes through non-finite values as-is", () => {
    assert.equal(formatCompactNumber(NaN), "NaN");
    assert.equal(formatCompactNumber(Infinity), "Infinity");
    assert.equal(formatCompactNumber(-Infinity), "-Infinity");
  });
});
