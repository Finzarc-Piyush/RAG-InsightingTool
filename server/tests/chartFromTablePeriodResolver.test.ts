/**
 * Wave W-GMK2 · tests that `buildChartFromAnalyticalTable` consults
 * `resolvePeriodAxis` to pick a coherent time x-axis (not the dumb
 * first-non-numeric-column rule), applies its injected PeriodKind filter,
 * skips cardinality-1 dimensions, and surfaces the resolver's reason as
 * `axisReason` on the chart spec.
 *
 * Repro scenario (Marico FMCG wide-format): when a result table carries
 * `Period` (mixed kinds), `PeriodKind` (discriminator) and `Products`
 * (single value MARICO), the pre-wave code picked `Period` and produced
 * a chart that mixed Q1_25 + Latest_12_Mths + YTD on one axis with no
 * chronological ordering. Post-wave, the resolver pins to the dominant
 * kind and the filter is applied before chart compile.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChartFromAnalyticalTable } from "../lib/agents/runtime/chartFromTable.js";
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

test("chartFromTable W-GMK2: Marico nine-column table → picks Month · Period by default", () => {
  const rows = [
    {
      "Month · Period": "2025-03",
      "Quarter · Period": "2025-Q1",
      "Year · Period": "2025",
      Period: "Q1 25",
      PeriodKind: "Quarter",
      Products: "MARICO",
      Value_sum: 100,
    },
    {
      "Month · Period": "2025-04",
      "Quarter · Period": "2025-Q2",
      "Year · Period": "2025",
      Period: "Q2 25",
      PeriodKind: "Quarter",
      Products: "MARICO",
      Value_sum: 120,
    },
    {
      "Month · Period": "2024-12",
      "Quarter · Period": "2024-Q4",
      "Year · Period": "2024",
      Period: "Q4 24",
      PeriodKind: "Quarter",
      Products: "MARICO",
      Value_sum: 90,
    },
  ];
  const out = buildChartFromAnalyticalTable({
    table: {
      rows,
      columns: [
        "Month · Period",
        "Quarter · Period",
        "Year · Period",
        "Period",
        "PeriodKind",
        "Products",
        "Value_sum",
      ],
    },
    summary: makeSummary({ numericColumns: ["Value_sum"] }),
    question: "sales by product",
  });
  assert.notEqual(out, null);
  assert.equal(out!.x, "Month · Period");
  assert.equal(out!.y, "Value_sum");
  assert.match(out!.axisReason ?? "", /Month · Period/);
});

test("chartFromTable W-GMK2: 'quarterly' question pins x-axis to Quarter · Period", () => {
  const rows = [
    {
      "Month · Period": "2025-03",
      "Quarter · Period": "2025-Q1",
      Period: "Q1 25",
      Value_sum: 100,
    },
    {
      "Month · Period": "2025-06",
      "Quarter · Period": "2025-Q2",
      Period: "Q2 25",
      Value_sum: 200,
    },
  ];
  const out = buildChartFromAnalyticalTable({
    table: {
      rows,
      columns: ["Month · Period", "Quarter · Period", "Period", "Value_sum"],
    },
    summary: makeSummary({ numericColumns: ["Value_sum"] }),
    question: "show me quarterly sales",
  });
  assert.notEqual(out, null);
  assert.equal(out!.x, "Quarter · Period");
});

test("chartFromTable W-GMK2: multi-kind raw Period + PeriodKind → rows filtered to dominant kind before processing", () => {
  const rows = [
    { Period: "Q1 25", PeriodKind: "Quarter", Value_sum: 100 },
    { Period: "Q2 25", PeriodKind: "Quarter", Value_sum: 200 },
    { Period: "Q3 25", PeriodKind: "Quarter", Value_sum: 300 },
    { Period: "Q4 25", PeriodKind: "Quarter", Value_sum: 400 },
    { Period: "Latest 12 Mths", PeriodKind: "Rolling", Value_sum: 9000 },
    { Period: "YTD", PeriodKind: "YTD", Value_sum: 5000 },
  ];
  const out = buildChartFromAnalyticalTable({
    table: { rows, columns: ["Period", "PeriodKind", "Value_sum"] },
    summary: makeSummary({ numericColumns: ["Value_sum"] }),
    question: "sales by period",
  });
  assert.notEqual(out, null);
  assert.equal(out!.x, "Period");
  // The filter should have removed the Rolling and YTD outliers from the
  // processed data — only quarter labels remain.
  const xValues = (out!.data ?? []).map((r) => String(r["Period"] ?? ""));
  assert.ok(!xValues.includes("Latest 12 Mths"));
  assert.ok(!xValues.includes("YTD"));
  assert.ok(xValues.some((v) => /^Q[1-4]/.test(v)));
  assert.match(out!.axisReason ?? "", /filtered to PeriodKind = Quarter/);
});

test("chartFromTable W-GMK2: cardinality-1 dimension is pruned in the non-period fallback", () => {
  // No period column at all → falls to cardinality-pruning path. Products
  // is the only non-numeric column and has just "MARICO" — should return
  // null instead of a useless single-bar chart.
  const rows = [
    { Products: "MARICO", Value_sum: 100 },
    { Products: "MARICO", Value_sum: 200 },
    { Products: "MARICO", Value_sum: 300 },
  ];
  const out = buildChartFromAnalyticalTable({
    table: { rows, columns: ["Products", "Value_sum"] },
    summary: makeSummary({ numericColumns: ["Value_sum"] }),
    question: "show me sales",
  });
  assert.equal(out, null);
});

test("chartFromTable W-GMK2: cardinality-1 dim is skipped, a higher-cardinality dim is picked", () => {
  const rows = [
    { Products: "MARICO", Region: "North", Value_sum: 100 },
    { Products: "MARICO", Region: "South", Value_sum: 200 },
    { Products: "MARICO", Region: "East", Value_sum: 300 },
  ];
  const out = buildChartFromAnalyticalTable({
    table: { rows, columns: ["Products", "Region", "Value_sum"] },
    summary: makeSummary({ numericColumns: ["Value_sum"] }),
    question: "sales by region",
  });
  assert.notEqual(out, null);
  assert.equal(out!.x, "Region");
});

test("chartFromTable W-GMK2: pre-wave behaviour preserved when only one categorical dim with cardinality ≥ 2", () => {
  const rows = [
    { Category: "Technology", Sales_sum: 827_455 },
    { Category: "Furniture", Sales_sum: 728_658 },
    { Category: "Office Supplies", Sales_sum: 705_415 },
  ];
  const out = buildChartFromAnalyticalTable({
    table: { rows, columns: ["Category", "Sales_sum"] },
    summary: makeSummary({ numericColumns: ["Sales_sum"] }),
    question: "which category did great",
  });
  assert.notEqual(out, null);
  assert.equal(out!.x, "Category");
  // No period column → no axisReason.
  assert.equal(out!.axisReason, undefined);
});

test("chartFromTable W-GMK2: axisReason absent for non-period charts", () => {
  const rows = [
    { Region: "North", Sales_sum: 100 },
    { Region: "South", Sales_sum: 200 },
  ];
  const out = buildChartFromAnalyticalTable({
    table: { rows, columns: ["Region", "Sales_sum"] },
    summary: makeSummary({ numericColumns: ["Sales_sum"] }),
    question: "?",
  });
  assert.notEqual(out, null);
  assert.equal(out!.axisReason, undefined);
});
