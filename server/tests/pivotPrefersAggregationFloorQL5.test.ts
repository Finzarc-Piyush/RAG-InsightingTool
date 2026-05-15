/**
 * Wave QL5 · Pivot derivation prefers QL2-floor-synthesized
 * `execute_query_plan` steps over LLM-emitted exploration steps.
 *
 * Before QL5: `derivePivotDefaultsFromExecutionMerged` walked steps backwards
 * and the LLM's last-emitted (often date-grouped trend) step won. The user
 * saw a date-row table even though Wave QL2's deterministic floor had
 * synthesized the right cluster-grouped step. The Marico-VN screenshot
 * captures this exact failure mode — `Day · Date` in ROWS, SUM(Compliance
 * Visit) in VALUES, no Cluster Name anywhere.
 *
 * After QL5: a first-pass forward iteration prefers any step whose id
 * starts with `ql2_synth_`. Non-floor scenarios are unchanged (second
 * pass keeps the original last-step-wins semantics).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { derivePivotDefaultsFromExecutionMerged } from "../lib/pivotDefaultsFromExecution.js";
import type { DataSummary } from "../shared/schema.js";

function maricoSummary(): DataSummary {
  return {
    rowCount: 10006,
    columnCount: 4,
    columns: [
      { name: "Cluster Name", type: "string", sampleValues: [] },
      { name: "Date", type: "date", sampleValues: [] },
      { name: "Day · Date", type: "string", sampleValues: [] },
      { name: "Compliance Visit", type: "number", sampleValues: [] },
    ],
    numericColumns: ["Compliance Visit"],
    dateColumns: ["Date"],
  };
}

describe("Wave QL5 · derivePivotDefaultsFromExecutionMerged prefers QL2 floor steps", () => {
  it("picks the floor-synthesized cluster-grouped step over the LLM's date-grouped trend step", () => {
    const summary = maricoSummary();
    const agentTrace = {
      steps: [
        // QL2 floor (prepended): cluster-grouped average per day per cluster.
        {
          id: "ql2_synth_abc123",
          tool: "execute_query_plan",
          args: {
            plan: {
              groupBy: ["Cluster Name"],
              aggregations: [
                {
                  column: "Compliance Visit",
                  operation: "mean",
                  perDimension: "Day · Date",
                  innerOperation: "sum",
                  alias: "mean_compliance_visit",
                },
              ],
            },
          },
        },
        // LLM-emitted exploration: trend over time (date-grouped). This used
        // to win because it was last in the trace.
        {
          id: "llm_s1",
          tool: "execute_query_plan",
          args: {
            plan: {
              groupBy: ["Date"],
              aggregations: [
                { column: "Compliance Visit", operation: "sum", alias: "total_visits" },
              ],
            },
          },
        },
      ],
    };
    const table = {
      columns: ["Cluster Name", "mean_compliance_visit"],
      rows: [
        { "Cluster Name": "Cluster 1 EAST", mean_compliance_visit: 4.2 },
        { "Cluster Name": "Bengal North", mean_compliance_visit: 3.8 },
      ],
    };
    const defaults = derivePivotDefaultsFromExecutionMerged(
      summary,
      agentTrace,
      table
    );
    assert.ok(defaults, "should produce pivot defaults");
    assert.deepEqual(defaults!.rows, ["Cluster Name"]);
    assert.ok(defaults!.values?.length, "values should include the metric");
  });

  it("falls back to last-step-wins when no QL2-floor step exists", () => {
    const summary = maricoSummary();
    const agentTrace = {
      steps: [
        {
          id: "llm_s1",
          tool: "execute_query_plan",
          args: {
            plan: {
              groupBy: ["Cluster Name"],
              aggregations: [
                { column: "Compliance Visit", operation: "sum", alias: "total_first" },
              ],
            },
          },
        },
        {
          id: "llm_s2",
          tool: "execute_query_plan",
          args: {
            plan: {
              groupBy: ["Date"],
              aggregations: [
                { column: "Compliance Visit", operation: "sum", alias: "total_last" },
              ],
            },
          },
        },
      ],
    };
    const table = {
      columns: ["Date", "total_last"],
      rows: [{ Date: "2026-04-01", total_last: 5871 }],
    };
    const defaults = derivePivotDefaultsFromExecutionMerged(
      summary,
      agentTrace,
      table
    );
    // Pre-QL5 behaviour: the second (last) step's plan drives the rows.
    assert.ok(defaults);
    assert.deepEqual(defaults!.rows, ["Date"]);
  });

  it("falls back to last-step-wins when QL2 step has empty hints (no traceRows / traceValues / filters)", () => {
    const summary = maricoSummary();
    const agentTrace = {
      steps: [
        // QL2 synthesized step that produced an unusable plan (e.g. metric
        // column missing from schema after WPF strip). traceRows/traceValues
        // would be empty so the floor preference falls through.
        {
          id: "ql2_synth_empty",
          tool: "execute_query_plan",
          args: {
            plan: { aggregations: [] },
          },
        },
        {
          id: "llm_s1",
          tool: "execute_query_plan",
          args: {
            plan: {
              groupBy: ["Cluster Name"],
              aggregations: [
                { column: "Compliance Visit", operation: "sum", alias: "total_visits" },
              ],
            },
          },
        },
      ],
    };
    const table = {
      columns: ["Cluster Name", "total_visits"],
      rows: [{ "Cluster Name": "Cluster 1 EAST", total_visits: 1200 }],
    };
    const defaults = derivePivotDefaultsFromExecutionMerged(
      summary,
      agentTrace,
      table
    );
    assert.ok(defaults);
    assert.deepEqual(defaults!.rows, ["Cluster Name"]);
  });
});
