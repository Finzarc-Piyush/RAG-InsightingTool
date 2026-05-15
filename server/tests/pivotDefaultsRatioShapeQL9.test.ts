/**
 * Wave QL9.A · `derivePivotDefaultsFromExecutionMerged` surfaces the QL7
 * ratio-shape's aggregation aliases (incl. `computedAggregations`) to the
 * pivot's VALUES shelf. Before this fix, the scalar branch returned
 * `{rows:[], values:[], scalar:true}` for a 1-row result, the chat-stream
 * suppressed the pivot entirely, and the UI fell back to listing raw
 * dataset columns in the field picker — the user could not see the
 * aggregation result columns (`total_compliance_visit`,
 * `num_distinct_date`, `avg_compliance_visit_per_date`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { derivePivotDefaultsFromExecutionMerged } from "../lib/pivotDefaultsFromExecution.js";
import type { DataSummary } from "../shared/schema.js";

function summary(): DataSummary {
  return {
    rowCount: 10006,
    columnCount: 3,
    columns: [
      { name: "Compliance Visit", type: "number", sampleValues: [] },
      { name: "Date", type: "date", sampleValues: [] },
      { name: "Cluster Name", type: "string", sampleValues: [] },
    ],
    numericColumns: ["Compliance Visit"],
    dateColumns: ["Date"],
  };
}

describe("Wave QL9.A · pivot defaults surface ratio-shape aliases", () => {
  it("scalar QL7 ratio plan: pivot VALUES contain SUM + COUNT_DISTINCT + computed ratio aliases", () => {
    const agentTrace = {
      steps: [
        {
          id: "ql2_synth_abc",
          tool: "execute_query_plan",
          args: {
            plan: {
              aggregations: [
                {
                  column: "Compliance Visit",
                  operation: "sum",
                  alias: "total_compliance_visit",
                },
                {
                  column: "Date",
                  operation: "count_distinct",
                  alias: "num_distinct_date",
                },
              ],
              computedAggregations: [
                {
                  alias: "avg_compliance_visit_per_date",
                  expression:
                    "total_compliance_visit / num_distinct_date",
                },
              ],
            },
          },
        },
      ],
    };
    const table = {
      columns: [
        "total_compliance_visit",
        "num_distinct_date",
        "avg_compliance_visit_per_date",
      ],
      rows: [
        {
          total_compliance_visit: 104870,
          num_distinct_date: 30,
          avg_compliance_visit_per_date: 3495.67,
        },
      ],
    };
    const defaults = derivePivotDefaultsFromExecutionMerged(
      summary(),
      agentTrace,
      table
    );
    assert.ok(defaults, "expected non-undefined pivot defaults");
    assert.deepEqual(defaults!.rows, []);
    // All three result columns must be available as VALUES.
    assert.deepEqual(defaults!.values, [
      "total_compliance_visit",
      "num_distinct_date",
      "avg_compliance_visit_per_date",
    ]);
    assert.equal(defaults!.scalar, false);
  });

  it("scalar with NO aliases still returns scalar:true (legacy / synthesizer fallback)", () => {
    // The trace plan exists but has no `alias` / `computedAggregations`,
    // mimicking a legacy plan from before Wave QL7 or a synthesizer-fallback
    // path. The scalar branch should suppress the pivot rather than leak
    // raw source columns.
    const agentTrace = {
      steps: [
        {
          id: "llm_legacy",
          tool: "execute_query_plan",
          args: {
            plan: {
              aggregations: [
                { column: "Compliance Visit", operation: "mean" },
              ],
            },
          },
        },
      ],
    };
    const table = {
      columns: ["Compliance Visit_mean"],
      rows: [{ "Compliance Visit_mean": 3.5 }],
    };
    const defaults = derivePivotDefaultsFromExecutionMerged(
      summary(),
      agentTrace,
      table
    );
    assert.ok(defaults);
    assert.equal(defaults!.scalar, true);
    assert.deepEqual(defaults!.values, []);
  });

  it("non-scalar QL7 ratio plan (groupBy=[cluster]): pivot is interactive and stays on base-table columns", () => {
    // Wave QL9.A intentionally does NOT push aliases into the interactive
    // pivot for non-scalar results. The interactive pivot re-queries the
    // base `data` table via pivotQueryService, which can only resolve raw
    // column references. Computed aliases (`avg_compliance_visit_per_date`)
    // don't exist on `data` and would crash the pivot SQL build.
    //
    // Instead, the user sees:
    //   - Pivot tab: interactive grid with Cluster Name on ROWS, Compliance
    //     Visit on VALUES (the source columns, agent's `sum` aggregator
    //     stamped via PAG1 → user sees clean per-cluster totals).
    //   - Table tab: the FULL aggregation result with all three result
    //     columns (total, count, avg) visible as-rendered.
    //
    // The QL7 ratio aliases surface in pivots ONLY in the scalar branch
    // (1-row result with no groupBy — covered by the first test in this file).
    const agentTrace = {
      steps: [
        {
          id: "ql2_synth_xyz",
          tool: "execute_query_plan",
          args: {
            plan: {
              groupBy: ["Cluster Name"],
              aggregations: [
                {
                  column: "Compliance Visit",
                  operation: "sum",
                  alias: "total_compliance_visit",
                },
                {
                  column: "Date",
                  operation: "count_distinct",
                  alias: "num_distinct_date",
                },
              ],
              computedAggregations: [
                {
                  alias: "avg_compliance_visit_per_date",
                  expression:
                    "total_compliance_visit / num_distinct_date",
                },
              ],
            },
          },
        },
      ],
    };
    const table = {
      columns: [
        "Cluster Name",
        "total_compliance_visit",
        "num_distinct_date",
        "avg_compliance_visit_per_date",
      ],
      rows: [
        {
          "Cluster Name": "A",
          total_compliance_visit: 50000,
          num_distinct_date: 30,
          avg_compliance_visit_per_date: 1666.67,
        },
        {
          "Cluster Name": "B",
          total_compliance_visit: 54870,
          num_distinct_date: 30,
          avg_compliance_visit_per_date: 1829,
        },
      ],
    };
    const defaults = derivePivotDefaultsFromExecutionMerged(
      summary(),
      agentTrace,
      table
    );
    assert.ok(defaults);
    assert.deepEqual(defaults!.rows, ["Cluster Name"]);
    // Pivot's interactive VALUES list stays on a base-table column with the
    // agent's `sum` aggregator pre-set (PAG1).
    assert.deepEqual(defaults!.values, ["Compliance Visit"]);
    assert.notEqual(defaults!.scalar, true);
  });
});
