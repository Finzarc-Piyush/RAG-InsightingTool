/**
 * Wave PD2 · The in-memory `executeQueryPlan` (legacy `applyQueryTransformations`
 * path) predates PD1 and doesn't understand `perDimension`. Rather than silently
 * computing the wrong number (treating perDimension as a no-op), fail closed
 * with a clear error. Production always uses DuckDB; in-memory is the
 * test/edge fallback.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  executeQueryPlan,
  normalizeAndValidateQueryPlanBody,
} from "../lib/queryPlanExecutor.js";
import type { QueryPlanBody } from "../lib/queryPlanExecutor.js";
import type { DataSummary } from "../shared/schema.js";

function summary(): DataSummary {
  return {
    rowCount: 5,
    columnCount: 3,
    columns: [
      { name: "Compliance Visit", type: "number", sampleValues: [] },
      { name: "Cluster Name", type: "string", sampleValues: [] },
      { name: "Date", type: "date", sampleValues: [] },
    ],
    numericColumns: ["Compliance Visit"],
    dateColumns: ["Date"],
  } as DataSummary;
}

const ROWS: Record<string, unknown>[] = [
  { "Cluster Name": "Cluster 1", Date: "2026-04-01", "Compliance Visit": 10 },
  { "Cluster Name": "Cluster 1", Date: "2026-04-02", "Compliance Visit": 15 },
  { "Cluster Name": "Cluster 2", Date: "2026-04-01", "Compliance Visit": 8 },
];

describe("Wave PD2 · in-memory executeQueryPlan fail-closed on nested plans", () => {
  it("(a) plan with perDimension → executeQueryPlan returns ok:false with clear error", () => {
    const plan: QueryPlanBody = {
      groupBy: ["Cluster Name"],
      aggregations: [
        {
          column: "Compliance Visit",
          operation: "mean",
          perDimension: "Day · Date",
          innerOperation: "sum",
        },
      ],
    };
    const result = executeQueryPlan(ROWS, summary(), plan);
    assert.equal(result.ok, false);
    if (result.ok === false) {
      assert.match(result.error, /perDimension/);
      assert.match(result.error, /DuckDB/);
    }
  });

  it("(b) plan WITHOUT perDimension still executes normally (regression)", () => {
    const plan: QueryPlanBody = {
      groupBy: ["Cluster Name"],
      aggregations: [{ column: "Compliance Visit", operation: "sum" }],
    };
    const result = executeQueryPlan(ROWS, summary(), plan);
    assert.equal(result.ok, true);
    if (result.ok === true) {
      // Cluster 1 sum = 25, Cluster 2 sum = 8
      assert.ok(result.data.length >= 1);
    }
  });

  it("(c) normalizeAndValidateQueryPlanBody also rejects nested plans symmetrically", () => {
    const plan: QueryPlanBody = {
      groupBy: ["Cluster Name"],
      aggregations: [
        {
          column: "Compliance Visit",
          operation: "mean",
          perDimension: "Day · Date",
          innerOperation: "sum",
        },
      ],
    };
    const result = normalizeAndValidateQueryPlanBody(summary(), plan);
    assert.equal(result.ok, false);
    if (result.ok === false) {
      assert.match(result.error, /perDimension/);
    }
  });
});
