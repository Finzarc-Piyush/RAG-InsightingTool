import { test } from "node:test";
import assert from "node:assert/strict";
import { applyQueryTransformations } from "../lib/dataTransform.js";
import type { DataSummary } from "../shared/schema.js";

const rows = [
  { Category: "Technology", "Sub-Category": "Phones", Sales: 100 },
  { Category: "Technology", "Sub-Category": "Accessories", Sales: 50 },
  { Category: "Furniture", "Sub-Category": "Chairs", Sales: 200 },
];

const summary: DataSummary = {
  rowCount: 3,
  columnCount: 3,
  columns: [
    { name: "Category", type: "string", sampleValues: ["Technology"] },
    { name: "Sub-Category", type: "string", sampleValues: ["Phones"] },
    { name: "Sales", type: "number", sampleValues: [100] },
  ],
  numericColumns: ["Sales"],
  dateColumns: [],
};

test("dimensionFilters + groupBy aggregates within category", () => {
  const { data: out } = applyQueryTransformations(rows, summary, {
    rawQuestion: "test",
    dimensionFilters: [{ column: "Category", op: "in", values: ["Technology"], match: "exact" }],
    groupBy: ["Sub-Category"],
    aggregations: [{ column: "Sales", operation: "sum", alias: "sum_sales" }],
  });
  assert.equal(out.length, 2);
  const bySub = Object.fromEntries(out.map((r) => [r["Sub-Category"], r.sum_sales]));
  assert.equal(bySub.Phones, 100);
  assert.equal(bySub.Accessories, 50);
});

test("valueFilter on string column is skipped (no silent wipe)", () => {
  const { data: out } = applyQueryTransformations(rows, summary, {
    rawQuestion: "test",
    valueFilters: [{ column: "Category", operator: "=", value: 1 }],
    groupBy: ["Category"],
    aggregations: [{ column: "Sales", operation: "sum", alias: "s" }],
  });
  assert.ok(out.length >= 1);
});

test("case_insensitive dimension match", () => {
  const { data: out } = applyQueryTransformations(rows, summary, {
    rawQuestion: "test",
    dimensionFilters: [{ column: "Category", op: "in", values: ["technology"], match: "case_insensitive" }],
    groupBy: ["Sub-Category"],
    aggregations: [{ column: "Sales", operation: "sum", alias: "s" }],
  });
  assert.equal(out.length, 2);
});
