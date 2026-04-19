import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mergePivotSliceDefaults,
  pivotSliceDefaultsFromDimensionFilters,
} from "../lib/pivotSliceDefaultsFromDimensionFilters.js";
import type { DataSummary } from "../shared/schema.js";

const summary = {
  rowCount: 1,
  columnCount: 3,
  columns: [
    { name: "Sales", type: "number", sampleValues: [] },
    { name: "Category", type: "string", sampleValues: ["Technology"] },
    { name: "Segment", type: "string", sampleValues: ["Consumer"] },
  ],
  numericColumns: ["Sales"],
  dateColumns: [],
} as DataSummary;

describe("pivotSliceDefaultsFromDimensionFilters", () => {
  it("puts slice-only dimensions in filterFields and all in filterSelections", () => {
    const out = pivotSliceDefaultsFromDimensionFilters(
      summary,
      [{ column: "Category", op: "in", values: ["Technology"] }],
      ["Segment"]
    );
    assert.deepEqual(out.filterFields, ["Category"]);
    assert.deepEqual(out.filterSelections, { Category: ["Technology"] });
  });

  it("does not duplicate row dimension in filterFields but still sets selections", () => {
    const out = pivotSliceDefaultsFromDimensionFilters(
      summary,
      [{ column: "Segment", op: "in", values: ["Consumer"] }],
      ["Segment"]
    );
    assert.deepEqual(out.filterFields, []);
    assert.deepEqual(out.filterSelections, { Segment: ["Consumer"] });
  });

  it("does not duplicate pivot column dimension in filterFields", () => {
    const out = pivotSliceDefaultsFromDimensionFilters(
      summary,
      [{ column: "Category", op: "in", values: ["Technology"] }],
      ["Segment"],
      ["Category"]
    );
    assert.deepEqual(out.filterFields, []);
    assert.deepEqual(out.filterSelections, { Category: ["Technology"] });
  });
});

describe("mergePivotSliceDefaults", () => {
  it("lets execution override parser selections for the same field", () => {
    const merged = mergePivotSliceDefaults(
      {
        filterFields: ["Category"],
        filterSelections: { Category: ["Furniture"] },
      },
      {
        filterFields: ["Category"],
        filterSelections: { Category: ["Technology"] },
      }
    );
    assert.deepEqual(merged.filterSelections.Category, ["Technology"]);
  });
});
