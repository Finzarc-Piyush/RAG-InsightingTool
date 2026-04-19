import test from "node:test";
import assert from "node:assert/strict";
import { classifyAnalysisSpec } from "../lib/analysisSpecRouter.js";
import { mergeIntermediateSegmentPivotDefaults } from "../lib/diagnosticIntermediatePivot.js";
import { filterRowsByDimensionFilters } from "../lib/dataTransform.js";
import type { DataSummary } from "../shared/schema.js";

const miniSummary: DataSummary = {
  rowCount: 100,
  columnCount: 4,
  columns: [
    { name: "Region", type: "string", sampleValues: ["East", "West", "Central"] },
    { name: "Category", type: "string", sampleValues: ["Technology", "Furniture"] },
    { name: "Sales", type: "number", sampleValues: [1, 2] },
    { name: "Order ID", type: "string", sampleValues: ["1"] },
  ],
  numericColumns: ["Sales"],
  dateColumns: [],
};

test("classifyAnalysisSpec marks driver phrasing as diagnostic", () => {
  const spec = classifyAnalysisSpec(
    "Investigating factors driving Technology's success in the East.",
    miniSummary
  );
  assert.equal(spec.mode, "diagnostic");
  assert.ok(spec.outcomeColumn);
});

test("classifyAnalysisSpec leaves generic trend as descriptive", () => {
  const spec = classifyAnalysisSpec("Show sales by region over time", miniSummary);
  assert.equal(spec.mode, "descriptive");
});

test("filterRowsByDimensionFilters ANDs multiple filters", () => {
  const rows = [
    { Region: "East", Category: "Technology", Sales: 10 },
    { Region: "West", Category: "Technology", Sales: 20 },
    { Region: "East", Category: "Furniture", Sales: 5 },
  ];
  const out = filterRowsByDimensionFilters(rows, [
    { column: "Region", op: "in", values: ["East"], match: "exact" },
    { column: "Category", op: "in", values: ["Technology"], match: "exact" },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.Sales, 10);
});

test("mergeIntermediateSegmentPivotDefaults is no-op when flag disabled", () => {
  const prev = process.env.DIAGNOSTIC_PIVOT_FILTER_MERGE_ENABLED;
  process.env.DIAGNOSTIC_PIVOT_FILTER_MERGE_ENABLED = "false";
  try {
    const segment = {
      rows: ["Region", "Category"],
      values: ["Sales"],
    };
    const merged = mergeIntermediateSegmentPivotDefaults({
      dataSummary: miniSummary,
      userMessage: "Investigating factors driving Technology's success in the East.",
      parsedQuery: {
        confidence: 0.95,
        dimensionFilters: [
          { column: "Region", op: "in", values: ["East"] },
          { column: "Category", op: "in", values: ["Technology"] },
        ],
      },
      segmentPivot: segment,
    });
    assert.deepEqual(merged, segment);
  } finally {
    if (prev === undefined) delete process.env.DIAGNOSTIC_PIVOT_FILTER_MERGE_ENABLED;
    else process.env.DIAGNOSTIC_PIVOT_FILTER_MERGE_ENABLED = prev;
  }
});

test("mergeIntermediateSegmentPivotDefaults merges when flag enabled and gates pass", () => {
  const prev = process.env.DIAGNOSTIC_PIVOT_FILTER_MERGE_ENABLED;
  process.env.DIAGNOSTIC_PIVOT_FILTER_MERGE_ENABLED = "true";
  try {
    const segment = {
      rows: ["Region", "Category"],
      values: ["Sales"],
    };
    const merged = mergeIntermediateSegmentPivotDefaults({
      dataSummary: miniSummary,
      userMessage: "Investigating factors driving Technology's success in the East.",
      parsedQuery: {
        confidence: 0.95,
        dimensionFilters: [
          { column: "Region", op: "in", values: ["East"] },
          { column: "Category", op: "in", values: ["Technology"] },
        ],
      },
      segmentPivot: segment,
    });
    assert.ok(merged?.filterSelections?.Region?.includes("East"));
    assert.ok(merged?.filterSelections?.Category?.includes("Technology"));
  } finally {
    if (prev === undefined) delete process.env.DIAGNOSTIC_PIVOT_FILTER_MERGE_ENABLED;
    else process.env.DIAGNOSTIC_PIVOT_FILTER_MERGE_ENABLED = prev;
  }
});
