import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * Mirrors the first-time branch in client `syncFilterSelectionsWithFilters`
 * when `initialSelections` is provided (must stay in sync with buildPivotModel.ts).
 */
function initialSelectionForField(
  distinctNow: Set<string>,
  hinted: string[] | undefined
): Set<string> {
  if (!hinted?.length) {
    return new Set(distinctNow);
  }
  const narrowed = new Set(hinted.filter((v) => distinctNow.has(v)));
  return narrowed.size > 0 ? narrowed : new Set(distinctNow);
}

describe("pivot sync initial selection hints (client parity)", () => {
  it("narrows to hinted values that exist in distincts", () => {
    const distinct = new Set(["Technology", "Furniture", "Office Supplies"]);
    const sel = initialSelectionForField(distinct, ["Technology"]);
    assert.deepEqual([...sel].sort(), ["Technology"]);
  });

  it("falls back to all distincts when hint misses every value", () => {
    const distinct = new Set(["A", "B"]);
    const sel = initialSelectionForField(distinct, ["Missing"]);
    assert.deepEqual([...sel].sort(), ["A", "B"]);
  });

  it("selects all when no hint", () => {
    const distinct = new Set(["X", "Y"]);
    const sel = initialSelectionForField(distinct, undefined);
    assert.deepEqual([...sel].sort(), ["X", "Y"]);
  });
});
