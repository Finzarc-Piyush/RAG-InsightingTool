import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  calculateEtaSquared,
  calculateCategoricalCorrelations,
  calculateCorrelations,
} from "../lib/correlationMath.js";

function makePerfectCategorical(n = 300): Record<string, any>[] {
  // Category perfectly determines Sales: A→100, B→200, C→300
  return Array.from({ length: n }, (_, i) => {
    const cat = ["A", "B", "C"][i % 3];
    return { Category: cat, Sales: cat === "A" ? 100 : cat === "B" ? 200 : 300 };
  });
}

function makeNoisyCategorical(n = 600): Record<string, any>[] {
  let seed = 42;
  const lcg = () => {
    seed = (seed * 1664525 + 1013904223) & 0xffffffff;
    return ((seed >>> 0) / 0xffffffff) * 99 + 1;
  };
  return Array.from({ length: n }, (_, i) => ({
    Category: ["X", "Y", "Z"][i % 3],
    Sales: lcg(),
  }));
}

describe("calculateEtaSquared", () => {
  it("returns η≈1 when category perfectly predicts Sales", () => {
    const data = makePerfectCategorical();
    const result = calculateEtaSquared(data, "Sales", "Category");
    assert.ok(result !== null, "should return a result");
    assert.ok(result.correlation > 0.98, `expected η≈1, got ${result.correlation}`);
    assert.equal(result.variable, "Category");
    assert.ok((result.nPairs ?? 0) > 0);
  });

  it("returns η≈0 when category has no relationship to Sales", () => {
    const data = makeNoisyCategorical();
    const result = calculateEtaSquared(data, "Sales", "Category");
    assert.ok(result !== null, "should return a result");
    assert.ok(result.correlation < 0.15, `expected η near 0, got ${result.correlation}`);
  });

  it("returns null for fewer than 2 groups", () => {
    const data = Array.from({ length: 20 }, () => ({ Category: "OnlyOne", Sales: 100 }));
    assert.equal(calculateEtaSquared(data, "Sales", "Category"), null);
  });

  it("returns null for fewer than 5 valid rows", () => {
    const data = [
      { Category: "A", Sales: 1 },
      { Category: "B", Sales: 2 },
    ];
    assert.equal(calculateEtaSquared(data, "Sales", "Category"), null);
  });

  it("returns null when Sales has zero variance", () => {
    const data = Array.from({ length: 30 }, (_, i) => ({
      Category: ["A", "B"][i % 2],
      Sales: 42,
    }));
    assert.equal(calculateEtaSquared(data, "Sales", "Category"), null);
  });

  it("skips rows where Sales is null/undefined", () => {
    const base = makePerfectCategorical(30);
    const data = [
      ...base,
      { Category: "A", Sales: null },
      { Category: "B", Sales: undefined },
    ];
    const result = calculateEtaSquared(data, "Sales", "Category");
    assert.ok(result !== null);
    assert.ok(result.correlation > 0.95);
  });

  it("η is always in [0, 1] range", () => {
    const datasets = [makePerfectCategorical(), makeNoisyCategorical()];
    for (const data of datasets) {
      const result = calculateEtaSquared(data, "Sales", "Category");
      if (result !== null) {
        assert.ok(result.correlation >= 0 && result.correlation <= 1,
          `η out of range: ${result.correlation}`);
      }
    }
  });
});

describe("calculateCategoricalCorrelations", () => {
  it("returns results for all valid categorical columns", () => {
    const data = makePerfectCategorical(300).map((row, i) => ({
      ...row,
      Region: ["East", "West"][i % 2],
    }));
    const results = calculateCategoricalCorrelations(data, "Sales", ["Category", "Region"]);
    assert.equal(results.length, 2);
    const catResult = results.find(r => r.variable === "Category");
    assert.ok(catResult, "Category result missing");
    assert.ok(catResult!.correlation > 0.98);
  });

  it("returns empty array when no columns produce valid results", () => {
    const data = Array.from({ length: 3 }, () => ({ Category: "A", Sales: 1 }));
    assert.equal(calculateCategoricalCorrelations(data, "Sales", ["Category"]).length, 0);
  });

  it("excludes columns whose η is null (single group or insufficient rows)", () => {
    const data = [
      ...Array.from({ length: 10 }, () => ({ Cat: "OnlyOne", Sales: 100 })),
      ...makePerfectCategorical(30).map(r => ({ ...r, Cat: r.Category })),
    ];
    // Cat has only one unique value across the first slice — should get filtered
    const results = calculateCategoricalCorrelations(data.slice(0, 10), "Sales", ["Cat"]);
    assert.equal(results.length, 0);
  });
});

describe("calculateCorrelations (Pearson — existing behaviour unchanged)", () => {
  it("returns empty when only the target column is in numericColumns", () => {
    const data = makePerfectCategorical();
    const result = calculateCorrelations(data, "Sales", ["Sales"]);
    assert.equal(result.length, 0, "should return empty — nothing to correlate against");
  });

  it("returns Pearson r for two numeric columns", () => {
    const data = Array.from({ length: 100 }, (_, i) => ({
      Sales: i + 1,
      Quantity: i * 2 + 1,
    }));
    const result = calculateCorrelations(data, "Sales", ["Sales", "Quantity"]);
    assert.equal(result.length, 1);
    assert.equal(result[0].variable, "Quantity");
    assert.ok(Math.abs(result[0].correlation - 1.0) < 0.001, `expected r≈1, got ${result[0].correlation}`);
  });
});
