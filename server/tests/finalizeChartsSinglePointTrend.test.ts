import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { finalizeMergedCharts } from "../lib/agents/runtime/agentLoop/finalizeCharts.js";
import type { ChartSpec } from "../shared/schema.js";

/**
 * Wave W-1PT1 · `finalizeMergedCharts` is the single seam where every chart
 * source converges before persist. It must drop a line/area/scatter chart whose
 * MATERIALIZED x-axis has < 2 distinct points (a degenerate single-dot
 * trendline — the "2025-04 is the only Month · Time" bug) while leaving healthy
 * trends and non-trend charts untouched.
 */

const singlePointLine: ChartSpec = {
  type: "line",
  title: "NR (Rs Cr) by Month · Time", // the reported bug
  x: "Month · Time",
  y: "NR (Rs Cr)",
  data: [{ "Month · Time": "2025-04", "NR (Rs Cr)": 678 }],
};

const healthyLine: ChartSpec = {
  type: "line",
  title: "NR by Month",
  x: "Month", // distinct axis signature from the single-point line
  y: "NR",
  data: [
    { Month: "2025-03", NR: 600 },
    { Month: "2025-04", NR: 678 },
    { Month: "2025-05", NR: 712 },
  ],
};

const singlePointScatter: ChartSpec = {
  type: "scatter",
  title: "Price vs Units (one dot)",
  x: "price",
  y: "units",
  data: [{ price: 10, units: 4 }],
};

const singleCategoryBar: ChartSpec = {
  type: "bar",
  title: "Sales by Region (one bar)",
  x: "region",
  y: "sales",
  data: [{ region: "East", sales: 5 }], // out of scope — bars are not trend charts
};

const multiPointArea: ChartSpec = {
  type: "area",
  title: "Volume by Week",
  x: "week",
  y: "vol",
  data: [
    { week: "W1", vol: 1 },
    { week: "W2", vol: 2 },
  ],
};

describe("finalizeMergedCharts · single-point trend guard", () => {
  it("drops single-point line/area/scatter, keeps healthy trends + bars, preserves order", () => {
    const charts: ChartSpec[] = [
      singlePointLine,
      healthyLine,
      singlePointScatter,
      singleCategoryBar,
      multiPointArea,
    ];

    finalizeMergedCharts(charts);

    const titles = charts.map((c) => c.title);
    assert.deepEqual(titles, [
      "NR by Month", // healthy line kept
      "Sales by Region (one bar)", // single-category bar kept (not a trend type)
      "Volume by Week", // multi-point area kept
    ]);
  });

  it("is a no-op for an all-healthy chart set", () => {
    const charts: ChartSpec[] = [healthyLine, multiPointArea, singleCategoryBar];
    finalizeMergedCharts(charts);
    assert.equal(charts.length, 3);
  });

  it("never drops an un-materialized line chart (data absent → conservative keep)", () => {
    const noData: ChartSpec = { type: "line", title: "Deferred", x: "month", y: "v" };
    const charts: ChartSpec[] = [noData];
    finalizeMergedCharts(charts);
    assert.deepEqual(charts.map((c) => c.title), ["Deferred"]);
  });

  it("drops an empty (zero-row) trend chart", () => {
    const empty: ChartSpec = { type: "line", title: "Empty", x: "month", y: "v", data: [] };
    const charts: ChartSpec[] = [empty, healthyLine];
    finalizeMergedCharts(charts);
    assert.deepEqual(charts.map((c) => c.title), ["NR by Month"]);
  });

  it("handles an empty input array", () => {
    const charts: ChartSpec[] = [];
    finalizeMergedCharts(charts);
    assert.equal(charts.length, 0);
  });
});
