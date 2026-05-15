/**
 * PVT6 · pin the redundant-filter detector inside `mergePivotDefaultRowsAndValues`.
 *
 * Bug: when the agent emits `groupBy=["Cluster Name"]` +
 * `dimensionFilters: [{column:"Cluster Name", op:"in", values:["Cluster 1
 * NORTH"]}]` + no aggregations, PVT5's safety contract passes (rows=1,
 * values=0 ≤ caps) so we ship a pivot with rows=["Cluster Name"], values=[].
 * The rendered pivot is one row with one cell ("Cluster 1 NORTH") and no
 * measure — useless. PVT6 detects this degenerate case (every groupBy is
 * pinned to a single filter value) and returns undefined so the elegant
 * fallback renders instead.
 *
 * Critically the detector must NOT fire on legitimate uses:
 *  - "show me TSOEs where PJP Adherence = No" → filter on a different
 *    column than groupBy. Rows-only pivot with chip stays useful.
 *  - "compare Cluster A and Cluster B" → multi-value filter on the same
 *    column. Rows-only pivot still surfaces the comparison.
 *  - "Cluster Name + ASM groupBy with only one pinned" → not all groupBys
 *    are redundant, pivot stays useful.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergePivotDefaultRowsAndValues } from "../lib/pivotDefaultsFromExecution.js";
import type { DataSummary } from "../shared/schema.js";
import type { QueryPlanBody } from "../lib/queryPlanExecutor.js";

function maricoSummary(): DataSummary {
  return {
    rowCount: 10006,
    columnCount: 6,
    columns: [
      { name: "Cluster Name", type: "string", sampleValues: [] },
      { name: "ASM", type: "string", sampleValues: [] },
      { name: "TSO_TSE Name", type: "string", sampleValues: [] },
      { name: "PJP Adherence", type: "string", sampleValues: [] },
      { name: "Compliance Visit", type: "number", sampleValues: [] },
      { name: "Total PC", type: "number", sampleValues: [] },
    ],
    numericColumns: ["Compliance Visit", "Total PC"],
    dateColumns: [],
  } as DataSummary;
}

describe("PVT6 · redundant-filter detector", () => {
  it("suppresses when groupBy column == single-value filter column", () => {
    const summary = maricoSummary();
    const plan: QueryPlanBody = {
      groupBy: ["Cluster Name"],
      dimensionFilters: [
        {
          column: "Cluster Name",
          op: "in",
          values: ["Cluster 1 NORTH"],
        },
      ],
    };
    const out = mergePivotDefaultRowsAndValues({
      dataSummary: summary,
      tracePlan: plan,
      tableRows: [
        { "Cluster Name": "Cluster 1 NORTH", ASM: "Central UP" },
      ],
      tableColumns: ["Cluster Name", "ASM"],
    });
    assert.equal(
      out,
      undefined,
      "redundant filter-projection must suppress so PVT5 cascade emits pivotUnavailable"
    );
  });

  it("keeps rows-only pivot when filter has multiple values on same column", () => {
    const summary = maricoSummary();
    const plan: QueryPlanBody = {
      groupBy: ["Cluster Name"],
      dimensionFilters: [
        {
          column: "Cluster Name",
          op: "in",
          values: ["Cluster 1 EAST", "Cluster 2 WEST"],
        },
      ],
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

  it("keeps rows-only pivot when filter is on a DIFFERENT column than groupBy (regression: 'show TSOEs where ...' use case)", () => {
    const summary = maricoSummary();
    const plan: QueryPlanBody = {
      groupBy: ["TSO_TSE Name"],
      dimensionFilters: [
        {
          column: "PJP Adherence",
          op: "in",
          values: ["No PJP Available"],
        },
      ],
    };
    const out = mergePivotDefaultRowsAndValues({
      dataSummary: summary,
      tracePlan: plan,
      tableRows: [{ "TSO_TSE Name": "Sarjeet Singh" }],
      tableColumns: ["TSO_TSE Name"],
    });
    assert.deepEqual(out?.rows, ["TSO_TSE Name"]);
    assert.deepEqual(out?.values, []);
    assert.deepEqual(out?.filterFields, ["PJP Adherence"]);
  });

  it("keeps rows-only pivot when only ONE of multiple groupBys is pinned", () => {
    const summary = maricoSummary();
    const plan: QueryPlanBody = {
      groupBy: ["Cluster Name", "ASM"],
      dimensionFilters: [
        {
          column: "Cluster Name",
          op: "in",
          values: ["Cluster 1 NORTH"],
        },
      ],
    };
    const out = mergePivotDefaultRowsAndValues({
      dataSummary: summary,
      tracePlan: plan,
      tableRows: [
        { "Cluster Name": "Cluster 1 NORTH", ASM: "Central UP" },
      ],
      tableColumns: ["Cluster Name", "ASM"],
    });
    // ASM is not pinned, so the rows-only pivot is still useful (lists ASMs
    // within the chosen Cluster). Detector must NOT fire here.
    assert.notEqual(out, undefined);
    assert.ok(out?.rows && out.rows.length > 0);
  });

  it("keeps rows-only pivot when filter-projection has no dimension filter at all", () => {
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

  it("does not fire when aggregations are present (not filter-projection)", () => {
    const summary = maricoSummary();
    const plan: QueryPlanBody = {
      groupBy: ["Cluster Name"],
      aggregations: [{ column: "Compliance Visit", operation: "mean" }],
      dimensionFilters: [
        {
          column: "Cluster Name",
          op: "in",
          values: ["Cluster 1 NORTH"],
        },
      ],
    };
    const out = mergePivotDefaultRowsAndValues({
      dataSummary: summary,
      tracePlan: plan,
      tableRows: [
        { "Cluster Name": "Cluster 1 NORTH", "Compliance Visit_mean": 12.35 },
      ],
      tableColumns: ["Cluster Name", "Compliance Visit_mean"],
    });
    // With an aggregation, the pivot is a real cross-tab even if the filter
    // pins to one value. Don't suppress.
    assert.deepEqual(out?.rows, ["Cluster Name"]);
    assert.deepEqual(out?.values, ["Compliance Visit"]);
  });
});
