import { test } from "node:test";
import assert from "node:assert/strict";

import { enumerateMissingDashboardCharts } from "../lib/agents/runtime/dashboardFeatureSweep.js";
import type { AgentExecutionContext } from "../lib/agents/runtime/types.js";
import type { AnalysisBrief, ChartSpec, DataSummary } from "../shared/schema.js";

function makeBrief(over: Partial<AnalysisBrief> = {}): AnalysisBrief {
  return {
    version: 1,
    clarifyingQuestions: [],
    epistemicNotes: [],
    ...over,
  } as AnalysisBrief;
}

function makeCtx(
  brief: AnalysisBrief | undefined,
  data: Record<string, unknown>[],
  numericColumns: string[],
  dateColumns: string[] = []
): AgentExecutionContext {
  const colNames = Object.keys(data[0] ?? {});
  const summary: DataSummary = {
    rowCount: data.length,
    columnCount: colNames.length,
    columns: colNames.map((name) => ({
      name,
      type: numericColumns.includes(name) ? "number" : "string",
      sampleValues: [],
    })),
    numericColumns,
    dateColumns,
  };
  return {
    sessionId: "s",
    question: "create a sales dashboard",
    data: data as Record<string, any>[],
    turnStartDataRef: data as Record<string, any>[],
    analysisBrief: brief,
    summary,
    chatHistory: [],
    mode: "analysis",
  } as AgentExecutionContext;
}

test("returns [] when requestsDashboard is unset", () => {
  const ctx = makeCtx(undefined, [{ Region: "East", Sales: 10 }], ["Sales"]);
  assert.deepEqual(enumerateMissingDashboardCharts(ctx, []), []);
});

test("returns [] when outcomeMetricColumn is missing or non-numeric", () => {
  const data = [{ Region: "East", Sales: 10 }];
  const ctx1 = makeCtx(
    makeBrief({ requestsDashboard: true, segmentationDimensions: ["Region"] }),
    data,
    ["Sales"]
  );
  assert.deepEqual(enumerateMissingDashboardCharts(ctx1, []), []);

  const ctx2 = makeCtx(
    makeBrief({
      requestsDashboard: true,
      outcomeMetricColumn: "Region", // not numeric
      segmentationDimensions: ["Region"],
    }),
    data,
    ["Sales"]
  );
  assert.deepEqual(enumerateMissingDashboardCharts(ctx2, []), []);
});

test("builds outcome-by-dim charts for every uncovered dimension", () => {
  const data = [
    { Region: "East", Category: "Tech", Channel: "Online", Sales: 10 },
    { Region: "West", Category: "Furniture", Channel: "Retail", Sales: 20 },
    { Region: "North", Category: "Office", Channel: "Online", Sales: 15 },
    { Region: "South", Category: "Tech", Channel: "Retail", Sales: 30 },
  ];
  const ctx = makeCtx(
    makeBrief({
      outcomeMetricColumn: "Sales",
      segmentationDimensions: ["Region", "Category"],
      candidateDriverDimensions: ["Channel"],
      requestsDashboard: true,
    }),
    data,
    ["Sales"]
  );
  const out = enumerateMissingDashboardCharts(ctx, []);
  const xs = out.map((c) => c.x);
  assert.ok(xs.includes("Region"), `expected Region, got ${xs.join(",")}`);
  assert.ok(xs.includes("Category"));
  assert.ok(xs.includes("Channel"));
  assert.equal(out.length, 3);
  for (const c of out) {
    assert.equal(c.type, "bar");
  }
});

test("skips dimensions already covered by mergedCharts", () => {
  const data = [
    { Region: "East", Category: "Tech", Sales: 10 },
    { Region: "West", Category: "Furniture", Sales: 20 },
  ];
  const ctx = makeCtx(
    makeBrief({
      outcomeMetricColumn: "Sales",
      segmentationDimensions: ["Region", "Category"],
      requestsDashboard: true,
    }),
    data,
    ["Sales"]
  );
  const existing: ChartSpec[] = [
    {
      type: "bar",
      title: "Sales by Region",
      x: "Region",
      y: "Sales_sum",
      aggregate: "sum",
    } as ChartSpec,
  ];
  const out = enumerateMissingDashboardCharts(ctx, existing);
  const xs = out.map((c) => c.x);
  assert.ok(!xs.includes("Region"), "Region was already covered");
  assert.ok(xs.includes("Category"));
});

test("DB4: medium-cardinality dimensions (60 < uniques ≤ 500) are charted via top-N + Other bucketing", () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({
    CustomerID: `C-${i}`,
    Region: i % 4 === 0 ? "East" : "West",
    Sales: i + 1,
  }));
  const ctx = makeCtx(
    makeBrief({
      outcomeMetricColumn: "Sales",
      segmentationDimensions: ["CustomerID", "Region"],
      requestsDashboard: true,
    }),
    rows,
    ["Sales"]
  );
  const out = enumerateMissingDashboardCharts(ctx, []);
  const xs = out.map((c) => c.x);
  // Pre-DB4 CustomerID was silently skipped because >60 uniques. DB4 buckets
  // the dim into top-15 + Other so the chart is legible AND the dim appears.
  assert.ok(xs.includes("CustomerID"), "medium-cardinality dim should be bucketed and charted");
  assert.ok(xs.includes("Region"));
  const customerChart = out.find((c) => c.x === "CustomerID");
  assert.ok(customerChart);
  // The processed chart data should contain "Other" as a category — proof the
  // bucketing helper flowed through to the rendered spec.
  const xsInChartData = (customerChart!.data as Array<Record<string, unknown>>).map(
    (r) => String(r.CustomerID)
  );
  assert.ok(xsInChartData.includes("Other"), "Other bucket should appear after rollup");
  // Top-15 native rows + 1 Other row = at most 16 distinct categories.
  const distinct = new Set(xsInChartData);
  assert.ok(distinct.size <= 16, `expected ≤16 distinct x values, got ${distinct.size}`);
});

test("DB4: high-cardinality dimensions (>500 uniques) are still skipped and reported", () => {
  const rows = Array.from({ length: 1000 }, (_, i) => ({
    AccountID: `A-${i}`,
    Region: i % 4 === 0 ? "East" : "West",
    Sales: i + 1,
  }));
  const ctx = makeCtx(
    makeBrief({
      outcomeMetricColumn: "Sales",
      segmentationDimensions: ["AccountID", "Region"],
      requestsDashboard: true,
    }),
    rows,
    ["Sales"]
  );
  const report = {
    skippedHighCardinality: [] as Array<{ dimension: string; uniques: number }>,
    bucketedDimensions: [] as Array<{ dimension: string; uniques: number; topN: number }>,
  };
  const out = enumerateMissingDashboardCharts(ctx, [], {}, report);
  const xs = out.map((c) => c.x);
  assert.ok(!xs.includes("AccountID"), "1000-unique dim should be skipped entirely");
  assert.ok(xs.includes("Region"));
  assert.strictEqual(report.skippedHighCardinality.length, 1);
  assert.strictEqual(report.skippedHighCardinality[0].dimension, "AccountID");
  assert.ok(report.skippedHighCardinality[0].uniques > 500);
});

test("DB4: bucketRowsTopN keeps the top-N values verbatim and rewrites the rest to 'Other'", async () => {
  const { __test__ } = await import("../lib/agents/runtime/dashboardFeatureSweep.js");
  const rows = [
    { Cust: "A", S: 100 },
    { Cust: "B", S: 80 },
    { Cust: "C", S: 60 },
    { Cust: "D", S: 40 },
    { Cust: "E", S: 20 },
    { Cust: "F", S: 10 },
    { Cust: "G", S: 5 },
  ];
  const out = __test__.bucketRowsTopN(rows, "Cust", 3, "S");
  // Top-3 by sum(S) = A, B, C — those stay; D-G become "Other".
  assert.deepStrictEqual(
    out.map((r) => r.Cust),
    ["A", "B", "C", "Other", "Other", "Other", "Other"]
  );
  // Original input should be untouched (function is pure).
  assert.strictEqual(rows[3].Cust, "D");
});

test("adds a date trend when no chart yet uses the date column", () => {
  const data = [
    { OrderDate: "2024-01-01", Region: "East", Sales: 10 },
    { OrderDate: "2024-02-01", Region: "West", Sales: 20 },
    { OrderDate: "2024-03-01", Region: "North", Sales: 15 },
  ];
  const ctx = makeCtx(
    makeBrief({
      outcomeMetricColumn: "Sales",
      segmentationDimensions: ["Region"],
      requestsDashboard: true,
    }),
    data,
    ["Sales"],
    ["OrderDate"]
  );
  const out = enumerateMissingDashboardCharts(ctx, []);
  const trend = out.find((c) => c.type === "line" && c.x === "OrderDate");
  assert.ok(trend, "expected a line trend on OrderDate");
});

test("respects maxAdds cap", () => {
  const data = Array.from({ length: 6 }, (_, i) => ({
    A: `a-${i % 3}`,
    B: `b-${i % 2}`,
    C: `c-${i % 3}`,
    D: `d-${i % 2}`,
    E: `e-${i % 2}`,
    Sales: i,
  }));
  const ctx = makeCtx(
    makeBrief({
      outcomeMetricColumn: "Sales",
      segmentationDimensions: ["A", "B", "C", "D", "E"],
      requestsDashboard: true,
    }),
    data,
    ["Sales"]
  );
  const out = enumerateMissingDashboardCharts(ctx, [], { maxAdds: 2 });
  assert.equal(out.length, 2);
});
