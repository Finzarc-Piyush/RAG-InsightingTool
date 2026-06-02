import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { facetColumnInlineDuckDbExpr } from "../lib/temporalFacetColumns.js";

describe("facetColumnInlineDuckDbExpr (W13)", () => {
  const cols = new Set(["Order Date", "Sales", "Region"]);

  it("returns null for a non-facet column", () => {
    assert.strictEqual(facetColumnInlineDuckDbExpr("Sales", cols), null);
  });

  it("returns null when source date column is absent", () => {
    const noDate = new Set(["Sales", "Region"]);
    assert.strictEqual(facetColumnInlineDuckDbExpr("Month · Order Date", noDate), null);
  });

  it("generates a year expression with correct strftime format", () => {
    const expr = facetColumnInlineDuckDbExpr("Year · Order Date", cols);
    assert.ok(expr !== null, "should return an expression");
    assert.ok(expr.includes("strftime('%Y'"), `expected strftime('%Y') in: ${expr}`);
    assert.ok(expr.includes("Order Date"), `expected source column in: ${expr}`);
    assert.ok(expr.includes("TRY_CAST"), "should use TRY_CAST for safety");
  });

  it("generates a month expression producing YYYY-MM format", () => {
    const expr = facetColumnInlineDuckDbExpr("Month · Order Date", cols);
    assert.ok(expr !== null);
    assert.ok(expr.includes("strftime('%Y-%m'"), `expected strftime('%Y-%m') in: ${expr}`);
  });

  it("generates a day expression producing YYYY-MM-DD format", () => {
    const expr = facetColumnInlineDuckDbExpr("Day · Order Date", cols);
    assert.ok(expr !== null);
    assert.ok(expr.includes("strftime('%Y-%m-%d'"), `expected strftime('%Y-%m-%d') in: ${expr}`);
  });

  it("generates a quarter expression with Q suffix", () => {
    const expr = facetColumnInlineDuckDbExpr("Quarter · Order Date", cols);
    assert.ok(expr !== null);
    assert.ok(expr.includes("QUARTER("), `expected QUARTER() in: ${expr}`);
    assert.ok(expr.includes("-Q"), `expected -Q in format string: ${expr}`);
  });

  it("generates a half_year expression with H suffix", () => {
    const expr = facetColumnInlineDuckDbExpr("Half-year · Order Date", cols);
    assert.ok(expr !== null);
    assert.ok(expr.includes("MONTH("), `expected MONTH() in: ${expr}`);
    assert.ok(expr.includes("-H"), `expected -H in format string: ${expr}`);
    assert.ok(expr.includes("CASE WHEN"), "should branch on first/second half");
  });

  it("generates a week expression in ISO YYYY-Www format", () => {
    const expr = facetColumnInlineDuckDbExpr("Week · Order Date", cols);
    assert.ok(expr !== null);
    assert.ok(expr.includes("isoyear"), `expected isoyear in: ${expr}`);
    assert.ok(expr.includes("-W"), `expected -W in format string: ${expr}`);
  });

  it("correctly quotes source column names with spaces", () => {
    const withSpace = new Set(["Ship Date"]);
    const expr = facetColumnInlineDuckDbExpr("Month · Ship Date", withSpace);
    assert.ok(expr !== null);
    assert.ok(expr.includes('"Ship Date"'), `expected quoted column name in: ${expr}`);
  });

  it("correctly escapes source column names with double-quote characters", () => {
    const quoted = new Set(['A"B']);
    const expr = facetColumnInlineDuckDbExpr('Year · A"B', quoted);
    assert.ok(expr !== null);
    assert.ok(expr.includes('"A""B"'), `expected escaped identifier in: ${expr}`);
  });
});

describe("facetColumnInlineDuckDbExpr · melted period dimension (derive from PeriodIso)", () => {
  const periodCols = new Set(["Period", "PeriodIso", "PeriodKind", "Value"]);
  const binding = { periodCol: "Period", isoCol: "PeriodIso" };

  it("quarter expr reads PeriodIso shape, not date-casts the Period label", () => {
    const expr = facetColumnInlineDuckDbExpr("Quarter · Period", periodCols, binding);
    assert.ok(expr !== null);
    assert.ok(expr.includes('regexp_full_match("PeriodIso"'), `expected regexp_full_match on PeriodIso in: ${expr}`);
    assert.ok(/\\d\{4\}-Q\[1-4\]/.test(expr), `expected quarter iso pattern in: ${expr}`);
    assert.ok(!expr.includes("TRY_CAST"), `must NOT date-cast the Period label: ${expr}`);
    assert.ok(!expr.includes("QUARTER("), `must NOT use QUARTER() over a cast date: ${expr}`);
  });

  it("year expr extracts the leading 4-digit year from PeriodIso", () => {
    const expr = facetColumnInlineDuckDbExpr("Year · Period", periodCols, binding);
    assert.ok(expr !== null);
    assert.ok(expr.includes('regexp_extract("PeriodIso"'), `expected regexp_extract in: ${expr}`);
    assert.ok(!expr.includes("strftime"), `must NOT strftime a cast date: ${expr}`);
  });

  it("self-detects the Period/PeriodIso triple even without an explicit binding", () => {
    const expr = facetColumnInlineDuckDbExpr("Quarter · Period", periodCols);
    assert.ok(expr !== null);
    assert.ok(expr.includes('regexp_full_match("PeriodIso"'), `expected self-detected PeriodIso path in: ${expr}`);
  });

  it("does NOT hijack a real date column named Period when no PeriodIso sibling exists", () => {
    const tidy = new Set(["Period", "Sales"]);
    const expr = facetColumnInlineDuckDbExpr("Quarter · Period", tidy);
    assert.ok(expr !== null);
    assert.ok(expr.includes("QUARTER("), `tidy Period should still date-cast: ${expr}`);
    assert.ok(!expr.includes("PeriodIso"), `no PeriodIso reference expected: ${expr}`);
  });

  it("leaves real date columns (Order Date) on the date-cast path even with a period binding present", () => {
    const mixed = new Set(["Order Date", "Period", "PeriodIso", "Sales"]);
    const expr = facetColumnInlineDuckDbExpr("Quarter · Order Date", mixed, binding);
    assert.ok(expr !== null);
    assert.ok(expr.includes("QUARTER("), `Order Date must keep QUARTER(): ${expr}`);
    assert.ok(!expr.includes("PeriodIso"), `Order Date must not reference PeriodIso: ${expr}`);
  });
});
