import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isRealDataRow,
  trimTrailingSparseRows,
} from "../lib/tableStructure/rowProfile.js";

/**
 * Wave · phantom "null" Month fix. Trailing formula/footer rows below the real
 * table (blank dimension columns + a lone stray value) must be dropped before
 * they become a phantom null-dimension bucket. A NULL MEASURE on an otherwise
 * dense row is legitimate and must survive (the real "null Retailer Margin"
 * finding). Interior sparse rows are kept; a wholly sparse table is never wiped.
 */

// 10-column row template (threshold = ceil(10 * 0.3) = 3 non-null cells).
const KEYS = ["Month", "Channel", "Brand", "v1", "v2", "v3", "v4", "v5", "v6", "v7"];
function row(values: Record<string, unknown>): Record<string, unknown> {
  const rec: Record<string, unknown> = {};
  for (const k of KEYS) rec[k] = k in values ? values[k] : null;
  return rec;
}

describe("isRealDataRow", () => {
  it("floors to 1 non-null for narrow tables (no regression vs !allEmpty)", () => {
    assert.equal(isRealDataRow(1, 3), true);
    assert.equal(isRealDataRow(1, 2), true);
  });
  it("requires ~30% density for wide tables", () => {
    // 42-col Marico sheet → threshold = ceil(12.6) = 13.
    assert.equal(isRealDataRow(1, 42), false); // a lone stray value
    assert.equal(isRealDataRow(13, 42), true);
    assert.equal(isRealDataRow(40, 42), true); // a real dense row
  });
});

describe("trimTrailingSparseRows", () => {
  it("drops trailing stray-value rows (the phantom null-Month source)", () => {
    const rows = [
      row({ Month: "Apr", Channel: "GT", Brand: "H&C", v1: 1, v2: 2, v3: 3 }),
      row({ Month: "Apr", Channel: "MT", Brand: "SAFF", v1: 4, v2: 5, v3: 6 }),
      row({ v4: 0 }), // trailing formula cell: Month null, 1 non-null
      row({ v5: 7 }), // trailing formula cell: Month null, 1 non-null
    ];
    const out = trimTrailingSparseRows(rows);
    assert.equal(out.length, 2);
    assert.ok(out.every((r) => r.Month !== null), "no surviving null-Month row");
  });

  it("KEEPS a dense row that has a null MEASURE (legitimate null Retailer Margin)", () => {
    const rows = [
      // Month present + many cols filled, but the margin measure is null.
      row({ Month: "Apr", Channel: "CSD", Brand: "X", v1: 1, v2: 2, v3: null, v4: 4 }),
      row({ v5: 9 }), // trailing junk
    ];
    const out = trimTrailingSparseRows(rows);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.Month, "Apr");
    assert.equal(out[0]!.v3, null, "null measure preserved on a kept row");
  });

  it("keeps an interior sparse row that is followed by a real row", () => {
    const rows = [
      row({ Month: "Apr", Channel: "GT", Brand: "A", v1: 1 }),
      row({ Channel: "MT" }), // interior sparse (1 non-null)
      row({ Month: "May", Channel: "CSD", Brand: "B", v1: 2 }),
      row({ v7: 5 }), // trailing junk
    ];
    const out = trimTrailingSparseRows(rows);
    assert.equal(out.length, 3, "interior sparse kept, trailing junk dropped");
  });

  it("never wipes a legitimately sparse table (no row clears the floor)", () => {
    const rows = [row({ Channel: "GT" }), row({ Channel: "MT" })];
    const out = trimTrailingSparseRows(rows);
    assert.equal(out.length, 2);
  });

  it("is a no-op on an empty array", () => {
    assert.deepEqual(trimTrailingSparseRows([]), []);
  });
});
