import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  derivePivotDefaultsFromExecutionMerged,
  mergePivotDefaultRowsAndValues,
} from "../lib/pivotDefaultsFromExecution.js";
import { facetColumnKey } from "../lib/temporalFacetColumns.js";
import type { DataSummary } from "../shared/schema.js";
import type { QueryPlanBody } from "../lib/queryPlanExecutor.js";

function minimalSummary(over: Partial<DataSummary> = {}): DataSummary {
  return {
    rowCount: 100,
    columnCount: 5,
    columns: [
      { name: "Sales", type: "number", sampleValues: [] },
      { name: "Order Date", type: "date", sampleValues: [] },
      { name: "Region", type: "string", sampleValues: [] },
    ],
    numericColumns: ["Sales"],
    dateColumns: ["Order Date"],
    ...over,
  } as DataSummary;
}

describe("mergePivotDefaultRowsAndValues", () => {
  it("keeps trace Region row when it appears on preview columns (regression)", () => {
    const summary = minimalSummary();
    const plan: QueryPlanBody = {
      groupBy: ["Region"],
      aggregations: [{ column: "Sales", operation: "sum" }],
    };
    const monthCol = facetColumnKey("Order Date", "month");
    const out = mergePivotDefaultRowsAndValues({
      dataSummary: summary,
      tracePlan: plan,
      tableRows: [{ Region: "East", Sales_sum: 100 }],
      tableColumns: ["Region", "Sales_sum"],
    });
    assert.deepEqual(out?.rows, ["Region"]);
    assert.deepEqual(out?.values, ["Sales"]);
  });

  it("uses preview row dimension when trace groupBy is raw date but output is temporal facet", () => {
    const summary = minimalSummary();
    const monthCol = facetColumnKey("Order Date", "month");
    const plan: QueryPlanBody = {
      groupBy: ["Order Date"],
      aggregations: [{ column: "Sales", operation: "sum" }],
    };
    const out = mergePivotDefaultRowsAndValues({
      dataSummary: summary,
      tracePlan: plan,
      tableRows: [{ [monthCol]: "2015-02", Sales_sum: 4519.892 }],
      tableColumns: [monthCol, "Sales_sum"],
    });
    assert.deepEqual(out?.rows, [monthCol]);
    assert.deepEqual(out?.values, ["Sales"]);
  });

  it("keeps trace Month facet row when preview keys match", () => {
    const summary = minimalSummary();
    const monthCol = facetColumnKey("Order Date", "month");
    const plan: QueryPlanBody = {
      groupBy: [monthCol],
      aggregations: [{ column: "Sales", operation: "sum" }],
    };
    const out = mergePivotDefaultRowsAndValues({
      dataSummary: summary,
      tracePlan: plan,
      tableRows: [{ [monthCol]: "2015-02", Sales_sum: 4519 }],
      tableColumns: [monthCol, "Sales_sum"],
    });
    assert.deepEqual(out?.rows, [monthCol]);
    assert.deepEqual(out?.values, ["Sales"]);
  });

  it("normalizes legacy __tf_month__ groupBy to display facet and matches preview", () => {
    const summary = minimalSummary({
      temporalFacetColumns: [
        {
          name: "__tf_month__Order_Date",
          sourceColumn: "Order Date",
          grain: "month",
        },
      ],
    });
    const monthCol = facetColumnKey("Order Date", "month");
    const plan: QueryPlanBody = {
      groupBy: ["__tf_month__Order_Date"],
      aggregations: [{ column: "Sales", operation: "sum" }],
    };
    const out = mergePivotDefaultRowsAndValues({
      dataSummary: summary,
      tracePlan: plan,
      tableRows: [{ [monthCol]: "2015-02", Sales_sum: 100 }],
      tableColumns: [monthCol, "Sales_sum"],
    });
    assert.deepEqual(out?.rows, [monthCol]);
    assert.deepEqual(out?.values, ["Sales"]);
  });

  it("keeps all trace groupBy row fields (three dimensions), not truncated to two", () => {
    const summary = minimalSummary({
      columns: [
        { name: "Sales", type: "number", sampleValues: [] },
        { name: "Order Date", type: "date", sampleValues: [] },
        { name: "Region", type: "string", sampleValues: [] },
        { name: "Category", type: "string", sampleValues: [] },
        { name: "Segment", type: "string", sampleValues: [] },
      ] as DataSummary["columns"],
    });
    const plan: QueryPlanBody = {
      groupBy: ["Region", "Category", "Segment"],
      aggregations: [{ column: "Sales", operation: "sum" }],
    };
    const out = mergePivotDefaultRowsAndValues({
      dataSummary: summary,
      tracePlan: plan,
      tableRows: [
        { Region: "West", Category: "Technology", Segment: "Consumer", Sales_sum: 100 },
      ],
      tableColumns: ["Region", "Category", "Segment", "Sales_sum"],
    });
    assert.deepEqual(out?.rows, ["Region", "Category", "Segment"]);
    assert.deepEqual(out?.values, ["Sales"]);
  });
});

describe("derivePivotDefaultsFromExecutionMerged", () => {
  it("reads last execute_query_plan from agent trace", () => {
    const summary = minimalSummary();
    const monthCol = facetColumnKey("Order Date", "month");
    const table = {
      rows: [{ [monthCol]: "2015-02", Sales_sum: 10 }],
      columns: [monthCol, "Sales_sum"],
    };
    const agentTrace = {
      steps: [
        {
          tool: "execute_query_plan",
          args: {
            plan: {
              groupBy: [monthCol],
              aggregations: [{ column: "Sales", operation: "sum" }],
            },
          },
        },
      ],
    };
    const out = derivePivotDefaultsFromExecutionMerged(summary, agentTrace, table);
    assert.deepEqual(out?.rows, [monthCol]);
    assert.deepEqual(out?.values, ["Sales"]);
  });

  it("falls back to preview-only when no trace plan", () => {
    const summary = minimalSummary();
    const monthCol = facetColumnKey("Order Date", "month");
    const table = {
      rows: [{ [monthCol]: "2015-02", Sales_sum: 10 }],
      columns: [monthCol, "Sales_sum"],
    };
    const out = derivePivotDefaultsFromExecutionMerged(summary, {}, table);
    assert.deepEqual(out?.rows, [monthCol]);
    assert.deepEqual(out?.values, ["Sales"]);
  });

  it("preview-only path returns all row dimensions from wide preview (three+)", () => {
    const summary = minimalSummary({
      columns: [
        { name: "Sales", type: "number", sampleValues: [] },
        { name: "Region", type: "string", sampleValues: [] },
        { name: "Category", type: "string", sampleValues: [] },
        { name: "Segment", type: "string", sampleValues: [] },
      ] as DataSummary["columns"],
    });
    const table = {
      rows: [
        {
          Region: "West",
          Category: "Technology",
          Segment: "Consumer",
          Sales_sum: 42,
        },
      ],
      columns: ["Region", "Category", "Segment", "Sales_sum"],
    };
    const out = derivePivotDefaultsFromExecutionMerged(summary, {}, table);
    assert.deepEqual(out?.rows, ["Region", "Category", "Segment"]);
    assert.deepEqual(out?.values, ["Sales"]);
  });
});
