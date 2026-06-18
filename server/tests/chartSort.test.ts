import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyChartSort,
  compareCategory,
  detectAxisOrdered,
  resolveSort,
  rowValue,
  selectTopNByValue,
  type ChartSortSpec,
} from "../shared/chartSort.js";

const order = (rows: Array<Record<string, unknown>>, key: string) =>
  rows.map((r) => r[key]);

describe("chartSort · compareCategory", () => {
  it("orders pure numbers numerically, not lexically (2 < 10)", () => {
    const out = ["10", "2", "1", "21"].sort(compareCategory);
    assert.deepEqual(out, ["1", "2", "10", "21"]);
  });

  it("orders numbers >12 and 99/100/40 numerically (regression: Date.parse swallow)", () => {
    // "1".."12" parse as months and "13".."31" as NaN under Date.parse, while
    // "40"/"99"/"100" parse as YEARS — so a temporal-first comparator misorders
    // exactly this set. The numeric branch must win.
    assert.deepEqual(["1", "100", "2"].sort(compareCategory), ["1", "2", "100"]);
    assert.deepEqual(["30", "1", "100"].sort(compareCategory), ["1", "30", "100"]);
    assert.deepEqual(["99", "5", "1", "40"].sort(compareCategory), ["1", "5", "40", "99"]);
  });

  it("orders the full age 0→100 axis ascending", () => {
    const ages = ["0", "5", "10", "20", "25", "30", "40", "60", "99", "100"];
    assert.deepEqual([...ages].reverse().sort(compareCategory), ages);
  });

  it("orders negatives and decimals numerically", () => {
    assert.deepEqual(["-5", "3", "-10", "0"].sort(compareCategory), ["-10", "-5", "0", "3"]);
    assert.deepEqual(["1.5", "1.25", "10"].sort(compareCategory), ["1.25", "1.5", "10"]);
  });

  it("orders numeric buckets by lower bound; open bands go to the extremes", () => {
    const out = ["100+", "10-20", "0-10", "20-30"].sort(compareCategory);
    assert.deepEqual(out, ["0-10", "10-20", "20-30", "100+"]);
    // "<10" is the unbounded-low band → first, "100+" unbounded-high → last.
    assert.deepEqual(
      ["20-30", "<10", "0-10", "100+"].sort(compareCategory),
      ["<10", "0-10", "20-30", "100+"],
    );
  });

  it("orders bare years chronologically (= numerically) and period keys correctly", () => {
    assert.deepEqual(["2023", "2021", "2022"].sort(compareCategory), ["2021", "2022", "2023"]);
    assert.deepEqual(
      ["2023-Q4", "2022-Q3", "2023-Q1"].sort(compareCategory),
      ["2022-Q3", "2023-Q1", "2023-Q4"],
    );
  });

  it("orders temporal keys chronologically", () => {
    const out = ["2023-Q4", "2023-Q1", "2022-Q3"].sort(compareCategory);
    assert.deepEqual(out, ["2022-Q3", "2023-Q1", "2023-Q4"]);
  });

  it("sorts nullish/blank values LAST regardless of content", () => {
    const out = ["b", null, "a", ""].sort(compareCategory as (a: unknown, b: unknown) => number);
    // non-null values come first (sorted); the two nullish values trail (order
    // among themselves is a stable tie, so we only assert they are last).
    assert.deepEqual(out.slice(0, 2), ["a", "b"]);
    assert.deepEqual(new Set(out.slice(2)), new Set([null, ""]));
  });
});

describe("chartSort · detectAxisOrdered", () => {
  it("true for numeric ages", () => {
    assert.equal(detectAxisOrdered(["5", "10", "25", "40"]), true);
  });
  it("true for date keys", () => {
    assert.equal(detectAxisOrdered(["2023-01", "2023-02", "2023-03"]), true);
  });
  it("true for numeric buckets", () => {
    assert.equal(detectAxisOrdered(["0-10", "10-20", "20-30"]), true);
  });
  it("false for nominal categories", () => {
    assert.equal(detectAxisOrdered(["Parachute", "Nihar", "Saffola"]), false);
  });
  it("false for a single distinct value", () => {
    assert.equal(detectAxisOrdered(["7", "7", "7"]), false);
  });
});

describe("chartSort · resolveSort precedence", () => {
  const ages = ["5", "10", "25"];
  it("explicit sort wins over everything", () => {
    const s: ChartSortSpec = { by: "value", direction: "asc" };
    assert.deepEqual(resolveSort({ sort: s }, { xValues: ages }), s);
  });
  it("legacy sortDirection maps to value+direction", () => {
    assert.deepEqual(resolveSort({ sortDirection: "asc" }, { xValues: ages }), {
      by: "value",
      direction: "asc",
    });
  });
  it("temporal x defaults to chronological", () => {
    assert.deepEqual(resolveSort({}, { isTemporalX: true }), {
      by: "category",
      direction: "asc",
    });
  });
  it("inherently-ordered x auto-defaults to category ascending", () => {
    assert.deepEqual(resolveSort({}, { xValues: ages }), {
      by: "category",
      direction: "asc",
    });
  });
  it("nominal x keeps the historic value-desc default", () => {
    assert.deepEqual(resolveSort({}, { xValues: ["A", "B", "C"] }), {
      by: "value",
      direction: "desc",
    });
  });
});

describe("chartSort · rowValue", () => {
  it("single-series reads the y column", () => {
    assert.equal(rowValue({ age: "10", survived: 3 }, "survived"), 3);
  });
  it("multi-series sums across seriesKeys (not just the first)", () => {
    assert.equal(rowValue({ x: "A", S1: 2, S2: 5, S3: 1 }, "y", ["S1", "S2", "S3"]), 8);
  });
});

describe("chartSort · applyChartSort", () => {
  const rows = [
    { age: "25", survived: 30 },
    { age: "5", survived: 50 },
    { age: "10", survived: 10 },
  ];

  it("category ascending → age 5,10,25 (the titanic-by-age case)", () => {
    const out = applyChartSort(rows, { by: "category", direction: "asc" }, {
      xCol: "age",
      yCol: "survived",
    });
    assert.deepEqual(order(out, "age"), ["5", "10", "25"]);
  });

  it("category descending → 25,10,5", () => {
    const out = applyChartSort(rows, { by: "category", direction: "desc" }, {
      xCol: "age",
      yCol: "survived",
    });
    assert.deepEqual(order(out, "age"), ["25", "10", "5"]);
  });

  it("value descending → 50,30,10 (historic default)", () => {
    const out = applyChartSort(rows, { by: "value", direction: "desc" }, {
      xCol: "age",
      yCol: "survived",
    });
    assert.deepEqual(order(out, "survived"), [50, 30, 10]);
  });

  it("does not mutate the input array", () => {
    const before = order(rows, "age");
    applyChartSort(rows, { by: "value", direction: "asc" }, { xCol: "age", yCol: "survived" });
    assert.deepEqual(order(rows, "age"), before);
  });

  it("multi-series value sort uses the ROW TOTAL across seriesKeys", () => {
    const wide = [
      { x: "A", S1: 1, S2: 1 }, // total 2
      { x: "B", S1: 9, S2: 0 }, // total 9
      { x: "C", S1: 3, S2: 2 }, // total 5
    ];
    const out = applyChartSort(wide, { by: "value", direction: "desc" }, {
      xCol: "x",
      yCol: "S1",
      seriesKeys: ["S1", "S2"],
    });
    assert.deepEqual(order(out, "x"), ["B", "C", "A"]);
  });

  it("maxRows selects top-N BY VALUE first, then orders by category", () => {
    const many = [
      { age: "1", survived: 5 },
      { age: "2", survived: 100 },
      { age: "3", survived: 1 },
      { age: "4", survived: 80 },
      { age: "5", survived: 90 },
    ];
    // top-3 by value = ages 2(100),5(90),4(80); displayed ascending by age.
    const out = applyChartSort(many, { by: "category", direction: "asc" }, {
      xCol: "age",
      yCol: "survived",
      maxRows: 3,
    });
    assert.deepEqual(order(out, "age"), ["2", "4", "5"]);
  });

  it("nulls in the category axis sort last in both directions", () => {
    const withNull = [
      { age: "10", survived: 1 },
      { age: null, survived: 1 },
      { age: "5", survived: 1 },
    ];
    const asc = applyChartSort(withNull, { by: "category", direction: "asc" }, {
      xCol: "age",
      yCol: "survived",
    });
    assert.deepEqual(order(asc, "age"), ["5", "10", null]);
    const desc = applyChartSort(withNull, { by: "category", direction: "desc" }, {
      xCol: "age",
      yCol: "survived",
    });
    assert.deepEqual(order(desc, "age"), ["10", "5", null]);
  });
});

describe("chartSort · selectTopNByValue", () => {
  it("keeps the N highest-value rows", () => {
    const rows = [
      { x: "a", y: 1 },
      { x: "b", y: 9 },
      { x: "c", y: 5 },
    ];
    const out = selectTopNByValue(rows, 2, { yCol: "y" });
    assert.deepEqual(new Set(order(out, "x")), new Set(["b", "c"]));
  });
});
