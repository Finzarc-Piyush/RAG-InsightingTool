// WPF4 · Unit tests for the defensive re-melt helper used by the dataLoader
// fallback paths (currentDataBlob CSV branch and original blob CSV branch).
//
// The bug being prevented: large wide files (>10k rows) have empty rawData
// and no currentDataBlob. loadLatestData re-parses the original wide buffer
// via parseFile, getting back wide rows. The post-melt dataSummary still has
// numericColumns: ["Value"] from the long form, so when the rows are passed
// to in-memory tools they look like Q1-23-Value-Sales-style schema with the
// wrong numeric-column list — silent corruption.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyWideFormatMeltIfNeeded } from "../lib/wideFormat/applyWideFormatMeltIfNeeded.js";
import type { DataSummary, WideFormatTransform } from "../shared/schema.js";

const transform: WideFormatTransform = {
  detected: true,
  shape: "pure_period",
  idColumns: ["Markets", "Products"],
  meltedColumns: ["Q1 23", "Q2 23", "Q3 23"],
  periodCount: 3,
  periodColumn: "Period",
  periodIsoColumn: "PeriodIso",
  periodKindColumn: "PeriodKind",
  valueColumn: "Value",
  detectedCurrencySymbol: "đ",
};

const longSummary: DataSummary = {
  rowCount: 6,
  columnCount: 6,
  columns: [
    { name: "Markets", type: "string", sampleValues: [] },
    { name: "Products", type: "string", sampleValues: [] },
    { name: "Period", type: "string", sampleValues: [] },
    { name: "PeriodIso", type: "string", sampleValues: [] },
    { name: "PeriodKind", type: "string", sampleValues: [] },
    { name: "Value", type: "number", sampleValues: [] },
  ],
  numericColumns: ["Value"],
  dateColumns: [],
  wideFormatTransform: transform,
};

describe("WPF4 · applyWideFormatMeltIfNeeded", () => {
  it("re-melts wide rows when summary has wideFormatTransform", () => {
    const wideRows = [
      { Markets: "Off VN", Products: "MARICO", "Q1 23": 100, "Q2 23": 200, "Q3 23": 300 },
      { Markets: "Off VN", Products: "OLIV", "Q1 23": 50, "Q2 23": 75, "Q3 23": 100 },
    ];
    const out = applyWideFormatMeltIfNeeded(wideRows, longSummary);
    assert.equal(out.remelted, true);
    assert.equal(out.reason, "remelted");
    // 2 rows × 3 period columns = 6 long rows
    assert.equal(out.rows.length, 6);
    for (const r of out.rows) {
      assert.ok("Period" in r);
      assert.ok("PeriodIso" in r);
      assert.ok("Value" in r);
    }
  });

  it("returns rows unchanged when they already look long-form (no double-melt)", () => {
    const longRows = [
      { Markets: "Off VN", Products: "MARICO", Period: "Q1 23", PeriodIso: "2023-Q1", PeriodKind: "quarter", Value: 100 },
      { Markets: "Off VN", Products: "MARICO", Period: "Q2 23", PeriodIso: "2023-Q2", PeriodKind: "quarter", Value: 200 },
    ];
    const out = applyWideFormatMeltIfNeeded(longRows, longSummary);
    assert.equal(out.remelted, false);
    assert.equal(out.reason, "already_long_form");
    assert.equal(out.rows.length, 2);
    assert.equal(out.rows[0], longRows[0]);
  });

  it("returns rows unchanged when summary has no wideFormatTransform", () => {
    const noWfSummary: DataSummary = {
      ...longSummary,
      wideFormatTransform: undefined,
    };
    const rows = [{ a: 1 }, { a: 2 }];
    const out = applyWideFormatMeltIfNeeded(rows, noWfSummary);
    assert.equal(out.remelted, false);
    assert.equal(out.reason, "no_wide_format_transform");
    assert.equal(out.rows, rows);
  });

  it("returns empty input untouched", () => {
    const out = applyWideFormatMeltIfNeeded([], longSummary);
    assert.equal(out.remelted, false);
    assert.equal(out.reason, "rows_empty");
  });

  it("does not melt when classification disagrees (e.g. partial column load)", () => {
    // Suppose only the Markets column was loaded by a column-filtered fetch.
    const partial = [{ Markets: "Off VN" }, { Markets: "Off SG" }];
    const out = applyWideFormatMeltIfNeeded(partial, longSummary);
    assert.equal(out.remelted, false);
    assert.equal(out.reason, "classify_disagrees");
    assert.equal(out.rows, partial);
  });
});
