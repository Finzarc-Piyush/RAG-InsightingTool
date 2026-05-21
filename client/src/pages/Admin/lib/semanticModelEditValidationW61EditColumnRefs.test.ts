/**
 * Wave W61-edit-column + W61-edit-references · validator pins for the
 * column-picker + references-tag-list pair.
 *
 * `validateColumn` is the single-column-name validator consumed by both
 * the EditableColumnPicker (DimensionsCard) and the EditableColumnTagList
 * (MetricsCard) — single-source-of-truth so the cardinality / length /
 * empty rules can't drift across the two edit surfaces.
 *
 * `validateReferences` is the array-level validator covering the
 * `max(20)` cap; per-item content is validated by `validateColumn` at
 * add time.
 *
 * Bounds mirror `semanticDimensionSchema.column` (min(1).max(200)) and
 * `semanticMetricSchema.references` (each item min(1).max(200), array
 * max(20)) in [server/shared/schema.ts](../../../../../server/shared/schema.ts).
 * If those bounds change, update both the validator and these tests.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  REFERENCES_MAX,
  validateColumn,
  validateReferences,
} from "./semanticModelEditValidation.js";

// ───────────────────────── validateColumn ─────────────────────────

test("W61-edit-column · validateColumn: empty string rejected", () => {
  const msg = validateColumn("");
  assert.ok(msg && msg.toLowerCase().includes("required"));
});

test("W61-edit-column · validateColumn: whitespace-only rejected as empty", () => {
  const msg = validateColumn("   ");
  assert.ok(msg && msg.toLowerCase().includes("required"));
});

test("W61-edit-column · validateColumn: simple snake_case column accepted", () => {
  assert.equal(validateColumn("gross_sales"), null);
});

test("W61-edit-column · validateColumn: column with spaces accepted (datasets are not snake_case-only)", () => {
  // Real datasets often have "Order Date" / "Net Sales" / "Customer Name"
  // style columns. The dimension/metric *identifiers* are snake_case
  // (enforced by `validateName`); the underlying *column* is whatever
  // the dataset exposes.
  assert.equal(validateColumn("Order Date"), null);
});

test("W61-edit-column · validateColumn: column with mixed case accepted", () => {
  assert.equal(validateColumn("NetSales"), null);
});

test("W61-edit-column · validateColumn: column with digits and special chars accepted", () => {
  assert.equal(validateColumn("col-2024_v1"), null);
});

test("W61-edit-column · validateColumn: exactly 200 chars accepted", () => {
  assert.equal(validateColumn("a".repeat(200)), null);
});

test("W61-edit-column · validateColumn: 201 chars rejected", () => {
  const msg = validateColumn("a".repeat(201));
  assert.ok(msg && msg.includes("200"));
});

test("W61-edit-column · validateColumn: leading/trailing whitespace tolerated (trimmed)", () => {
  // Trimmed to "x" — should pass. The save handler does its own trim
  // before persisting, so this just checks the validator's friendliness
  // during in-progress typing.
  assert.equal(validateColumn("  region  "), null);
});

test("W61-edit-column · validateColumn: 200-char string after trim accepted", () => {
  // Whitespace-padded but trims to exactly 200 — still valid.
  assert.equal(validateColumn("   " + "a".repeat(200) + "   "), null);
});

// ─────────────────────── validateReferences ───────────────────────

test("W61-edit-references · validateReferences: empty array accepted", () => {
  assert.equal(validateReferences([]), null);
});

test("W61-edit-references · validateReferences: single entry accepted", () => {
  assert.equal(validateReferences(["gross_sales"]), null);
});

test("W61-edit-references · validateReferences: ten entries accepted", () => {
  const refs = Array.from({ length: 10 }, (_, i) => `col_${i}`);
  assert.equal(validateReferences(refs), null);
});

test("W61-edit-references · validateReferences: exactly 20 entries accepted (at cap)", () => {
  const refs = Array.from({ length: REFERENCES_MAX }, (_, i) => `col_${i}`);
  assert.equal(validateReferences(refs), null);
});

test("W61-edit-references · validateReferences: 21 entries rejected (above cap)", () => {
  const refs = Array.from(
    { length: REFERENCES_MAX + 1 },
    (_, i) => `col_${i}`,
  );
  const msg = validateReferences(refs);
  assert.ok(msg && msg.includes(String(REFERENCES_MAX)));
});

test("W61-edit-references · REFERENCES_MAX export is the schema's 20-cap (drift sentinel)", () => {
  // Pin the constant so a schema bump that loosens the cap (or a typo
  // here) surfaces in CI rather than as silent UI / server divergence.
  assert.equal(REFERENCES_MAX, 20);
});
