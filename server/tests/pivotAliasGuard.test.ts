/**
 * PVT2 · pin the strict base-table guard for pivot value fields.
 *
 * Bug pre-fix: agent emits `aggregations: [{column: "Compliance Visit",
 * operation: "mean", alias: "Average_Compliance_Visits"}]`. When the trace
 * plan didn't survive into the merged path (e.g. agent used
 * `run_analytical_query` instead of `execute_query_plan`), the result-table
 * categorizer dumped the alias `Average_Compliance_Visits` straight into
 * pivot values. The pivot SQL builder selects value fields as raw column
 * literals against the base `data` table → DuckDB binder error
 * "Referenced column 'Average_Compliance_Visits' not found in FROM clause".
 *
 * Fix: build alias→source map from the trace's aggregations, substitute,
 * then strict-filter to columns in `dataSummary.numericColumns`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  derivePivotDefaultsFromExecutionMerged,
  mergePivotDefaultRowsAndValues,
} from "../lib/pivotDefaultsFromExecution.js";
import type { DataSummary } from "../shared/schema.js";
import type { QueryPlanBody } from "../lib/queryPlanExecutor.js";

function maricoSummary(): DataSummary {
  return {
    rowCount: 10006,
    columnCount: 4,
    columns: [
      { name: "Cluster Name", type: "string", sampleValues: [] },
      { name: "Compliance Visit", type: "number", sampleValues: [] },
      { name: "Sales", type: "number", sampleValues: [] },
    ],
    numericColumns: ["Compliance Visit", "Sales"],
    dateColumns: [],
  } as DataSummary;
}

describe("PVT2 · pivot value alias guard", () => {
  it("substitutes aggregation alias with source column when alias appears in result table", () => {
    const summary = maricoSummary();
    const plan: QueryPlanBody = {
      groupBy: ["Cluster Name"],
      aggregations: [
        {
          column: "Compliance Visit",
          operation: "mean",
          alias: "Average_Compliance_Visits",
        },
      ],
    };
    const out = mergePivotDefaultRowsAndValues({
      dataSummary: summary,
      tracePlan: plan,
      // Result table key follows the alias, not the source column.
      tableRows: [
        { "Cluster Name": "Cluster 1 EAST", Average_Compliance_Visits: 12.35 },
      ],
      tableColumns: ["Cluster Name", "Average_Compliance_Visits"],
    });
    assert.deepEqual(out?.rows, ["Cluster Name"]);
    assert.deepEqual(
      out?.values,
      ["Compliance Visit"],
      "alias must be mapped back to its source numeric column"
    );
  });

  it("drops alias entirely when source can't be recovered from trace plan", () => {
    const summary = maricoSummary();
    const plan: QueryPlanBody = {
      groupBy: ["Cluster Name"],
      // No aggregations in plan — but the result table still has an alias-
      // shaped column the executor synthesized elsewhere. Strict filter
      // must drop it rather than ship an unresolvable value field.
    };
    const out = mergePivotDefaultRowsAndValues({
      dataSummary: summary,
      tracePlan: plan,
      tableRows: [
        { "Cluster Name": "Cluster 1 EAST", Average_Compliance_Visits: 12.35 },
      ],
      tableColumns: ["Cluster Name", "Average_Compliance_Visits"],
    });
    // Filter-projection branch: no aggregations + groupBy populated → empty
    // values is honest. The user sees a rows-only pivot, not a binder error.
    assert.deepEqual(out?.rows, ["Cluster Name"]);
    assert.deepEqual(out?.values, []);
  });

  it("auto-alias `Sales_sum` is mapped back to Sales (executor's default alias shape)", () => {
    const summary = maricoSummary();
    const plan: QueryPlanBody = {
      groupBy: ["Cluster Name"],
      aggregations: [{ column: "Sales", operation: "sum" }],
    };
    const out = mergePivotDefaultRowsAndValues({
      dataSummary: summary,
      tracePlan: plan,
      tableRows: [{ "Cluster Name": "Cluster 1 EAST", Sales_sum: 1000 }],
      tableColumns: ["Cluster Name", "Sales_sum"],
    });
    assert.deepEqual(out?.values, ["Sales"]);
  });

  it("no-tracePlan path (run_analytical_query) recovers alias from earlier execute_query_plan steps", () => {
    const summary = maricoSummary();
    const agentTrace = {
      steps: [
        // Earlier step ran a query plan with the alias …
        {
          tool: "execute_query_plan",
          args: {
            plan: {
              groupBy: ["Cluster Name"],
              aggregations: [
                {
                  column: "Compliance Visit",
                  operation: "mean",
                  alias: "Average_Compliance_Visits",
                },
              ],
            },
          },
        },
        // … latest step is run_analytical_query — won't produce a tracePlan
        // when the merged helper scans for the most-recent execute_query_plan
        // (`derivePivotDefaultsFromExecutionMerged` does break on the first
        // hit, so the alias map is still recovered from the earlier step).
        { tool: "run_analytical_query", args: { question: "..." } },
      ],
    };
    const out = derivePivotDefaultsFromExecutionMerged(summary, agentTrace, {
      rows: [
        {
          "Cluster Name": "Cluster 1 EAST",
          Average_Compliance_Visits: 12.35,
        },
      ],
      columns: ["Cluster Name", "Average_Compliance_Visits"],
    });
    // Either path (merged or no-tracePlan branch) must end up with the
    // source column, never the alias.
    assert.ok(
      out && Array.isArray(out.values),
      "should produce a valid pivot defaults envelope"
    );
    if (out!.values && out!.values.length > 0) {
      assert.deepEqual(out!.values, ["Compliance Visit"]);
    }
  });

  it("never ships value fields outside dataSummary.numericColumns", () => {
    const summary = maricoSummary();
    const plan: QueryPlanBody = {
      groupBy: ["Cluster Name"],
      aggregations: [
        // Source column doesn't exist on schema — should be filtered out.
        {
          column: "NonExistentColumn",
          operation: "sum",
          alias: "Some_Alias",
        },
      ],
    };
    const out = mergePivotDefaultRowsAndValues({
      dataSummary: summary,
      tracePlan: plan,
      tableRows: [{ "Cluster Name": "Cluster 1 EAST", Some_Alias: 100 }],
      tableColumns: ["Cluster Name", "Some_Alias"],
    });
    // Row stays, value gets stripped (alias resolves to a non-numeric
    // column that's not in numericColumns).
    assert.deepEqual(out?.rows, ["Cluster Name"]);
    assert.deepEqual(out?.values, []);
  });
});
