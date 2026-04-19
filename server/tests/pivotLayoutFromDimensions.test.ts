import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  sanitisePivotColumnDimensionsInput,
  suggestPivotColumnsFromDimensions,
} from "../lib/pivotLayoutFromDimensions.js";
import { facetColumnKey } from "../lib/temporalFacetColumns.js";
import type { DataSummary } from "../shared/schema.js";

function minimalSummary(over: Partial<DataSummary> = {}): DataSummary {
  return {
    rowCount: 1,
    columnCount: 3,
    columns: [
      { name: "Sales", type: "number", sampleValues: [] },
      { name: "Category", type: "string", sampleValues: [] },
      { name: "Order Date", type: "date", sampleValues: [] },
    ],
    numericColumns: ["Sales"],
    dateColumns: ["Order Date"],
    ...over,
  } as DataSummary;
}

describe("suggestPivotColumnsFromDimensions", () => {
  it("heuristic: first categorical to columns when temporal present in order", () => {
    const summary = minimalSummary();
    const monthCol = facetColumnKey("Order Date", "month");
    const laid = suggestPivotColumnsFromDimensions({
      rowCandidates: [monthCol, "Category"],
      dataSummary: summary,
      pivotColumnDimensions: undefined,
    });
    assert.deepEqual(laid.rows, [monthCol]);
    assert.deepEqual(laid.columns, ["Category"]);
  });

  it("parser override moves named dimension to columns when still rows left", () => {
    const summary = minimalSummary();
    const monthCol = facetColumnKey("Order Date", "month");
    const laid = suggestPivotColumnsFromDimensions({
      rowCandidates: [monthCol, "Category"],
      dataSummary: summary,
      pivotColumnDimensions: ["Category"],
    });
    assert.deepEqual(laid.rows, [monthCol]);
    assert.deepEqual(laid.columns, ["Category"]);
  });

  it("does not split when only categorical dimensions", () => {
    const summary = minimalSummary();
    const laid = suggestPivotColumnsFromDimensions({
      rowCandidates: ["Region", "Category"],
      dataSummary: summary,
      pivotColumnDimensions: undefined,
    });
    assert.deepEqual(laid.rows, ["Region", "Category"]);
    assert.deepEqual(laid.columns, []);
  });

  it("drops parser hint that would empty rows", () => {
    const summary = minimalSummary();
    const laid = suggestPivotColumnsFromDimensions({
      rowCandidates: ["Category"],
      dataSummary: summary,
      pivotColumnDimensions: ["Category"],
    });
    assert.deepEqual(laid.rows, ["Category"]);
    assert.deepEqual(laid.columns, []);
  });
});

describe("sanitisePivotColumnDimensionsInput", () => {
  it("returns at most one allowed non-numeric column", () => {
    const summary = minimalSummary();
    assert.deepEqual(
      sanitisePivotColumnDimensionsInput(["Category", "Order Date"], summary),
      ["Category"]
    );
    assert.deepEqual(sanitisePivotColumnDimensionsInput(["Sales"], summary), []);
  });
});
