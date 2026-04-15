import { describe, it, expect } from "vitest";
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
    expect(yDomain[0]).toBe(0);
    expect(yDomain[1]).toBeGreaterThan(35_000);
    expect(yDomain[1]).toBeLessThan(55_000);
  });

  it("stacked-bar uses row sum max", () => {
    const { yDomain } = yDomainForMultiSeriesRows(rows, keys, "stacked-bar");
    const maxRow = 32_000 + 33_000 + 29_000;
    expect(yDomain[0]).toBe(0);
    expect(yDomain[1]).toBeCloseTo(maxRow * 1.05, -2);
  });

  it("multiSeriesYDomainKind", () => {
    expect(multiSeriesYDomainKind("bar", undefined)).toBe("stacked-bar");
    expect(multiSeriesYDomainKind("bar", "stacked")).toBe("stacked-bar");
    expect(multiSeriesYDomainKind("bar", "grouped")).toBe("overlay");
    expect(multiSeriesYDomainKind("line", undefined)).toBe("overlay");
    expect(multiSeriesYDomainKind("area", "stacked")).toBe("overlay");
  });
});
