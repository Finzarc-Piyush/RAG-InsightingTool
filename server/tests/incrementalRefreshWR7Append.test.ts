/**
 * Wave WR7 (incremental refresh) · append / union cores.
 *
 * Append is the user's primary "incremental" model (Jan + Feb → full combined),
 * and the riskiest data operation: a wrong dedup key silently double-counts or
 * drops rows. This pins the pure cores — key inference, union dedup (new wins),
 * and overlap detection.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  inferBusinessKey,
  unionAppendRows,
  countOverlap,
} from "../lib/refresh/unionAppend.js";
import type { DataSummary } from "../shared/schema.js";

const summary = {
  columns: [
    { name: "Date", type: "string" },
    { name: "Brand", type: "string" },
    { name: "Sales", type: "number" },
    { name: "Units", type: "number" },
  ],
  numericColumns: ["Sales", "Units"],
  dateColumns: ["Date"],
  rowCount: 0,
  columnCount: 4,
} as unknown as DataSummary;

describe("WR7 · inferBusinessKey", () => {
  it("keys on the non-measure (dimension) columns", () => {
    assert.deepEqual(inferBusinessKey(summary), ["Date", "Brand"]);
  });

  it("falls back to all columns when every column is numeric", () => {
    const allNum = {
      columns: [{ name: "A", type: "number" }, { name: "B", type: "number" }],
      numericColumns: ["A", "B"],
    } as unknown as DataSummary;
    assert.deepEqual(inferBusinessKey(allNum), ["A", "B"]);
  });

  it("returns [] for an empty/absent summary", () => {
    assert.deepEqual(inferBusinessKey(undefined), []);
  });
});

describe("WR7 · unionAppendRows", () => {
  const jan = [
    { Date: "Jan", Brand: "PARACHUTE", Sales: 100 },
    { Date: "Jan", Brand: "NIHAR", Sales: 50 },
  ];

  it("appends genuinely-new rows and keeps everything (Jan + Feb)", () => {
    const feb = [
      { Date: "Feb", Brand: "PARACHUTE", Sales: 120 },
      { Date: "Feb", Brand: "NIHAR", Sales: 60 },
    ];
    const out = unionAppendRows(jan, feb, ["Date", "Brand"]);
    assert.equal(out.rows.length, 4);
    assert.equal(out.added, 2);
    assert.equal(out.superseded, 0);
  });

  it("dedups on key collision with NEW winning (no double-count)", () => {
    // Re-stated Jan/PARACHUTE with a corrected value + one genuinely new Feb row.
    const mixed = [
      { Date: "Jan", Brand: "PARACHUTE", Sales: 999 },
      { Date: "Feb", Brand: "PARACHUTE", Sales: 120 },
    ];
    const out = unionAppendRows(jan, mixed, ["Date", "Brand"]);
    assert.equal(out.superseded, 1, "the old Jan/PARACHUTE row is superseded");
    assert.equal(out.rows.length, 3, "Jan/NIHAR + new Jan/PARACHUTE + Feb/PARACHUTE");
    const janParachute = out.rows.find(
      (r) => r.Date === "Jan" && r.Brand === "PARACHUTE"
    );
    assert.equal(janParachute?.Sales, 999, "new value wins");
  });

  it("straight-concats when no key columns are given", () => {
    const out = unionAppendRows(jan, [{ Date: "Jan", Brand: "PARACHUTE", Sales: 1 }], []);
    assert.equal(out.rows.length, 3, "no dedup → all rows kept");
    assert.equal(out.superseded, 0);
  });
});

describe("WR7 · countOverlap (preview warning)", () => {
  it("counts new rows that collide with existing rows", () => {
    const jan = [{ Date: "Jan", Brand: "A" }, { Date: "Jan", Brand: "B" }];
    const incoming = [
      { Date: "Jan", Brand: "A" }, // overlaps
      { Date: "Feb", Brand: "A" }, // new
    ];
    assert.equal(countOverlap(jan, incoming, ["Date", "Brand"]), 1);
  });

  it("is 0 with no key", () => {
    assert.equal(countOverlap([{ a: 1 }], [{ a: 1 }], []), 0);
  });
});
