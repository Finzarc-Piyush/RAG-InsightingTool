import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyActiveFilter,
  isActiveFilterEffective,
  effectiveConditionCount,
} from "../lib/activeFilter/applyActiveFilter.js";
import type { ActiveFilterSpec } from "../shared/schema.js";

const rows = [
  { Region: "North", Sales: 100, Date: "2024-01-15", Brand: "A" },
  { Region: "South", Sales: 200, Date: "2024-03-22", Brand: "B" },
  { Region: "North", Sales: 50, Date: "2024-07-01", Brand: "A" },
  { Region: "East", Sales: null, Date: null, Brand: "" },
  { Region: "", Sales: "300", Date: "2025-01-01T00:00:00.000Z", Brand: "C" },
];

function spec(conditions: ActiveFilterSpec["conditions"]): ActiveFilterSpec {
  return { conditions, version: 1, updatedAt: 0 };
}

test("applyActiveFilter returns input unchanged when spec is undefined or empty", () => {
  assert.equal(applyActiveFilter(rows, undefined), rows);
  assert.equal(applyActiveFilter(rows, null), rows);
  assert.equal(applyActiveFilter(rows, spec([])), rows);
  assert.equal(isActiveFilterEffective(undefined), false);
  assert.equal(isActiveFilterEffective(spec([])), false);
});

test("in-condition: multi-select OR within column", () => {
  const out = applyActiveFilter(
    rows,
    spec([{ kind: "in", column: "Region", values: ["North", "South"] }])
  );
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((r) => r.Region).sort(), ["North", "North", "South"]);
});

test("in-condition with empty values matches nothing (mirrors SQL 1=0)", () => {
  const out = applyActiveFilter(
    rows,
    spec([{ kind: "in", column: "Region", values: [] }])
  );
  assert.equal(out.length, 0);
});

test("in-condition matches blank values via empty string key", () => {
  const out = applyActiveFilter(
    rows,
    spec([{ kind: "in", column: "Region", values: [""] }])
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].Region, "");
});

test("range-condition: min and max bounds (numeric coercion)", () => {
  const out = applyActiveFilter(
    rows,
    spec([{ kind: "range", column: "Sales", min: 80, max: 250 }])
  );
  assert.deepEqual(out.map((r) => r.Sales).sort(), [100, 200]);
});

test("range-condition: only min, coerces string numerics", () => {
  const out = applyActiveFilter(
    rows,
    spec([{ kind: "range", column: "Sales", min: 250 }])
  );
  // "300" coerces; null/undefined excluded.
  assert.equal(out.length, 1);
  assert.equal(out[0].Sales, "300");
});

test("range-condition: rows with null/missing numeric are excluded", () => {
  const out = applyActiveFilter(
    rows,
    spec([{ kind: "range", column: "Sales", min: 0 }])
  );
  // null Sales row dropped; all 4 numeric rows (100, 200, 50, "300") survive.
  assert.equal(out.length, 4);
});

test("dateRange-condition: from + to inclusive", () => {
  const out = applyActiveFilter(
    rows,
    spec([{ kind: "dateRange", column: "Date", from: "2024-01-01", to: "2024-06-30" }])
  );
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((r) => r.Date), ["2024-01-15", "2024-03-22"]);
});

test("dateRange-condition: only from", () => {
  const out = applyActiveFilter(
    rows,
    spec([{ kind: "dateRange", column: "Date", from: "2025-01-01" }])
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].Brand, "C");
});

test("multi-condition AND across columns", () => {
  const out = applyActiveFilter(
    rows,
    spec([
      { kind: "in", column: "Region", values: ["North"] },
      { kind: "range", column: "Sales", min: 80 },
    ])
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].Sales, 100);
});

test("ineffective conditions (empty values, empty range) are skipped, not 0=1", () => {
  // A range with no min/max is not effective; a dateRange with no bounds is not effective.
  // The whole spec becomes effectively empty if those are the only conditions.
  const s = spec([
    { kind: "range", column: "Sales" },
    { kind: "dateRange", column: "Date" },
  ]);
  assert.equal(isActiveFilterEffective(s), false);
  assert.equal(applyActiveFilter(rows, s), rows);
});

test("effectiveConditionCount counts only narrowing conditions", () => {
  const s = spec([
    { kind: "in", column: "Region", values: ["North"] },
    { kind: "range", column: "Sales" }, // no bounds — not effective
    { kind: "in", column: "Brand", values: [] }, // empty — counts as effective (matches nothing)
  ]);
  assert.equal(effectiveConditionCount(s), 2);
});
