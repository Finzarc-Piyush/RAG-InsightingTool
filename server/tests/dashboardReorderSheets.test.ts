import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { dashboardReorderSheetsRequestSchema } from "../shared/schema.js";

/**
 * Wave DR5 · pin the contract for `POST /dashboards/:id/sheets/reorder`.
 *
 * The model function `reorderSheets` (in `dashboard.model.ts`) is
 * Cosmos-bound; its mutation semantics are exercised end-to-end via
 * the live integration suite. This file pins the request schema —
 * the public contract that the client and any future consumers code
 * against — so a future schema drift fails CI before it ships.
 */

describe("DR5 · dashboardReorderSheetsRequestSchema", () => {
  it("accepts a non-empty list of sheet ids", () => {
    const parsed = dashboardReorderSheetsRequestSchema.safeParse({
      orderedSheetIds: ["sheet_a", "sheet_b", "sheet_c"],
    });
    assert.equal(parsed.success, true);
  });

  it("accepts a single-sheet payload (idempotent base case)", () => {
    const parsed = dashboardReorderSheetsRequestSchema.safeParse({
      orderedSheetIds: ["sheet_a"],
    });
    assert.equal(parsed.success, true);
  });

  it("rejects an empty list (cannot reorder zero sheets)", () => {
    const parsed = dashboardReorderSheetsRequestSchema.safeParse({
      orderedSheetIds: [],
    });
    assert.equal(parsed.success, false);
  });

  it("rejects empty-string ids (Cosmos partition keys must be non-empty)", () => {
    const parsed = dashboardReorderSheetsRequestSchema.safeParse({
      orderedSheetIds: ["sheet_a", ""],
    });
    assert.equal(parsed.success, false);
  });

  it("rejects ids longer than 200 chars (matches sheet id schema cap)", () => {
    const parsed = dashboardReorderSheetsRequestSchema.safeParse({
      orderedSheetIds: ["a".repeat(201)],
    });
    assert.equal(parsed.success, false);
  });

  it("rejects more than 200 ids", () => {
    const parsed = dashboardReorderSheetsRequestSchema.safeParse({
      orderedSheetIds: Array.from({ length: 201 }, (_, i) => `sheet_${i}`),
    });
    assert.equal(parsed.success, false);
  });

  it("rejects non-string entries", () => {
    const parsed = dashboardReorderSheetsRequestSchema.safeParse({
      orderedSheetIds: ["sheet_a", 42],
    });
    assert.equal(parsed.success, false);
  });

  it("rejects missing orderedSheetIds field", () => {
    const parsed = dashboardReorderSheetsRequestSchema.safeParse({});
    assert.equal(parsed.success, false);
  });

  it("strips unknown extra fields by default", () => {
    const parsed = dashboardReorderSheetsRequestSchema.safeParse({
      orderedSheetIds: ["sheet_a"],
      extra: "ignored",
    });
    assert.equal(parsed.success, true);
    if (parsed.success) {
      assert.deepEqual(parsed.data, { orderedSheetIds: ["sheet_a"] });
    }
  });
});
