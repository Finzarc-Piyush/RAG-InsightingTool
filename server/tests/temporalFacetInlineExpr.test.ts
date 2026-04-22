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
