import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  filterPivotValueFieldsToBaseTable,
  derivePivotDefaultsFromPreviewRows,
} from "../lib/pivotDefaultsFromPreview.js";
import type { DataSummary } from "../shared/schema.js";

const summary: DataSummary = {
  rowCount: 10000,
  columnCount: 4,
  columns: [
    { name: "Cluster Name", type: "string", sampleValues: ["Cluster 1 NORTH"] },
    { name: "MTD", type: "string", sampleValues: ["Apr 2026"] },
    { name: "Sales", type: "number", sampleValues: [100] },
    { name: "Working Hrs", type: "number", sampleValues: [8] },
  ],
  numericColumns: ["Sales", "Working Hrs"],
  dateColumns: [],
};

describe("filterPivotValueFieldsToBaseTable", () => {
  it("drops computed-rate aliases and countIf helpers not on the base table", () => {
    // The exact shape behind the screenshot's binder error.
    const out = filterPivotValueFieldsToBaseTable(
      ["matching", "total", "pjp_adherence_rate", "Sales"],
      summary,
    );
    assert.deepEqual(out, ["Sales"]);
  });

  it("resolves _sum / _avg aliases back to their base column", () => {
    const out = filterPivotValueFieldsToBaseTable(
      ["Sales_sum", "Working Hrs_avg"],
      summary,
    );
    assert.deepEqual(out, ["Sales", "Working Hrs"]);
  });

  it("de-dupes fields that normalise to the same base column", () => {
    const out = filterPivotValueFieldsToBaseTable(["Sales_sum", "Sales"], summary);
    assert.deepEqual(out, ["Sales"]);
  });

  it("drops the __matching / __total double-underscore helper convention", () => {
    const out = filterPivotValueFieldsToBaseTable(
      ["revenue__matching", "revenue__total", "Sales"],
      summary,
    );
    assert.deepEqual(out, ["Sales"]);
  });

  it("returns [] for empty input", () => {
    assert.deepEqual(filterPivotValueFieldsToBaseTable([], summary), []);
  });

  it("returns [] when no value field maps to a base column", () => {
    assert.deepEqual(
      filterPivotValueFieldsToBaseTable(["matching", "total", "pjp_adherence_rate"], summary),
      [],
    );
  });
});

describe("derivePivotDefaultsFromPreviewRows · base-table value guard", () => {
  it("excludes computed aliases from pivot values (the binder-error fix)", () => {
    const rows = [
      { MTD: "Apr 2026", matching: 2100, total: 10000, pjp_adherence_rate: 0.21 },
    ];
    const out = derivePivotDefaultsFromPreviewRows(rows, summary);
    assert.ok(out, "expected defaults to be produced");
    assert.deepEqual(out!.values, []);
  });

  it("keeps a real base column while dropping aliases alongside it", () => {
    const rows = [
      {
        "Cluster Name": "Cluster 1 NORTH",
        Sales_sum: 1234,
        matching: 5,
        pjp_adherence_rate: 0.25,
      },
    ];
    const out = derivePivotDefaultsFromPreviewRows(rows, summary);
    assert.ok(out, "expected defaults to be produced");
    assert.deepEqual(out!.values, ["Sales"]);
  });
});
