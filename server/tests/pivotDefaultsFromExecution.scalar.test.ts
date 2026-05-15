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

describe("derivePivotDefaultsFromExecutionMerged · data-prep-only trace", () => {
  // The user-reported bug: "What is the average shipping time for orders" runs
  // `add_computed_columns(ship_time = Ship Date - Order Date)` and the agent
  // narrator computes the avg from observations directly — no follow-up
  // `execute_query_plan` step. The `table` plumbed into the merge is the
  // full row-level frame from the data-prep tool. Without this guard the
  // schema-heuristic preview fallback would categorize every dimension
  // as a pivot row and surface the catastrophic "every column on ROWS"
  // cascade. Suppress instead.
  it("flags scalar=true when trace contains only add_computed_columns (no analytical step)", () => {
    const out = derivePivotDefaultsFromExecutionMerged(
      summary(),
      {
        steps: [
          {
            tool: "add_computed_columns",
            args: {
              columns: [
                {
                  name: "Shipping Time (Days)",
                  def: { op: "date_diff", left: "Ship Date", right: "Order Date", unit: "days" },
                },
              ],
            },
          },
        ],
      },
      {
        // Row-level frame returned by add_computed_columns.
        rows: [
          { "Order Date": "2018-12-01", Region: "West", Sales: 100, "Shipping Time (Days)": 4 },
          { "Order Date": "2018-12-05", Region: "East", Sales: 50, "Shipping Time (Days)": 3 },
          { "Order Date": "2018-12-09", Region: "West", Sales: 75, "Shipping Time (Days)": 5 },
        ],
        columns: ["Order Date", "Region", "Sales", "Shipping Time (Days)"],
      }
    );
    assert.equal(out?.scalar, true);
    assert.deepEqual(out?.rows, []);
    assert.deepEqual(out?.values, []);
  });

  it("flags scalar=true when trace contains only derive_dimension_bucket (no analytical step)", () => {
    const out = derivePivotDefaultsFromExecutionMerged(
      summary(),
      {
        steps: [
          {
            tool: "derive_dimension_bucket",
            args: { column: "Sales", buckets: [{ label: "low", max: 50 }] },
          },
        ],
      },
      {
        rows: [
          { Region: "East", Sales: 50, Sales_bucket: "low" },
          { Region: "West", Sales: 100, Sales_bucket: "high" },
        ],
        columns: ["Region", "Sales", "Sales_bucket"],
      }
    );
    assert.equal(out?.scalar, true);
  });

  it("does NOT flag scalar when add_computed_columns is followed by an analytical execute_query_plan", () => {
    // The "Which regions ship slowest?" regression case: derived column +
    // genuine group-by → must render the pivot normally.
    const out = derivePivotDefaultsFromExecutionMerged(
      summary(),
      {
        steps: [
          {
            tool: "add_computed_columns",
            args: {
              columns: [
                {
                  name: "Shipping Time (Days)",
                  def: { op: "date_diff", left: "Ship Date", right: "Order Date", unit: "days" },
                },
              ],
            },
          },
          {
            tool: "execute_query_plan",
            args: {
              plan: {
                groupBy: ["Region"],
                aggregations: [{ column: "Shipping Time (Days)", operation: "mean" }],
              },
            },
          },
        ],
      },
      {
        rows: [
          { Region: "East", "Shipping Time (Days)_mean": 3.5 },
          { Region: "West", "Shipping Time (Days)_mean": 4.2 },
        ],
        columns: ["Region", "Shipping Time (Days)_mean"],
      }
    );
    assert.notEqual(out?.scalar, true);
    assert.deepEqual(out?.rows, ["Region"]);
    assert.deepEqual(out?.values, ["Shipping Time (Days)"]);
  });
});
