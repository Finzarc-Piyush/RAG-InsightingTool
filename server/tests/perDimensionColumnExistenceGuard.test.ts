/**
 * Wave PD2 · `buildQueryPlanDuckdbSql` returns null upfront when a nested
 * plan's perDimension column doesn't resolve to anything DuckDB can find
 * (not in tableColumns, no inline TRY_CAST available, no legacy mapping).
 * Closes the failure mode where PD1 emitted SQL referencing "Day · Date"
 * but the temporal facet wasn't materialized → DuckDB threw at execute
 * time → step failed silently → narrator fell back to "I couldn't complete
 * this analysis".
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildQueryPlanDuckdbSql } from "../lib/queryPlanDuckdbExecutor.js";
import type { QueryPlanBody } from "../lib/queryPlanExecutor.js";
import type { DataSummary } from "../shared/schema.js";

function summary(): DataSummary {
  return {
    rowCount: 1000,
    columnCount: 4,
    columns: [
      { name: "Compliance Visit", type: "number", sampleValues: [] },
      { name: "Cluster Name", type: "string", sampleValues: [] },
      { name: "Date", type: "date", sampleValues: [] },
    ],
    numericColumns: ["Compliance Visit"],
    dateColumns: ["Date"],
  } as DataSummary;
}

describe("Wave PD2 · column-existence guard in nested SQL builder", () => {
  it("(a) perDimension materialized in tableColumns → SQL builds, references materialized column", () => {
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
    const tableColumns = new Set([
      "Cluster Name",
      "Date",
      "Compliance Visit",
      "Day · Date", // materialized facet column EXISTS
    ]);
    const built = buildQueryPlanDuckdbSql(plan, {
      tableColumns,
      summary: summary(),
    });
    assert.ok(built, "plan should build");
    // Inner subquery references the materialized facet column directly
    assert.match(built!.aggregateSql, /"Day · Date" AS "__pd_bucket__"/);
  });

  it("(b) perDimension missing but source date column present → inline TRY_CAST fallback", () => {
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
    // "Day · Date" NOT materialized but "Date" IS → facetColumnInlineDuckDbExpr
    // returns a TRY_CAST inline expression.
    const tableColumns = new Set(["Cluster Name", "Date", "Compliance Visit"]);
    const built = buildQueryPlanDuckdbSql(plan, {
      tableColumns,
      summary: summary(),
    });
    assert.ok(built, "plan should build via inline expression");
    // Inner subquery uses an inline expression (TRY_CAST or similar), not
    // a bare "Day · Date" reference.
    assert.doesNotMatch(built!.aggregateSql, /"Day · Date" AS "__pd_bucket__"/);
    assert.match(built!.aggregateSql, /AS "__pd_bucket__"/);
  });

  it("(c) perDimension AND source missing → returns null cleanly (no SQL leak)", () => {
    const plan: QueryPlanBody = {
      groupBy: ["Cluster Name"],
      aggregations: [
        {
          column: "Compliance Visit",
          operation: "mean",
          perDimension: "Day · NonexistentDate",
          innerOperation: "sum",
        },
      ],
    };
    // Neither "Day · NonexistentDate" nor "NonexistentDate" in tableColumns.
    const tableColumns = new Set(["Cluster Name", "Compliance Visit"]);
    const summaryNoNonexistent: DataSummary = {
      ...summary(),
      dateColumns: [],
    };
    const built = buildQueryPlanDuckdbSql(plan, {
      tableColumns,
      summary: summaryNoNonexistent,
    });
    assert.equal(
      built,
      null,
      "must return null when perDimension cannot resolve to any table column"
    );
  });

  it("(d) non-temporal perDimension missing from tableColumns → returns null", () => {
    const plan: QueryPlanBody = {
      groupBy: ["Cluster Name"],
      aggregations: [
        {
          column: "Compliance Visit",
          operation: "sum",
          perDimension: "Customer", // doesn't exist
          innerOperation: "sum",
        },
      ],
    };
    const tableColumns = new Set(["Cluster Name", "Compliance Visit"]);
    const built = buildQueryPlanDuckdbSql(plan, {
      tableColumns,
      summary: summary(),
    });
    assert.equal(built, null);
  });

  it("(e) regression — no-ctx path still works (test/synthetic SQL generation)", () => {
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
    // No ctx — pre-PD2 behavior of assume-the-column-exists for synthetic
    // SQL generation in unit tests. PD1's perDimensionDuckdbSql.test.ts
    // pin this contract.
    const built = buildQueryPlanDuckdbSql(plan);
    assert.ok(built, "no-ctx path must still produce SQL (PD1 test invariant)");
    assert.match(built!.aggregateSql, /"Day · TSOE-Date Combo" AS "__pd_bucket__"/);
  });
});
