import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildChartFromAnalyticalTable,
  chartAxisSignature,
} from "../lib/agents/runtime/chartFromTable.js";
import type { DataSummary } from "../shared/schema.js";

function makeSummary(overrides: Partial<DataSummary> = {}): DataSummary {
  const base: DataSummary = {
    rowCount: 100,
    columns: [],
    columnCount: 0,
    numericColumns: [],
    dateColumns: [],
    categoricalColumns: [],
    sampleRows: [],
  };
  return { ...base, ...overrides } as DataSummary;
}

test("chartFromTable: categorical X + numeric Y → bar chart", () => {
  const out = buildChartFromAnalyticalTable({
    table: {
      rows: [
        { Category: "Technology", Sales_sum: 827_455 },
        { Category: "Furniture", Sales_sum: 728_658 },
        { Category: "Office Supplies", Sales_sum: 705_415 },
      ],
      columns: ["Category", "Sales_sum"],
    },
    summary: makeSummary({ numericColumns: ["Sales_sum"] }),
    question: "which category did great",
  });
  assert.notEqual(out, null);
  assert.equal(out!.type, "bar");
  assert.equal(out!.x, "Category");
  assert.equal(out!.y, "Sales_sum");
});

test("chartFromTable: temporal X (date column) → line chart", () => {
  const out = buildChartFromAnalyticalTable({
    table: {
      rows: [
        { Order_Date: "2015-01-01", Sales_sum: 480_000 },
        { Order_Date: "2016-01-01", Sales_sum: 460_000 },
        { Order_Date: "2017-01-01", Sales_sum: 600_000 },
        { Order_Date: "2018-01-01", Sales_sum: 720_000 },
      ],
      columns: ["Order_Date", "Sales_sum"],
    },
    summary: makeSummary({
      numericColumns: ["Sales_sum"],
      dateColumns: ["Order_Date"],
    }),
    question: "yearly sales trend",
  });
  // A raw date column on the x-axis is a time progression → must be a line.
  assert.notEqual(out, null);
  assert.equal(out!.type, "line");
  assert.equal(out!.x, "Order_Date");
  assert.equal(out!.y, "Sales_sum");
});

test("chartFromTable: temporal facet X ('Day · Date') → line chart", () => {
  // Facet columns are NOT in dateColumns (they live in summary.columns as
  // type "string") — the chart-type authority must still resolve them to line.
  const out = buildChartFromAnalyticalTable({
    table: {
      rows: [
        { "Day · Date": "2026-04-01", "Compliance Visit_sum": 120 },
        { "Day · Date": "2026-04-02", "Compliance Visit_sum": 140 },
        { "Day · Date": "2026-04-03", "Compliance Visit_sum": 110 },
      ],
      columns: ["Day · Date", "Compliance Visit_sum"],
    },
    summary: makeSummary({
      numericColumns: ["Compliance Visit_sum"],
      dateColumns: ["Date"],
    }),
    question: "daily compliance trend",
  });
  assert.notEqual(out, null);
  assert.equal(out!.type, "line");
  assert.equal(out!.x, "Day · Date");
});

test("chartFromTable: returns null when no dimension column", () => {
  const out = buildChartFromAnalyticalTable({
    table: {
      rows: [{ x_sum: 100, y_sum: 200 }],
      columns: ["x_sum", "y_sum"],
    },
    summary: makeSummary({ numericColumns: ["x_sum", "y_sum"] }),
    question: "?",
  });
  assert.equal(out, null);
});

test("chartFromTable: returns null when no numeric column", () => {
  const out = buildChartFromAnalyticalTable({
    table: {
      rows: [
        { Category: "A", Region: "East" },
        { Category: "B", Region: "West" },
      ],
      columns: ["Category", "Region"],
    },
    summary: makeSummary(),
    question: "?",
  });
  assert.equal(out, null);
});

test("chartFromTable: returns null when X cardinality > 60", () => {
  const rows = Array.from({ length: 70 }, (_, i) => ({
    label: `item_${i}`,
    val: i,
  }));
  const out = buildChartFromAnalyticalTable({
    table: { rows, columns: ["label", "val"] },
    summary: makeSummary({ numericColumns: ["val"] }),
    question: "?",
  });
  assert.equal(out, null);
});

test("chartFromTable: returns null when row count > 200", () => {
  const rows = Array.from({ length: 250 }, (_, i) => ({
    Cat: `c_${i % 5}`,
    val: i,
  }));
  const out = buildChartFromAnalyticalTable({
    table: { rows, columns: ["Cat", "val"] },
    summary: makeSummary({ numericColumns: ["val"] }),
    question: "?",
  });
  assert.equal(out, null);
});

test("chartFromTable: returns null on empty table", () => {
  assert.equal(
    buildChartFromAnalyticalTable({
      table: { rows: [], columns: ["A", "B"] },
      summary: makeSummary(),
      question: "?",
    }),
    null
  );
});

test("chartFromTable: prefers _sum > _avg > _count when scoring measures", () => {
  const out = buildChartFromAnalyticalTable({
    table: {
      rows: [
        { Category: "A", Sales_count: 5, Sales_avg: 100, Sales_sum: 500 },
        { Category: "B", Sales_count: 3, Sales_avg: 80, Sales_sum: 240 },
      ],
      columns: ["Category", "Sales_count", "Sales_avg", "Sales_sum"],
    },
    summary: makeSummary({
      numericColumns: ["Sales_count", "Sales_avg", "Sales_sum"],
    }),
    question: "?",
  });
  assert.notEqual(out, null);
  assert.equal(out!.y, "Sales_sum");
});

test("chartFromTable: boolean-indicator rate breakdown charts the rate, not matching/total", () => {
  // The planner's BIR1 rate breakdown returns [dim, matching, total, <x>_rate].
  // Before the scoreMeasure fix, the y-axis picked a count (matching/total) over
  // the rate — so the tile plotted visit counts, not the adherence rate.
  const out = buildChartFromAnalyticalTable({
    table: {
      rows: [
        { "Cluster Name": "North", matching: 70, total: 90, "PJP Adherence_rate": 0.78 },
        { "Cluster Name": "South", matching: 40, total: 100, "PJP Adherence_rate": 0.4 },
        { "Cluster Name": "West", matching: 55, total: 70, "PJP Adherence_rate": 0.79 },
      ],
      columns: ["Cluster Name", "matching", "total", "PJP Adherence_rate"],
    },
    summary: makeSummary({
      numericColumns: ["matching", "total", "PJP Adherence_rate"],
    }),
    question: "pjp adherence by cluster",
  });
  assert.notEqual(out, null);
  assert.equal(out!.x, "Cluster Name");
  assert.equal(out!.y, "PJP Adherence_rate");
});

test("chartFromTable: repair-style __matching/__total helpers never win the y-axis", () => {
  const out = buildChartFromAnalyticalTable({
    table: {
      rows: [
        { Region: "East", adherence__matching: 70, adherence__total: 90, adherence_rate: 0.78 },
        { Region: "West", adherence__matching: 40, adherence__total: 100, adherence_rate: 0.4 },
        { Region: "South", adherence__matching: 55, adherence__total: 70, adherence_rate: 0.79 },
      ],
      columns: ["Region", "adherence__matching", "adherence__total", "adherence_rate"],
    },
    summary: makeSummary({
      numericColumns: ["adherence__matching", "adherence__total", "adherence_rate"],
    }),
    question: "?",
  });
  assert.notEqual(out, null);
  assert.equal(out!.y, "adherence_rate");
});

test("chartAxisSignature: same axes => same signature regardless of title", () => {
  const a = chartAxisSignature({ type: "bar", x: "Category", y: "Sales" });
  const b = chartAxisSignature({ type: "bar", x: "Category", y: "Sales" });
  assert.equal(a, b);
});

test("chartAxisSignature: different seriesColumn distinguishes", () => {
  const a = chartAxisSignature({ type: "bar", x: "Category", y: "Sales" });
  const b = chartAxisSignature({
    type: "bar",
    x: "Category",
    y: "Sales",
    seriesColumn: "Region",
  });
  assert.notEqual(a, b);
});
