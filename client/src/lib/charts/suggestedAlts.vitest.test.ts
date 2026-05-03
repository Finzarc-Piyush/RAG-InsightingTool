import { describe, expect, it } from "vitest";
import { suggestAlternatives, computeShapeStats } from "./suggestedAlts";
import type { ChartEncoding, ChartV2Mark } from "@/shared/schema";

function buildPieRows(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    cat: `c${i}`,
    val: 100 - i,
  }));
}

const PIE_ENC: ChartEncoding = {
  x: { field: "cat", type: "n" },
  y: { field: "val", type: "q" },
};

describe("suggestAlternatives", () => {
  it("returns nothing for a 6-slice pie (within healthy range)", () => {
    const out = suggestAlternatives({
      mark: "arc",
      encoding: PIE_ENC,
      data: buildPieRows(6),
    });
    expect(out).toEqual([]);
  });

  it("recommends bar + treemap for pie with > 12 slices", () => {
    const out = suggestAlternatives({
      mark: "arc",
      encoding: PIE_ENC,
      data: buildPieRows(20),
    });
    expect(out.find((s) => s.mark === "bar")).toBeTruthy();
    expect(out.find((s) => s.mark === "treemap")).toBeTruthy();
  });

  it("recommends waterfall when pie has negative values", () => {
    const data = [
      { cat: "A", val: 10 },
      { cat: "B", val: -5 },
      { cat: "C", val: 8 },
    ];
    const out = suggestAlternatives({
      mark: "arc",
      encoding: PIE_ENC,
      data,
    });
    expect(out.find((s) => s.mark === "waterfall")).toBeTruthy();
  });

  it("recommends bar for line over categorical x", () => {
    const data = [
      { cat: "A", val: 1 },
      { cat: "B", val: 2 },
      { cat: "C", val: 3 },
    ];
    const out = suggestAlternatives({
      mark: "line",
      encoding: { x: { field: "cat", type: "n" }, y: { field: "val", type: "q" } },
      data,
    });
    expect(out[0]?.mark).toBe("bar");
  });

  it("does NOT recommend bar for line over temporal x", () => {
    const data = [
      { day: "2024-01", val: 1 },
      { day: "2024-02", val: 2 },
      { day: "2024-03", val: 3 },
    ];
    const out = suggestAlternatives({
      mark: "line",
      encoding: { x: { field: "day", type: "t" }, y: { field: "val", type: "q" } },
      data,
    });
    expect(out.find((s) => s.mark === "bar")).toBeFalsy();
  });

  it("recommends bar when scatter y is non-quantitative", () => {
    const out = suggestAlternatives({
      mark: "point",
      encoding: {
        x: { field: "x", type: "q" },
        y: { field: "cat", type: "n" },
      },
      data: [{ x: 1, cat: "A" }],
    });
    expect(out[0]?.mark).toBe("bar");
  });

  it("recommends bar for line with ≤2 distinct x values", () => {
    const out = suggestAlternatives({
      mark: "line",
      encoding: {
        x: { field: "day", type: "t" },
        y: { field: "v", type: "q" },
      },
      data: [
        { day: "2024-01", v: 1 },
        { day: "2024-02", v: 2 },
      ],
    });
    expect(out[0]?.mark).toBe("bar");
  });

  it("never includes the current mark in suggestions", () => {
    const out = suggestAlternatives({
      mark: "arc",
      encoding: PIE_ENC,
      data: buildPieRows(20),
    });
    expect(out.find((s) => s.mark === "arc")).toBeFalsy();
  });

  it("caps suggestions at 3", () => {
    const out = suggestAlternatives({
      mark: "arc",
      encoding: PIE_ENC,
      data: [
        ...buildPieRows(20),
        { cat: "neg", val: -10 }, // also triggers waterfall
      ],
    });
    expect(out.length).toBeLessThanOrEqual(3);
  });
});

describe("computeShapeStats", () => {
  it("counts cardinality and detects negatives", () => {
    const data = [
      { cat: "A", val: 10 },
      { cat: "B", val: -5 },
      { cat: "A", val: 8 }, // duplicate cat
    ];
    const enc: ChartEncoding = {
      x: { field: "cat", type: "n" },
      y: { field: "val", type: "q" },
    };
    const stats = computeShapeStats({
      mark: "bar" as ChartV2Mark,
      encoding: enc,
      data,
    });
    expect(stats.rowCount).toBe(3);
    expect(stats.xCardinality).toBe(2);
    expect(stats.yHasNegatives).toBe(true);
    expect(stats.xIsCategorical).toBe(true);
    expect(stats.xIsTemporal).toBe(false);
  });
});
