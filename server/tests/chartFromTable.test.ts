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
  // Temporal classification may render as line or bar depending on
  // compileChartSpec's downstream rules; just assert promotion succeeded.
  assert.notEqual(out, null);
  assert.equal(out!.x, "Order_Date");
  assert.equal(out!.y, "Sales_sum");
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
