import { test } from "node:test";
import assert from "node:assert/strict";
import { buildActiveFilterWhereSql } from "../lib/activeFilter/buildActiveFilterSql.js";
import type { ActiveFilterSpec } from "../shared/schema.js";

function spec(conditions: ActiveFilterSpec["conditions"]): ActiveFilterSpec {
  return { conditions, version: 1, updatedAt: 0 };
}

test("returns null for empty / ineffective spec", () => {
  assert.equal(buildActiveFilterWhereSql(undefined), null);
  assert.equal(buildActiveFilterWhereSql(null), null);
  assert.equal(buildActiveFilterWhereSql(spec([])), null);
  assert.equal(
    buildActiveFilterWhereSql(spec([{ kind: "range", column: "x" }])),
    null
  );
});

test("in-condition produces COALESCE/CAST IN list", () => {
  const sql = buildActiveFilterWhereSql(
    spec([{ kind: "in", column: "Region", values: ["North", "South"] }])
  );
  assert.equal(sql, `(COALESCE(CAST("Region" AS VARCHAR), '') IN ('North', 'South'))`);
});

test("in-condition with empty values yields 1=0", () => {
  const sql = buildActiveFilterWhereSql(
    spec([{ kind: "in", column: "Region", values: [] }])
  );
  assert.equal(sql, `(1=0)`);
});

test("identifier with embedded double-quote is doubled (no SQL injection)", () => {
  const sql = buildActiveFilterWhereSql(
    spec([{ kind: "in", column: 'Region"; DROP', values: ["x"] }])
  );
  assert.match(sql ?? "", /"Region""; DROP"/);
});

test("string value with embedded apostrophe is doubled", () => {
  const sql = buildActiveFilterWhereSql(
    spec([{ kind: "in", column: "Brand", values: ["O'Hara"] }])
  );
  assert.match(sql ?? "", /'O''Hara'/);
});

test("range-condition emits TRY_CAST(... AS DOUBLE) bounds", () => {
  const sql = buildActiveFilterWhereSql(
    spec([{ kind: "range", column: "Sales", min: 100, max: 500 }])
  );
  assert.equal(
    sql,
    `(TRY_CAST("Sales" AS DOUBLE) >= 100 AND TRY_CAST("Sales" AS DOUBLE) <= 500)`
  );
});

test("range-condition with only one bound", () => {
  const sql = buildActiveFilterWhereSql(
    spec([{ kind: "range", column: "Sales", min: 100 }])
  );
  assert.equal(sql, `(TRY_CAST("Sales" AS DOUBLE) >= 100)`);
});

test("dateRange-condition emits VARCHAR ISO compare", () => {
  const sql = buildActiveFilterWhereSql(
    spec([{ kind: "dateRange", column: "Date", from: "2024-01-01", to: "2024-12-31" }])
  );
  assert.equal(
    sql,
    `(CAST("Date" AS VARCHAR) >= '2024-01-01' AND CAST("Date" AS VARCHAR) <= '2024-12-31')`
  );
});

test("multi-condition AND across columns", () => {
  const sql = buildActiveFilterWhereSql(
    spec([
      { kind: "in", column: "Region", values: ["North"] },
      { kind: "range", column: "Sales", min: 100 },
    ])
  );
  assert.equal(
    sql,
    `(COALESCE(CAST("Region" AS VARCHAR), '') IN ('North')) AND (TRY_CAST("Sales" AS DOUBLE) >= 100)`
  );
});
