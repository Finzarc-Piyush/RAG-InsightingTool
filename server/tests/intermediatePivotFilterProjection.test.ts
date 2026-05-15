/**
 * Wave PVT1 — pin the filter-projection contract for intermediate-card pivot
 * defaults. Bug pre-fix: an `execute_query_plan` with `groupBy=["TSO_TSE Name"]`
 * and a `dimensionFilter` on PJP Adherence but no `aggregations` returned the
 * full filtered row-level slice (396 rows × 44 cols). The intermediate code
 * fed that slice to the dataset-preview categorizer, which dumped every
 * dimension into ROWS and every numeric into VALUES. Fix: route through
 * `mergePivotDefaultRowsAndValues` and treat empty `traceValues` + non-empty
 * `groupBy` + no aggregations as filter-projection (rows from groupBy, no
 * values, dimension filter as a chip).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergePivotDefaultRowsAndValues } from "../lib/pivotDefaultsFromExecution.js";
import type { DataSummary } from "../shared/schema.js";
import type { QueryPlanBody } from "../lib/queryPlanExecutor.js";

function maricoSummary(): DataSummary {
  return {
    rowCount: 10006,
    columnCount: 44,
    columns: [
      { name: "Date", type: "date", sampleValues: [] },
      { name: "Day", type: "number", sampleValues: [] },
      { name: "TSOE-Date Combo", type: "date", sampleValues: [] },
      { name: "Cluster Name", type: "string", sampleValues: [] },
      { name: "ASM", type: "string", sampleValues: [] },
      { name: "TSO_TSE Code", type: "number", sampleValues: [] },
      { name: "TSO_TSE Name", type: "string", sampleValues: [] },
      { name: "HQ Name", type: "string", sampleValues: [] },
      { name: "Auto- Day", type: "number", sampleValues: [] },
      { name: "Compliance Visit", type: "number", sampleValues: [] },
      { name: "Non-Compliance Visit", type: "number", sampleValues: [] },
      { name: "Total Visited OL's", type: "number", sampleValues: [] },
      { name: "Total PC", type: "number", sampleValues: [] },
      { name: "PJP Adherence", type: "string", sampleValues: [] },
    ],
    numericColumns: [
      "Day",
      "TSO_TSE Code",
      "Auto- Day",
      "Compliance Visit",
      "Non-Compliance Visit",
      "Total Visited OL's",
      "Total PC",
    ],
    dateColumns: ["Date", "TSOE-Date Combo"],
  } as DataSummary;
}

describe("PVT1 · intermediate filter-projection pivot defaults", () => {
  it("groupBy without aggregations yields rows-only with filter chip — never dumps numerics into VALUES", () => {
    const summary = maricoSummary();
    const plan: QueryPlanBody = {
      groupBy: ["TSO_TSE Name"],
      dimensionFilters: [
        {
          column: "PJP Adherence",
          op: "in",
          values: ["No PJP Available"],
          match: "case_insensitive",
        },
      ],
    };
    // Executor returned the full filtered slice — all 14 columns from the
    // schema plus a numeric column. Pre-fix: every numeric ended up in VALUES.
    const tableRows = [
      {
        Date: "2026-04-01",
        Day: 1,
        "TSOE-Date Combo": "20176-1",
        "Cluster Name": "Cluster 1 EAST",
        ASM: "Bengal Central",
        "TSO_TSE Code": 20176,
        "TSO_TSE Name": "Sarjeet Singh",
        "HQ Name": "Asansol",
        "Auto- Day": 0,
        "Compliance Visit": 0,
        "Non-Compliance Visit": 0,
        "Total Visited OL's": 0,
        "Total PC": 0,
        "PJP Adherence": "No PJP Available",
      },
    ];
    const tableColumns = Object.keys(tableRows[0]!);

    const out = mergePivotDefaultRowsAndValues({
      dataSummary: summary,
      tracePlan: plan,
      tableRows,
      tableColumns,
    });

    assert.ok(out, "filter-projection should yield a populated pivot defaults object");
    assert.deepEqual(out!.rows, ["TSO_TSE Name"], "rows must come from trace groupBy, not preview categorization");
    assert.deepEqual(out!.values, [], "filter-projection must NOT fall back to fromPreview.values");
    assert.deepEqual(out!.columns ?? [], [], "no column split for a single-row dimension");
    assert.deepEqual(
      out!.filterFields ?? [],
      ["PJP Adherence"],
      "dimension filter must surface in the FILTERS shelf"
    );
    assert.deepEqual(
      out!.filterSelections ?? {},
      { "PJP Adherence": ["No PJP Available"] },
      "filter selection must reflect the dimension filter values"
    );
  });

  it("groupBy WITH aggregations still produces rows + values (regression)", () => {
    const summary = maricoSummary();
    const plan: QueryPlanBody = {
      groupBy: ["Cluster Name"],
      aggregations: [{ column: "Total Visited OL's", operation: "sum" }],
    };
    const out = mergePivotDefaultRowsAndValues({
      dataSummary: summary,
      tracePlan: plan,
      tableRows: [
        {
          "Cluster Name": "Cluster 1 EAST",
          "Total Visited OL's_sum": 1234,
        },
      ],
      tableColumns: ["Cluster Name", "Total Visited OL's_sum"],
    });
    assert.deepEqual(out?.rows, ["Cluster Name"]);
    assert.deepEqual(out?.values, ["Total Visited OL's"]);
  });

  it("filter-projection with no dimension filter still yields rows-only (no fabricated values)", () => {
    const summary = maricoSummary();
    const plan: QueryPlanBody = {
      groupBy: ["TSO_TSE Name"],
    };
    const out = mergePivotDefaultRowsAndValues({
      dataSummary: summary,
      tracePlan: plan,
      tableRows: [
        {
          "TSO_TSE Name": "Sarjeet Singh",
          "Compliance Visit": 0,
          "Total PC": 0,
        },
      ],
      tableColumns: ["TSO_TSE Name", "Compliance Visit", "Total PC"],
    });
    assert.deepEqual(out?.rows, ["TSO_TSE Name"]);
    assert.deepEqual(out?.values, []);
    assert.equal(out?.filterFields, undefined);
  });

  it("plan with no groupBy AND no aggregations short-circuits via the empty-output guard", () => {
    const summary = maricoSummary();
    const plan: QueryPlanBody = {};
    const out = mergePivotDefaultRowsAndValues({
      dataSummary: summary,
      tracePlan: plan,
      tableRows: [],
      tableColumns: [],
    });
    // Empty rows AND empty values → undefined per the existing guard at line
    // 166. Filter-projection branch only triggers when traceRows.length > 0.
    assert.equal(out, undefined);
  });
});
