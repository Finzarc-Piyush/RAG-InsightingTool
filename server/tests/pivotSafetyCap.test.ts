/**
 * PVT5 · pin the unified pivot-defaults safety contract.
 *
 * User invariant: "if a pivot is being generated, under no circumstance
 * should all fields get used". The contract caps at:
 *   - rows + columns ≤ 4 axis fields
 *   - values ≤ 4 measure fields
 *
 * When the cap is exceeded, derivation MUST return undefined so the chat
 * surface can emit `pivotUnavailable: true` and the client renders the
 * elegant fallback explaining the answer is correct but the pivot couldn't
 * be auto-generated.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  derivePivotDefaultsFromExecutionMerged,
  isPivotDefaultsShapeSafe,
  mergePivotDefaultRowsAndValues,
  PIVOT_DEFAULTS_MAX_AXIS_FIELDS,
  PIVOT_DEFAULTS_MAX_VALUE_FIELDS,
} from "../lib/pivotDefaultsFromExecution.js";
import type { DataSummary } from "../shared/schema.js";
import type { QueryPlanBody } from "../lib/queryPlanExecutor.js";

function maricoSummary(): DataSummary {
  return {
    rowCount: 10006,
    columnCount: 12,
    columns: [
      { name: "Date", type: "date", sampleValues: [] },
      { name: "Cluster Name", type: "string", sampleValues: [] },
      { name: "ASM", type: "string", sampleValues: [] },
      { name: "TSO_TSE Name", type: "string", sampleValues: [] },
      { name: "HQ Name", type: "string", sampleValues: [] },
      { name: "Android./iOS", type: "string", sampleValues: [] },
      { name: "TSOE Availability", type: "string", sampleValues: [] },
      { name: "Day", type: "number", sampleValues: [] },
      { name: "TSO_TSE Code", type: "number", sampleValues: [] },
      { name: "Compliance Visit", type: "number", sampleValues: [] },
      { name: "Total PC", type: "number", sampleValues: [] },
      { name: "Total Visited OL's", type: "number", sampleValues: [] },
    ],
    numericColumns: [
      "Day",
      "TSO_TSE Code",
      "Compliance Visit",
      "Total PC",
      "Total Visited OL's",
    ],
    dateColumns: ["Date"],
  } as DataSummary;
}

describe("PVT5 · pivot-defaults safety contract", () => {
  describe("isPivotDefaultsShapeSafe", () => {
    it("accepts shapes within both caps", () => {
      assert.equal(
        isPivotDefaultsShapeSafe({ rows: ["a"], values: ["b"] }),
        true
      );
      assert.equal(
        isPivotDefaultsShapeSafe({
          rows: ["a", "b"],
          columns: ["c"],
          values: ["x", "y"],
        }),
        true
      );
    });

    it("rejects axis-stuffing (rows + columns > MAX)", () => {
      const tooMany = Array.from(
        { length: PIVOT_DEFAULTS_MAX_AXIS_FIELDS + 1 },
        (_, i) => `dim${i}`
      );
      assert.equal(
        isPivotDefaultsShapeSafe({ rows: tooMany, values: ["x"] }),
        false
      );
    });

    it("rejects measure-stuffing (values > MAX)", () => {
      const tooMany = Array.from(
        { length: PIVOT_DEFAULTS_MAX_VALUE_FIELDS + 1 },
        (_, i) => `m${i}`
      );
      assert.equal(
        isPivotDefaultsShapeSafe({ rows: ["a"], values: tooMany }),
        false
      );
    });

    it("rejects null/undefined", () => {
      assert.equal(isPivotDefaultsShapeSafe(null), false);
      assert.equal(isPivotDefaultsShapeSafe(undefined), false);
    });
  });

  describe("mergePivotDefaultRowsAndValues", () => {
    it("suppresses when fromPreview blew the rows budget (every dim → ROWS)", () => {
      const summary = maricoSummary();
      const plan: QueryPlanBody = {
        // groupBy that won't match the result columns → traceRowsMatchOutput
        // is false → rowOut falls back to fromPreview.rows (every non-numeric
        // column in the preview).
        groupBy: ["nonexistent_col"],
        aggregations: [{ column: "Compliance Visit", operation: "mean" }],
      };
      const out = mergePivotDefaultRowsAndValues({
        dataSummary: summary,
        tracePlan: plan,
        // Result table has 6 dimension columns — exceeds the 4-field axis cap.
        tableRows: [
          {
            "Cluster Name": "X",
            ASM: "X",
            "TSO_TSE Name": "X",
            "HQ Name": "X",
            "Android./iOS": "X",
            "TSOE Availability": "X",
            "Compliance Visit": 1,
          },
        ],
        tableColumns: [
          "Cluster Name",
          "ASM",
          "TSO_TSE Name",
          "HQ Name",
          "Android./iOS",
          "TSOE Availability",
          "Compliance Visit",
        ],
      });
      assert.equal(
        out,
        undefined,
        "explosion case must suppress so caller can emit pivotUnavailable"
      );
    });

    it("ships normal-shape pivots untouched (1 row, 1 value)", () => {
      const summary = maricoSummary();
      const plan: QueryPlanBody = {
        groupBy: ["Cluster Name"],
        aggregations: [{ column: "Compliance Visit", operation: "mean" }],
      };
      const out = mergePivotDefaultRowsAndValues({
        dataSummary: summary,
        tracePlan: plan,
        tableRows: [
          {
            "Cluster Name": "Cluster 1 EAST",
            "Compliance Visit_mean": 12.35,
          },
        ],
        tableColumns: ["Cluster Name", "Compliance Visit_mean"],
      });
      assert.deepEqual(out?.rows, ["Cluster Name"]);
      assert.deepEqual(out?.values, ["Compliance Visit"]);
    });

    it("ships filter-projection pivots untouched (rows-only)", () => {
      const summary = maricoSummary();
      const plan: QueryPlanBody = {
        groupBy: ["Cluster Name"],
      };
      const out = mergePivotDefaultRowsAndValues({
        dataSummary: summary,
        tracePlan: plan,
        tableRows: [{ "Cluster Name": "Cluster 1 EAST" }],
        tableColumns: ["Cluster Name"],
      });
      assert.deepEqual(out?.rows, ["Cluster Name"]);
      assert.deepEqual(out?.values, []);
    });
  });

  describe("derivePivotDefaultsFromExecutionMerged no-tracePlan path", () => {
    it("suppresses when run_analytical_query result has > 4 dimensions", () => {
      const summary = maricoSummary();
      const agentTrace = {
        steps: [
          // No execute_query_plan step — the merged helper falls into the
          // no-tracePlan branch which uses derivePivotDefaultsFromPreviewRows
          // directly. Without the safety cap, every non-numeric column would
          // end up in ROWS.
          { tool: "run_analytical_query", args: { question: "..." } },
        ],
      };
      const out = derivePivotDefaultsFromExecutionMerged(summary, agentTrace, {
        rows: [
          {
            "Cluster Name": "X",
            ASM: "X",
            "TSO_TSE Name": "X",
            "HQ Name": "X",
            "Android./iOS": "X",
            "TSOE Availability": "X",
            "Compliance Visit": 1,
          },
        ],
        columns: [
          "Cluster Name",
          "ASM",
          "TSO_TSE Name",
          "HQ Name",
          "Android./iOS",
          "TSOE Availability",
          "Compliance Visit",
        ],
      });
      assert.equal(out, undefined);
    });

    it("ships normal-shape pivot from no-tracePlan path", () => {
      const summary = maricoSummary();
      const agentTrace = {
        steps: [{ tool: "run_analytical_query", args: { question: "..." } }],
      };
      const out = derivePivotDefaultsFromExecutionMerged(summary, agentTrace, {
        rows: [{ "Cluster Name": "Cluster 1 EAST", "Compliance Visit": 12 }],
        columns: ["Cluster Name", "Compliance Visit"],
      });
      assert.deepEqual(out?.rows, ["Cluster Name"]);
      assert.deepEqual(out?.values, ["Compliance Visit"]);
    });
  });
});
