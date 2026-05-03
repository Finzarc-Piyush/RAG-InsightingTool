import { describe, expect, it } from "vitest";
import {
  groupBy,
  aggregate,
  aggregateGroups,
  filterRows,
  sortRows,
  computeBins,
  binNumeric,
  topNAndOther,
  sample,
  applyWindow,
  applyTransform,
  applyTransforms,
} from "./dataEngine";

const ROWS = [
  { region: "N", year: 2023, rev: 100 },
  { region: "N", year: 2024, rev: 150 },
  { region: "S", year: 2023, rev: 80 },
  { region: "S", year: 2024, rev: 120 },
  { region: "E", year: 2023, rev: 60 },
  { region: "E", year: 2024, rev: 90 },
];

describe("dataEngine · groupBy", () => {
  it("groups by single key", () => {
    const m = groupBy(ROWS, ["region"]);
    expect(m.size).toBe(3);
    expect(m.get("N")?.length).toBe(2);
  });

  it("groups by composite key", () => {
    const m = groupBy(ROWS, ["region", "year"]);
    expect(m.size).toBe(6);
  });

  it("returns single bucket when keys empty", () => {
    const m = groupBy(ROWS, []);
    expect(m.size).toBe(1);
    expect(m.get("")?.length).toBe(6);
  });
});

describe("dataEngine · aggregate", () => {
  it("sum / mean / count / distinct", () => {
    expect(aggregate([1, 2, 3, 4], "sum")).toBe(10);
    expect(aggregate([1, 2, 3, 4], "mean")).toBe(2.5);
    expect(aggregate([1, 2, 3, 4], "count")).toBe(4);
    expect(aggregate([1, 2, 2, 3], "distinct")).toBe(3);
  });

  it("min / max", () => {
    expect(aggregate([5, 1, 3], "min")).toBe(1);
    expect(aggregate([5, 1, 3], "max")).toBe(5);
  });

  it("median / p25 / p50 / p75 / p95", () => {
    expect(aggregate([1, 2, 3, 4, 5], "median")).toBe(3);
    expect(aggregate([1, 2, 3, 4, 5], "p50")).toBe(3);
    expect(aggregate([1, 2, 3, 4, 5], "p25")).toBe(2);
    expect(aggregate([1, 2, 3, 4, 5], "p75")).toBe(4);
    expect(aggregate([1, 2, 3, 4, 5], "p95")).toBeCloseTo(4.8, 1);
  });

  it("stdev / variance", () => {
    expect(aggregate([2, 4, 4, 4, 5, 5, 7, 9], "stdev")).toBeCloseTo(2.138, 2);
    expect(aggregate([2, 4, 4, 4, 5, 5, 7, 9], "variance")).toBeCloseTo(4.571, 2);
  });

  it("returns NaN for empty finite input", () => {
    expect(Number.isNaN(aggregate([], "sum"))).toBe(true);
  });
});

describe("dataEngine · aggregateGroups", () => {
  it("sums revenue by region", () => {
    const out = aggregateGroups(ROWS, {
      groupby: ["region"],
      ops: [{ op: "sum", field: "rev", as: "rev_total" }],
    });
    expect(out.length).toBe(3);
    expect(out.find((r) => r.region === "N")?.rev_total).toBe(250);
    expect(out.find((r) => r.region === "S")?.rev_total).toBe(200);
  });

  it("supports multiple ops", () => {
    const out = aggregateGroups(ROWS, {
      groupby: ["region"],
      ops: [
        { op: "sum", field: "rev", as: "total" },
        { op: "count", field: "rev", as: "n" },
      ],
    });
    expect(out.find((r) => r.region === "N")?.total).toBe(250);
    expect(out.find((r) => r.region === "N")?.n).toBe(2);
  });
});

describe("dataEngine · filter / sort", () => {
  it("filterRows with predicate", () => {
    const out = filterRows(ROWS, (r) => (r.rev as number) > 100);
    expect(out.length).toBe(2);
  });

  it("sortRows asc / desc on number", () => {
    const asc = sortRows(ROWS, "rev", "asc");
    expect(asc[0]?.rev).toBe(60);
    const desc = sortRows(ROWS, "rev", "desc");
    expect(desc[0]?.rev).toBe(150);
  });

  it("sortRows on string", () => {
    const asc = sortRows(ROWS, "region", "asc");
    expect(asc[0]?.region).toBe("E");
  });
});

describe("dataEngine · bin", () => {
  it("computeBins produces N+1 boundaries", () => {
    const { boundaries } = computeBins([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5);
    expect(boundaries.length).toBe(6);
    expect(boundaries[0]).toBe(1);
    expect(boundaries[boundaries.length - 1]).toBe(10);
  });

  it("binNumeric attaches a label per row", () => {
    const out = binNumeric(
      [{ v: 1 }, { v: 5 }, { v: 9 }],
      "v",
      "vBin",
      3,
    );
    expect(out.length).toBe(3);
    expect(out[0]?.vBin).toBeDefined();
  });
});

describe("dataEngine · topNAndOther", () => {
  it("collapses long tail into 'Others' bucket", () => {
    const data = [
      { cat: "A", rev: 100 },
      { cat: "B", rev: 90 },
      { cat: "C", rev: 80 },
      { cat: "D", rev: 5 },
      { cat: "E", rev: 4 },
    ];
    const out = topNAndOther(data, "cat", "rev", 3);
    const cats = new Set(out.map((r) => r.cat));
    expect(cats.has("A")).toBe(true);
    expect(cats.has("B")).toBe(true);
    expect(cats.has("C")).toBe(true);
    expect(cats.has("Others")).toBe(true);
    expect(cats.size).toBe(4);
  });

  it("returns input unchanged when below threshold", () => {
    const data = [{ cat: "A", rev: 1 }, { cat: "B", rev: 2 }];
    expect(topNAndOther(data, "cat", "rev", 5)).toEqual(data);
  });
});

describe("dataEngine · sample", () => {
  it("returns input unchanged below threshold", () => {
    const data = [{ a: 1 }, { a: 2 }];
    expect(sample(data, 100).length).toBe(2);
  });

  it("downsamples evenly above threshold", () => {
    const data = Array.from({ length: 1000 }, (_, i) => ({ i }));
    const out = sample(data, 100);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.length).toBeGreaterThan(80);
  });
});

describe("dataEngine · applyWindow", () => {
  const series = [
    { t: 1, v: 10 },
    { t: 2, v: 20 },
    { t: 3, v: 30 },
    { t: 4, v: 40 },
  ];

  it("cumsum", () => {
    const out = applyWindow(series, { op: "cumsum", field: "v", as: "c" });
    expect(out.map((r) => r.c)).toEqual([10, 30, 60, 100]);
  });

  it("cummean", () => {
    const out = applyWindow(series, { op: "cummean", field: "v", as: "c" });
    expect(out.map((r) => r.c)).toEqual([10, 15, 20, 25]);
  });

  it("cummax / cummin", () => {
    expect(
      applyWindow(
        [{ v: 3 }, { v: 1 }, { v: 5 }, { v: 2 }],
        { op: "cummax", field: "v", as: "m" },
      ).map((r) => r.m),
    ).toEqual([3, 3, 5, 5]);
    expect(
      applyWindow(
        [{ v: 3 }, { v: 1 }, { v: 5 }, { v: 2 }],
        { op: "cummin", field: "v", as: "m" },
      ).map((r) => r.m),
    ).toEqual([3, 1, 1, 1]);
  });

  it("moving_avg window 2", () => {
    const out = applyWindow(series, {
      op: "moving_avg",
      field: "v",
      as: "ma",
      window: 2,
    });
    expect(out[0]?.ma).toBe(10);
    expect(out[1]?.ma).toBe(15);
    expect(out[2]?.ma).toBe(25);
  });

  it("row_number", () => {
    const out = applyWindow(series, { op: "row_number", as: "rn" });
    expect(out.map((r) => r.rn)).toEqual([1, 2, 3, 4]);
  });
});

describe("dataEngine · applyTransform / applyTransforms", () => {
  it("aggregate transform", () => {
    const out = applyTransform(ROWS, {
      type: "aggregate",
      groupby: ["region"],
      ops: [{ op: "sum", field: "rev", as: "rev_total" }],
    });
    expect(out.length).toBe(3);
  });

  it("bin transform", () => {
    const out = applyTransform([{ v: 1 }, { v: 5 }, { v: 10 }], {
      type: "bin",
      field: "v",
      as: "vBin",
      maxbins: 3,
    });
    expect(out.length).toBe(3);
    expect(out[0]?.vBin).toBeDefined();
  });

  it("fold transform", () => {
    const out = applyTransform(
      [{ id: 1, jan: 10, feb: 20 }],
      { type: "fold", fields: ["jan", "feb"], as: ["month", "value"] },
    );
    expect(out.length).toBe(2);
    expect(out[0]?.month).toBe("jan");
    expect(out[0]?.value).toBe(10);
  });

  it("applyTransforms chains transforms in order", () => {
    const out = applyTransforms(ROWS, [
      {
        type: "aggregate",
        groupby: ["year"],
        ops: [{ op: "sum", field: "rev", as: "total" }],
      },
    ]);
    expect(out.length).toBe(2);
    expect(out.every((r) => "total" in r)).toBe(true);
  });

  it("undefined transforms = identity", () => {
    expect(applyTransforms(ROWS, undefined)).toBe(ROWS);
    expect(applyTransforms(ROWS, [])).toBe(ROWS);
  });
});
