/**
 * Behavioral coverage for the ID-column naming heuristics
 * (server/lib/columnIdHeuristics.ts). Pure module, zero deps — hermetic.
 *
 * These predicates decide whether a column is a surrogate key / code (and so
 * must never be date-enriched, faceted, or charted as a measure). We assert the
 * real name-pattern and statistical-signal decisions, including edge cases.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isIdColumn,
  isLikelyIdentifierColumnName,
  isIdentifierLikeNumericColumn,
  getCountNameForIdColumn,
} from "../lib/columnIdHeuristics.js";

describe("isIdColumn", () => {
  it("matches the _id / id / _id_ name patterns", () => {
    assert.equal(isIdColumn("order_id"), true);
    assert.equal(isIdColumn("id"), true);
    assert.equal(isIdColumn("ID"), true);
    assert.equal(isIdColumn("some_id_field"), true);
  });

  it("matches the well-known FK names case-insensitively", () => {
    assert.equal(isIdColumn("CUSTOMER_ID"), true);
    assert.equal(isIdColumn("Transaction_Id"), true);
  });

  it("does not match plain measure / dimension names", () => {
    assert.equal(isIdColumn("revenue"), false);
    assert.equal(isIdColumn("region"), false);
    // "idea" / "identity" must not false-trigger on the substring "id".
    assert.equal(isIdColumn("idea"), false);
    assert.equal(isIdColumn("width"), false);
  });
});

describe("isLikelyIdentifierColumnName", () => {
  it("flags row/record/order number variants and the index sentinel", () => {
    assert.equal(isLikelyIdentifierColumnName("Row ID"), true);
    assert.equal(isLikelyIdentifierColumnName("Order No."), true);
    assert.equal(isLikelyIdentifierColumnName("Customer Number"), true);
    assert.equal(isLikelyIdentifierColumnName("index"), true);
    assert.equal(isLikelyIdentifierColumnName("idx"), true);
  });

  it("flags code / sku / uuid / combo names", () => {
    assert.equal(isLikelyIdentifierColumnName("Postal Code"), true);
    assert.equal(isLikelyIdentifierColumnName("SKU"), true);
    assert.equal(isLikelyIdentifierColumnName("Order UUID"), true);
    // "combo" marks a concatenated key that contains "date" but is NOT a date.
    assert.equal(isLikelyIdentifierColumnName("TSOE-Date Combo"), true);
  });

  it("does not flag genuine measures / dimensions", () => {
    assert.equal(isLikelyIdentifierColumnName("Sales"), false);
    assert.equal(isLikelyIdentifierColumnName("Region"), false);
    assert.equal(isLikelyIdentifierColumnName("Order Date"), false);
  });
});

describe("isIdentifierLikeNumericColumn", () => {
  it("returns false for empty value lists", () => {
    assert.equal(isIdentifierLikeNumericColumn("anything", []), false);
  });

  it("Signal A: classifies by name even when values look measure-like", () => {
    // Low cardinality, varied width — only the NAME pattern catches this.
    assert.equal(
      isIdentifierLikeNumericColumn("Postal Code", ["12", "12", "34"]),
      true
    );
  });

  it("Signal B: high cardinality (>=80% unique) integers are surrogate keys", () => {
    const seq = ["1", "2", "3", "4", "5"]; // 100% unique
    assert.equal(isIdentifierLikeNumericColumn("seq", seq), true);
  });

  it("Signal C: fixed integer digit-width (>=3) is a code field", () => {
    // All 5-digit ZIP-like codes, low cardinality (so Signal B does not apply).
    const zips = ["90210", "90210", "10001", "10001", "60601", "60601"];
    assert.equal(isIdentifierLikeNumericColumn("zip", zips), true);
  });

  it("returns false for a real low-cardinality varied-width measure", () => {
    // Repeated values (low cardinality), mixed widths, generic name → a measure.
    const vals = ["1", "10", "1", "10", "1", "10"];
    assert.equal(isIdentifierLikeNumericColumn("units_sold", vals), false);
  });

  it("returns false when values are not all integers", () => {
    // Decimals can never be an identifier under any signal.
    const vals = ["1.5", "2.5", "3.5", "4.5", "5.5"];
    assert.equal(isIdentifierLikeNumericColumn("ratio", vals), false);
  });
});

describe("getCountNameForIdColumn", () => {
  it("rewrites an _id suffix to _count", () => {
    assert.equal(getCountNameForIdColumn("order_id"), "order_count");
    assert.equal(getCountNameForIdColumn("CUSTOMER_ID"), "customer_count");
  });

  it("appends _count when there is no _id suffix", () => {
    assert.equal(getCountNameForIdColumn("region"), "region_count");
  });
});
