import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  detectUnsupportedCausalClaims,
  sanitizeLikelyDrivers,
} from "../lib/agents/runtime/verifierCausalCheck.js";

/**
 * W-SR2 · the deterministic rail behind the hedged "why" lane. It ships before
 * the contract opens the speculation permission, so a gate always exists. These
 * tests pin the four predicates: hedge-presence, no-stat-number-in-mechanism,
 * data-basis column grounding, and the measured-layer info scan — plus that an
 * ordinal / category label is NOT treated as a fabricated statistic.
 */
const COLS = ["Survived", "Pclass", "Sex", "Age", "Fare", "Embarked"];

function driver(over: Record<string, unknown>) {
  return {
    explanation: "likely lifeboat access",
    basis: "general" as const,
    confidence: "low" as const,
    ...over,
  };
}

describe("W-SR2 · verifierCausalCheck", () => {
  it("passes a hedged, grounded, number-free driver", () => {
    const r = detectUnsupportedCausalClaims(
      {
        likelyDrivers: [
          driver({
            explanation: "more women survived, consistent with the Sex split in the data",
            basis: "data",
            confidence: "high",
          }),
        ],
      },
      COLS
    );
    assert.equal(r.shouldRevise, false);
    assert.equal(r.flags.length, 0);
  });

  it("flags an unhedged (asserted) mechanism", () => {
    const r = detectUnsupportedCausalClaims(
      { likelyDrivers: [driver({ explanation: "first-class cabins were nearer the lifeboats" })] },
      COLS
    );
    assert.equal(r.unhedgedDrivers.length, 1);
    assert.equal(r.shouldRevise, true);
  });

  it("flags a statistic-shaped number inside a mechanism", () => {
    const r = detectUnsupportedCausalClaims(
      { likelyDrivers: [driver({ explanation: "likely because fares were 3x higher" })] },
      COLS
    );
    assert.equal(r.numberInMechanism.length, 1);
    assert.equal(r.shouldRevise, true);
  });

  it("does NOT treat an ordinal / category label as a number", () => {
    const r = detectUnsupportedCausalClaims(
      {
        likelyDrivers: [
          driver({ explanation: "likely 1st-class cabins in Pclass 1 sat nearer the boats" }),
        ],
      },
      COLS
    );
    assert.equal(r.numberInMechanism.length, 0);
    assert.equal(r.shouldRevise, false);
  });

  it("flags a basis='data' driver that names no real column", () => {
    const r = detectUnsupportedCausalClaims(
      {
        likelyDrivers: [
          driver({
            explanation: "likely the LifeboatDeck position drove survival",
            basis: "data",
            confidence: "high",
          }),
        ],
      },
      COLS
    );
    assert.equal(r.ungroundedDataDrivers.length, 1);
    assert.equal(r.shouldRevise, true);
  });

  it("accepts a basis='data' driver that names a real column", () => {
    const r = detectUnsupportedCausalClaims(
      {
        likelyDrivers: [
          driver({
            explanation: "likely the Fare gap reflects cabin access",
            basis: "data",
            confidence: "high",
          }),
        ],
      },
      COLS
    );
    assert.equal(r.ungroundedDataDrivers.length, 0);
  });

  it("reports a measured-layer causal claim as info (does not force revise)", () => {
    const r = detectUnsupportedCausalClaims(
      {
        findings: [
          { headline: "Survival fell", evidence: "Survival fell because of class.", magnitude: "−38pp" },
        ],
      },
      COLS
    );
    assert.equal(r.unhedgedInMeasured.length, 1);
    assert.equal(r.shouldRevise, false, "measured-layer info must not force a revise");
  });
});

describe("W-CP1 · sanitizeLikelyDrivers (belt-and-suspenders at emit)", () => {
  it("keeps a hedged, grounded, number-free driver intact", () => {
    const kept = sanitizeLikelyDrivers(
      [
        {
          explanation: "more women survived, consistent with the Sex split",
          basis: "data",
          confidence: "high",
        },
      ],
      COLS
    );
    assert.equal(kept.length, 1);
    assert.equal(kept[0].basis, "data");
  });

  it("drops unhedged and number-bearing drivers", () => {
    const kept = sanitizeLikelyDrivers(
      [
        { explanation: "cabins were nearer the boats", basis: "general", confidence: "low" },
        { explanation: "likely fares were 3x higher", basis: "general", confidence: "low" },
      ],
      COLS
    );
    assert.equal(kept.length, 0);
  });

  it("demotes a falsely data-grounded driver to a low-confidence general one", () => {
    const kept = sanitizeLikelyDrivers(
      [
        {
          explanation: "likely the LifeboatDeck position mattered",
          basis: "data",
          confidence: "high",
        },
      ],
      COLS
    );
    assert.equal(kept.length, 1);
    assert.equal(kept[0].basis, "general");
    assert.equal(kept[0].confidence, "low");
  });
});
