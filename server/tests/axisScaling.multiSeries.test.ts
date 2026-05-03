import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  multiSeriesYDomainKind,
  yDomainForMultiSeriesRows,
} from "../lib/axisScaling.js";

describe("yDomainForMultiSeriesRows", () => {
  const rows = [
    { month: "Jan", A: 30_000, B: 35_000, C: 28_000 },
    { month: "Feb", A: 32_000, B: 33_000, C: 29_000 },
  ];
  const keys = ["A", "B", "C"];

  it("overlay uses max single series, not row sum", () => {
    const { yDomain } = yDomainForMultiSeriesRows(rows, keys, "overlay");
    assert.equal(yDomain[0], 0);
    assert.ok(yDomain[1] > 35_000, `expected yDomain[1] > 35000, got ${yDomain[1]}`);
    assert.ok(yDomain[1] < 55_000, `expected yDomain[1] < 55000, got ${yDomain[1]}`);
  });

  it("stacked-bar uses row sum max", () => {
    const { yDomain } = yDomainForMultiSeriesRows(rows, keys, "stacked-bar");
    const maxRow = 32_000 + 33_000 + 29_000;
    assert.equal(yDomain[0], 0);
    // ±50 tolerance (vitest's toBeCloseTo(_, -2) → within ~50 of target)
    assert.ok(
      Math.abs(yDomain[1] - maxRow * 1.05) <= 50,
      `expected ~${maxRow * 1.05}, got ${yDomain[1]}`,
    );
  });

  it("multiSeriesYDomainKind", () => {
    assert.equal(multiSeriesYDomainKind("bar", undefined), "stacked-bar");
    assert.equal(multiSeriesYDomainKind("bar", "stacked"), "stacked-bar");
    assert.equal(multiSeriesYDomainKind("bar", "grouped"), "overlay");
    assert.equal(multiSeriesYDomainKind("line", undefined), "overlay");
    assert.equal(multiSeriesYDomainKind("area", "stacked"), "overlay");
  });
});
