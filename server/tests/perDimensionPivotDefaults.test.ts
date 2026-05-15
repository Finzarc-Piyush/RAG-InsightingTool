/**
 * Wave PD1 · `pivotDefaultsFromExecution` integration with nested
 * aggregations. Pins:
 *  - aliasToSource mirrors the new `${col}_${op}_per_${safePerDim}` shape
 *    so the executor's auto-aliased result columns round-trip back to the
 *    source column name in `pivotDefaults.values`.
 *  - PAG1's `valueAggregators` still uses the OUTER operation (mean for
 *    nested mean-per-day, etc.) — the pivot can't represent the nested
 *    structure natively, so the outer aggregator is the closest faithful
 *    chip default.
 *  - The bonus: `columns` is pre-populated with the perDimension when the
 *    plan is nested and no other columns hint was derived (caps at
 *    60-cardinality on uniqueCount/topValues to avoid blow-out).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergePivotDefaultRowsAndValues } from "../lib/pivotDefaultsFromExecution.js";
import type { DataSummary } from "../shared/schema.js";
import type { QueryPlanBody } from "../lib/queryPlanExecutor.js";

function summary(extra?: Partial<DataSummary>): DataSummary {
  return {
    rowCount: 1000,
    columnCount: 4,
    columns: [
      { name: "Compliance Visit", type: "number", sampleValues: [] },
      { name: "Cluster Name", type: "string", sampleValues: [] },
      {
        name: "Day · TSOE-Date Combo",
        type: "string",
        sampleValues: [],
        topValues: Array.from({ length: 30 }, (_, i) => ({
          value: `2026-04-${String(i + 1).padStart(2, "0")}`,
          count: 1,
        })),
      },
    ],
    numericColumns: ["Compliance Visit"],
    dateColumns: ["TSOE-Date Combo"],
    ...(extra ?? {}),
  } as DataSummary;
}

describe("Wave PD1 · pivotDefaults integration with nested aggregation", () => {
  it("aliasToSource maps `${col}_${op}_per_${safePerDim}` back to the source column", () => {
    // Executor's auto-aliased column "Compliance Visit_mean_per_Day_TSOE_Date_Combo"
    // must round-trip back to "Compliance Visit" in pivotDefaults.values.
    const plan: QueryPlanBody = {
      groupBy: ["Cluster Name"],
      aggregations: [
        {
          column: "Compliance Visit",
          operation: "mean",
          perDimension: "Day · TSOE-Date Combo",
          innerOperation: "sum",
        },
      ],
    };
    const out = mergePivotDefaultRowsAndValues({
      dataSummary: summary(),
      tracePlan: plan,
      tableRows: [
        {
          "Cluster Name": "Cluster 2 WEST",
          "Compliance Visit_mean_per_Day_TSOE_Date_Combo": 35,
        },
      ],
      tableColumns: [
        "Cluster Name",
        "Compliance Visit_mean_per_Day_TSOE_Date_Combo",
      ],
    });
    assert.ok(out, "should produce pivot defaults");
    assert.deepEqual(out!.rows, ["Cluster Name"]);
    assert.deepEqual(out!.values, ["Compliance Visit"]);
  });

  it("PAG1 valueAggregators carries the OUTER operation (mean) for nested mean-per-day", () => {
    const plan: QueryPlanBody = {
      groupBy: ["Cluster Name"],
      aggregations: [
        {
          column: "Compliance Visit",
          operation: "mean",
          perDimension: "Day · TSOE-Date Combo",
          innerOperation: "sum",
        },
      ],
    };
    const out = mergePivotDefaultRowsAndValues({
      dataSummary: summary(),
      tracePlan: plan,
      tableRows: [
        {
          "Cluster Name": "Cluster 1 NORTH",
          "Compliance Visit_mean_per_Day_TSOE_Date_Combo": 12,
        },
      ],
      tableColumns: [
        "Cluster Name",
        "Compliance Visit_mean_per_Day_TSOE_Date_Combo",
      ],
    });
    assert.deepEqual(out!.valueAggregators, {
      "Compliance Visit": "mean",
    });
  });

  it("pre-populates `columns: [perDimension]` when the plan is nested and column cardinality ≤ 60", () => {
    const plan: QueryPlanBody = {
      groupBy: ["Cluster Name"],
      aggregations: [
        {
          column: "Compliance Visit",
          operation: "mean",
          perDimension: "Day · TSOE-Date Combo",
          innerOperation: "sum",
        },
      ],
    };
    const out = mergePivotDefaultRowsAndValues({
      dataSummary: summary(),
      tracePlan: plan,
      tableRows: [
        {
          "Cluster Name": "Cluster 1 EAST",
          "Compliance Visit_mean_per_Day_TSOE_Date_Combo": 22,
        },
      ],
      tableColumns: [
        "Cluster Name",
        "Compliance Visit_mean_per_Day_TSOE_Date_Combo",
      ],
    });
    // Bonus: per-day breakdown is on the COLUMNS axis so pivot view shows
    // a cross-tab of cluster (rows) × day (columns) of the bucket totals.
    assert.deepEqual(out!.columns, ["Day · TSOE-Date Combo"]);
  });

  it("does NOT pre-populate columns when per-dimension cardinality > 60", () => {
    const highCard = summary({
      columns: [
        { name: "Compliance Visit", type: "number", sampleValues: [] },
        { name: "Cluster Name", type: "string", sampleValues: [] },
        {
          name: "Day · TSOE-Date Combo",
          type: "string",
          sampleValues: [],
          // Simulate a year of daily data — 365 distinct values
          topValues: Array.from({ length: 100 }, (_, i) => ({
            value: `2026-${String(i).padStart(3, "0")}`,
            count: 1,
          })),
          uniqueCount: 365,
        } as never,
      ],
    });
    const plan: QueryPlanBody = {
      groupBy: ["Cluster Name"],
      aggregations: [
        {
          column: "Compliance Visit",
          operation: "mean",
          perDimension: "Day · TSOE-Date Combo",
          innerOperation: "sum",
        },
      ],
    };
    const out = mergePivotDefaultRowsAndValues({
      dataSummary: highCard,
      tracePlan: plan,
      tableRows: [
        {
          "Cluster Name": "Cluster 1 EAST",
          "Compliance Visit_mean_per_Day_TSOE_Date_Combo": 9,
        },
      ],
      tableColumns: [
        "Cluster Name",
        "Compliance Visit_mean_per_Day_TSOE_Date_Combo",
      ],
    });
    // No `columns` field — pivot view stays rows-only on switch.
    assert.equal(out!.columns, undefined);
  });

  it("does NOT pre-populate columns when the row axis already includes the perDimension", () => {
    // If for some reason rows already includes the perDim (planner did it
    // and PD1 chose not to rewrite), don't double-list it on columns.
    const plan: QueryPlanBody = {
      groupBy: ["Cluster Name", "Day · TSOE-Date Combo"],
      aggregations: [
        {
          column: "Compliance Visit",
          operation: "sum",
          perDimension: "Day · TSOE-Date Combo",
          innerOperation: "sum",
        },
      ],
    };
    const out = mergePivotDefaultRowsAndValues({
      dataSummary: summary(),
      tracePlan: plan,
      tableRows: [
        {
          "Cluster Name": "Cluster 1 EAST",
          "Day · TSOE-Date Combo": "2026-04-01",
          "Compliance Visit_sum_per_Day_TSOE_Date_Combo": 10,
        },
      ],
      tableColumns: [
        "Cluster Name",
        "Day · TSOE-Date Combo",
        "Compliance Visit_sum_per_Day_TSOE_Date_Combo",
      ],
    });
    assert.ok(out);
    // perDim is already on rows OR columns from suggestPivotColumnsFromDimensions,
    // so we must NOT double-list it. Whatever axis it lives on, the
    // important thing is `columns` is not == `rows`.
    const onColumns = (out!.columns ?? []).includes("Day · TSOE-Date Combo");
    const onRows = out!.rows.includes("Day · TSOE-Date Combo");
    assert.ok(
      onColumns || onRows,
      "perDimension must appear on exactly one axis"
    );
    if (onColumns) {
      assert.ok(!onRows, "must not appear on both axes");
    }
  });
});
