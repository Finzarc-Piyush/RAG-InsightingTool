import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { derivePivotDefaultsFromPreviewRows } from "../lib/pivotDefaultsFromPreview.js";
import { facetColumnKey } from "../lib/temporalFacetColumns.js";
import type { DataSummary } from "../shared/schema.js";

function minimalSummary(over: Partial<DataSummary> = {}): DataSummary {
  return {
    columns: [],
    numericColumns: ["Sales"],
    dateColumns: ["Order Date"],
    ...over,
  } as DataSummary;
}

describe("derivePivotDefaultsFromPreviewRows", () => {
  it("facet row and Sales_sum in preview map to base Sales for DuckDB pivot", () => {
    const monthCol = facetColumnKey("Order Date", "month");
    const rows = [
      { [monthCol]: "2015-01", Sales_sum: 14206 },
      { [monthCol]: "2015-02", Sales_sum: 4520 },
    ];
    const summary = minimalSummary();
    const out = derivePivotDefaultsFromPreviewRows(rows, summary, [
      monthCol,
      "Sales_sum",
    ]);
    assert.deepEqual(out?.rows, [monthCol]);
    assert.deepEqual(out?.values, ["Sales"]);
  });

  it("maps aggregate alias Total_Revenue to schema Sales for pivot values", () => {
    const rows = [{ "Ship Mode": "Standard Class", Total_Revenue: 125_000 }];
    const summary = minimalSummary({
      columns: [
        { name: "Ship Mode", type: "string", sampleValues: [] },
        { name: "Sales", type: "number", sampleValues: [] },
      ] as DataSummary["columns"],
    });
    const out = derivePivotDefaultsFromPreviewRows(rows, summary, [
      "Ship Mode",
      "Total_Revenue",
    ]);
    assert.deepEqual(out?.rows, ["Ship Mode"]);
    assert.deepEqual(out?.values, ["Sales"]);
  });

  it("schema numeric base column as value when present in preview", () => {
    const rows = [{ Region: "East", Sales: 100 }];
    const summary = minimalSummary();
    const out = derivePivotDefaultsFromPreviewRows(rows, summary, ["Region", "Sales"]);
    assert.deepEqual(out?.rows, ["Region"]);
    assert.deepEqual(out?.values, ["Sales"]);
  });

  it("returns undefined for empty rows", () => {
    assert.equal(derivePivotDefaultsFromPreviewRows([], minimalSummary(), null), undefined);
  });

  it("includes every non-measure column as row keys (three dimensions)", () => {
    const rows = [
      {
        Region: "West",
        Category: "Technology",
        Segment: "Consumer",
        Sales_sum: 100,
      },
    ];
    const summary = minimalSummary({
      columns: [
        { name: "Region", type: "string", sampleValues: [] },
        { name: "Category", type: "string", sampleValues: [] },
        { name: "Segment", type: "string", sampleValues: [] },
        { name: "Sales", type: "number", sampleValues: [] },
      ] as DataSummary["columns"],
    });
    const out = derivePivotDefaultsFromPreviewRows(rows, summary, [
      "Region",
      "Category",
      "Segment",
      "Sales_sum",
    ]);
    assert.deepEqual(out?.rows, ["Region", "Category", "Segment"]);
    assert.deepEqual(out?.values, ["Sales"]);
  });
});
