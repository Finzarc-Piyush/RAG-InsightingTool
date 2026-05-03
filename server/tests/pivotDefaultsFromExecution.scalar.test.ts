import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { derivePivotDefaultsFromExecutionMerged } from "../lib/pivotDefaultsFromExecution.js";
import type { DataSummary } from "../shared/schema.js";

function summary(): DataSummary {
  return {
    rowCount: 9800,
    columnCount: 4,
    columns: [
      { name: "Sales", type: "number", sampleValues: [] },
      { name: "Postal Code", type: "number", sampleValues: [] },
      { name: "Order Date", type: "date", sampleValues: [] },
      { name: "Region", type: "string", sampleValues: [] },
      { name: "Shipping Time (Days)", type: "number", sampleValues: [] },
    ],
    numericColumns: ["Sales", "Postal Code", "Shipping Time (Days)"],
    dateColumns: ["Order Date"],
  } as DataSummary;
}

describe("derivePivotDefaultsFromExecutionMerged · scalar", () => {
  it("flags scalar=true for execute_query_plan with empty groupBy + 1-row aggregate", () => {
    const out = derivePivotDefaultsFromExecutionMerged(
      summary(),
      {
        steps: [
          {
            tool: "execute_query_plan",
            args: {
              plan: {
                groupBy: [],
                aggregations: [
                  { column: "Shipping Time (Days)", operation: "mean" },
                ],
              },
            },
          },
        ],
      },
      {
        rows: [{ "Shipping Time (Days)_mean": 3.96 }],
        columns: ["Shipping Time (Days)_mean"],
      }
    );
    assert.equal(out?.scalar, true);
    assert.deepEqual(out?.rows, []);
    assert.deepEqual(out?.values, []);
  });

  it("flags scalar=true for run_analytical_query path (no execute_query_plan in trace)", () => {
    const out = derivePivotDefaultsFromExecutionMerged(
      summary(),
      { steps: [{ tool: "run_analytical_query", args: { question_override: "avg X" } }] },
      {
        rows: [{ "Shipping Time (Days)_mean": 3.96 }],
        columns: ["Shipping Time (Days)_mean"],
      }
    );
    assert.equal(out?.scalar, true);
    assert.deepEqual(out?.rows, []);
  });

  it("does NOT flag scalar when groupBy is non-empty (regression — group-by case still renders)", () => {
    const out = derivePivotDefaultsFromExecutionMerged(
      summary(),
      {
        steps: [
          {
            tool: "execute_query_plan",
            args: {
              plan: {
                groupBy: ["Region"],
                aggregations: [{ column: "Sales", operation: "sum" }],
              },
            },
          },
        ],
      },
      {
        rows: [
          { Region: "East", Sales_sum: 100 },
          { Region: "West", Sales_sum: 200 },
        ],
        columns: ["Region", "Sales_sum"],
      }
    );
    assert.notEqual(out?.scalar, true);
    assert.deepEqual(out?.rows, ["Region"]);
    assert.deepEqual(out?.values, ["Sales"]);
  });

  it("does NOT flag scalar when result has multiple rows even without groupBy in trace", () => {
    const out = derivePivotDefaultsFromExecutionMerged(
      summary(),
      { steps: [{ tool: "run_analytical_query", args: {} }] },
      {
        rows: [
          { Region: "East", "Shipping Time (Days)_mean": 3.5 },
          { Region: "West", "Shipping Time (Days)_mean": 4.2 },
        ],
        columns: ["Region", "Shipping Time (Days)_mean"],
      }
    );
    assert.notEqual(out?.scalar, true);
  });
});
