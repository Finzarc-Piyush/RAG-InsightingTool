import test from "node:test";
import assert from "node:assert/strict";
import {
  recommendPivotChart,
  recommendPivotChartForType,
} from "./chartRecommendation.ts";
import type { PivotUiConfig } from "./types.ts";

function configWith(rows: string[], values: string[], columns: string[] = []): PivotUiConfig {
  return {
    filters: [],
    columns,
    rows,
    values: values.map((field) => ({
      id: `meas_${field}`,
      field,
      agg: "sum" as const,
    })),
    unused: [],
  };
}

test("recommendPivotChart picks pivot fields when no actualResultColumns provided", () => {
  const out = recommendPivotChart({
    pivotConfig: configWith(["Ship Mode"], ["Shipping Time (Days)"]),
    numericColumns: ["Shipping Time (Days)"],
    dateColumns: [],
  });
  assert.equal(out.x, "Ship Mode");
  assert.equal(out.y, "Shipping Time (Days)");
});

test("recommendPivotChart preserves pivot fields when actualResultColumns matches", () => {
  const out = recommendPivotChart({
    pivotConfig: configWith(["Ship Mode"], ["Shipping Time (Days)"]),
    numericColumns: ["Shipping Time (Days)"],
    dateColumns: [],
    actualResultColumns: ["Ship Mode", "Shipping Time (Days)"],
  });
  assert.equal(out.x, "Ship Mode");
  assert.equal(out.y, "Shipping Time (Days)");
});

test("recommendPivotChart maps base column to aliased result column when present", () => {
  // The trace plan uses base column "Shipping Time (Days)" but the agent's
  // result column is the aggregation alias "Average Shipping Time". The
  // recommender should pick whatever numeric column exists on the rendered
  // rows so the chart isn't bound to a non-existent field.
  const out = recommendPivotChart({
    pivotConfig: configWith(["Ship Mode"], ["Shipping Time (Days)"]),
    numericColumns: ["Shipping Time (Days)"],
    dateColumns: [],
    actualResultColumns: ["Ship Mode", "Average Shipping Time"],
  });
  assert.equal(out.x, "Ship Mode");
  assert.equal(out.y, "Average Shipping Time");
});

test("recommendPivotChart handles agg-suffix mapping (Sales_sum ↔ Sales)", () => {
  const out = recommendPivotChart({
    pivotConfig: configWith(["Region"], ["Sales"]),
    numericColumns: ["Sales"],
    dateColumns: [],
    actualResultColumns: ["Region", "Sales_sum"],
  });
  assert.equal(out.x, "Region");
  assert.equal(out.y, "Sales_sum");
});

test("recommendPivotChart binds y to the non-row column even without numeric metadata", () => {
  // Realistic agent output: 1 row dim + 1 measure column whose alias the schema
  // doesn't recognise as numeric. Picking the non-row column beats silently
  // binding to a base table column that doesn't exist in the rendered rows.
  const out = recommendPivotChart({
    pivotConfig: configWith(["Ship Mode"], ["Shipping Time (Days)"]),
    numericColumns: ["Shipping Time (Days)", "Sales", "Postal Code"],
    dateColumns: ["Ship Date", "Order Date"],
    actualResultColumns: ["Ship Mode", "Average Shipping Time"],
  });
  assert.equal(out.x, "Ship Mode");
  assert.equal(out.y, "Average Shipping Time");
});

test("recommendPivotChart falls back to a plausible result-row dim when the configured row is absent (PV7)", () => {
  // PV7 · Pre-PV7 the recommender returned x:null when the configured row
  // dim wasn't in actualResultColumns, which left the chart unrendered.
  // Now we fall back to the first non-numeric, non-aggregation column on
  // the result so the chart binds to something the data actually has.
  const out = recommendPivotChart({
    pivotConfig: configWith(["Ship Date"], ["Sales"]),
    numericColumns: ["Sales"],
    dateColumns: ["Ship Date"],
    actualResultColumns: ["Ship Mode", "Sales"],
  });
  assert.equal(out.x, "Ship Mode");
  assert.equal(out.y, "Sales");
});

// ===========================================================================
// PV1 · data-shape-aware mark selection
// ===========================================================================

test("PV1 · auto-picks line for temporal X with single row (loosened from >=2)", () => {
  const out = recommendPivotChart({
    pivotConfig: configWith(["Order Date"], ["Sales"]),
    numericColumns: ["Sales"],
    dateColumns: ["Order Date"],
    rowCount: 1,
  });
  assert.equal(out.chartType, "line");
});

test("PV1 · auto-picks radar for ≥3 numeric measures over a single entity dim", () => {
  const out = recommendPivotChart({
    pivotConfig: configWith(["Brand"], ["Volume", "Value", "Share", "Distribution"]),
    numericColumns: ["Volume", "Value", "Share", "Distribution"],
    dateColumns: [],
    rowCount: 5,
  });
  assert.equal(out.chartType, "radar");
  assert.equal(out.x, "Brand");
});

test("PV1 · auto-picks bubble for 3 numeric measures with no row dim", () => {
  const out = recommendPivotChart({
    pivotConfig: configWith([], ["Volume", "Value", "Distribution"]),
    numericColumns: ["Volume", "Value", "Distribution"],
    dateColumns: [],
  });
  assert.equal(out.chartType, "bubble");
  assert.equal(out.x, "Volume");
  assert.equal(out.y, "Value");
  assert.equal(out.z, "Distribution");
});

test("PV1 · auto-picks scatter for two numeric measures with no row dim", () => {
  const out = recommendPivotChart({
    pivotConfig: configWith([], ["Spend", "Sales"]),
    numericColumns: ["Spend", "Sales"],
    dateColumns: [],
  });
  assert.equal(out.chartType, "scatter");
  assert.equal(out.x, "Spend");
  assert.equal(out.y, "Sales");
});

test("PV1 · auto-picks waterfall for delta-suffix measure", () => {
  const out = recommendPivotChart({
    pivotConfig: configWith(["Component"], ["Sales_delta"]),
    numericColumns: ["Sales_delta"],
    dateColumns: [],
    rowCount: 6,
  });
  assert.equal(out.chartType, "waterfall");
});

test("PV1 · auto-picks waterfall for driver-prefixed row dim", () => {
  const out = recommendPivotChart({
    pivotConfig: configWith(["Driver"], ["Contribution"]),
    numericColumns: ["Contribution"],
    dateColumns: [],
    rowCount: 5,
  });
  assert.equal(out.chartType, "waterfall");
});

test("PV1 · pie below threshold, donut at/above threshold", () => {
  const pieOut = recommendPivotChart({
    pivotConfig: configWith(["Segment"], ["Sales"]),
    numericColumns: ["Sales"],
    dateColumns: [],
    rowCount: 3,
  });
  assert.equal(pieOut.chartType, "pie");

  const donutOut = recommendPivotChart({
    pivotConfig: configWith(["Segment"], ["Sales"]),
    numericColumns: ["Sales"],
    dateColumns: [],
    rowCount: 5,
  });
  assert.equal(donutOut.chartType, "donut");
});

test("PV1 · radar requires ≤8 spokes; high cardinality falls through", () => {
  const out = recommendPivotChart({
    pivotConfig: configWith(["Brand"], ["Volume", "Value", "Share", "Distribution"]),
    numericColumns: ["Volume", "Value", "Share", "Distribution"],
    dateColumns: [],
    rowCount: 30,
  });
  // 30 spokes is too many — should not pick radar.
  assert.notEqual(out.chartType, "radar");
});

test("PV1 · forced 'donut' returns donut shape", () => {
  const out = recommendPivotChartForType(
    {
      pivotConfig: configWith(["Segment"], ["Sales"]),
      numericColumns: ["Sales"],
      dateColumns: [],
      rowCount: 4,
    },
    "donut"
  );
  assert.equal(out.chartType, "donut");
  assert.equal(out.x, "Segment");
  assert.equal(out.y, "Sales");
});

test("PV1 · forced 'bubble' uses three numeric value fields", () => {
  const out = recommendPivotChartForType(
    {
      pivotConfig: configWith([], ["Volume", "Value", "Distribution"]),
      numericColumns: ["Volume", "Value", "Distribution"],
      dateColumns: [],
    },
    "bubble"
  );
  assert.equal(out.chartType, "bubble");
  assert.equal(out.z, "Distribution");
});

test("PV1 · forced 'radar' falls back with reason when measures < 3", () => {
  const out = recommendPivotChartForType(
    {
      pivotConfig: configWith(["Brand"], ["Sales"]),
      numericColumns: ["Sales"],
      dateColumns: [],
      rowCount: 4,
    },
    "radar"
  );
  assert.equal(out.chartType, "radar");
  assert.match(out.reason, /3 numeric measures/);
});

test("PV1 · forced 'waterfall' returns waterfall with row + numeric", () => {
  const out = recommendPivotChartForType(
    {
      pivotConfig: configWith(["Driver"], ["Contribution"]),
      numericColumns: ["Contribution"],
      dateColumns: [],
      rowCount: 5,
    },
    "waterfall"
  );
  assert.equal(out.chartType, "waterfall");
});

// ===========================================================================
// PV7 · bulletproof temporal detection
// ===========================================================================

test("PV7 · picks line for ISO-date sample values when column name + dateColumns miss", () => {
  // Column "Bucket" doesn't match the temporal regex and isn't in dateColumns,
  // but values are ISO dates → must still detect as temporal.
  const out = recommendPivotChart({
    pivotConfig: configWith(["Bucket"], ["Sales"]),
    numericColumns: ["Sales"],
    dateColumns: [],
    rowCount: 12,
    sampleValuesByField: {
      Bucket: [
        "2023-01-15",
        "2023-02-15",
        "2023-03-15",
        "2023-04-15",
      ],
    },
  });
  assert.equal(out.chartType, "line");
});

test("PV7 · detects Marico-VN period strings (Q1 23, FY24-25, Latest 12 Mths)", () => {
  const out = recommendPivotChart({
    pivotConfig: configWith(["Reporting"], ["Volume"]),
    numericColumns: ["Volume"],
    dateColumns: [],
    rowCount: 6,
    sampleValuesByField: {
      Reporting: ["Q1 23", "Q2 23", "Q3 23", "Q4 23", "FY24-25", "Latest 12 Mths"],
    },
  });
  assert.equal(out.chartType, "line");
});

test("PV7 · detects Vietnamese 'Tháng' / 'Quý' column names via regex", () => {
  const out = recommendPivotChart({
    pivotConfig: configWith(["Tháng"], ["Doanh thu"]),
    numericColumns: ["Doanh thu"],
    dateColumns: [],
    rowCount: 12,
  });
  assert.equal(out.chartType, "line");
});

test("PV7 · detects 'Mar-24' month-abbrev sample values", () => {
  const out = recommendPivotChart({
    pivotConfig: configWith(["When"], ["Sales"]),
    numericColumns: ["Sales"],
    dateColumns: [],
    rowCount: 12,
    sampleValuesByField: {
      When: ["Jan-24", "Feb-24", "Mar-24", "Apr-24", "May-24"],
    },
  });
  assert.equal(out.chartType, "line");
});

test("PV7 · detects plain 4-digit year sample values", () => {
  const out = recommendPivotChart({
    pivotConfig: configWith(["YearCol"], ["Sales"]),
    numericColumns: ["Sales"],
    dateColumns: [],
    rowCount: 5,
    sampleValuesByField: {
      YearCol: ["2020", "2021", "2022", "2023", "2024"],
    },
  });
  assert.equal(out.chartType, "line");
});

test("PV7 · ignores non-temporal text values (no false positive)", () => {
  // Column name doesn't match, values are plain strings — must NOT pick line.
  const out = recommendPivotChart({
    pivotConfig: configWith(["Region"], ["Sales"]),
    numericColumns: ["Sales"],
    dateColumns: [],
    rowCount: 5,
    sampleValuesByField: {
      Region: ["North", "South", "East", "West", "Central"],
    },
  });
  assert.notEqual(out.chartType, "line");
});

test("PV7 · row-dim fallback picks aliased non-measure column for temporal detection", () => {
  // Pivot config says "Order Date", agent's result aliased it as "Order Period".
  // After PV7 fallback the recommender picks "Order Period" as x; values look
  // temporal so it picks line.
  const out = recommendPivotChart({
    pivotConfig: configWith(["Order Date"], ["Sales"]),
    numericColumns: ["Sales"],
    dateColumns: ["Order Date"],
    actualResultColumns: ["Order Period", "Sales"],
    rowCount: 12,
    sampleValuesByField: {
      "Order Period": ["2024-01", "2024-02", "2024-03", "2024-04"],
    },
  });
  assert.equal(out.x, "Order Period");
  assert.equal(out.chartType, "line");
});
