/**
 * Wave W61-edit-text · per-field validators for the admin
 * semantic-model inline-edit affordance.
 *
 * The server PATCH endpoint (W61-save) is authoritative via
 * `semanticModelSchema.safeParse`; these tests pin the client-side
 * obvious-broken filter so the admin gets a red-border response
 * before paying a round-trip to Cosmos.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isMeaningfulChange,
  validateDescription,
  validateExpression,
  validateLabel,
} from "./semanticModelEditValidation.js";

test("W61-edit-text · validateLabel: empty string rejected", () => {
  assert.equal(validateLabel(""), "Label is required");
});

test("W61-edit-text · validateLabel: whitespace-only rejected", () => {
  assert.equal(validateLabel("   "), "Label is required");
});

test("W61-edit-text · validateLabel: short label accepted", () => {
  assert.equal(validateLabel("Gross revenue"), null);
});

test("W61-edit-text · validateLabel: exactly 120 chars accepted", () => {
  assert.equal(validateLabel("a".repeat(120)), null);
});

test("W61-edit-text · validateLabel: 121 chars rejected", () => {
  const msg = validateLabel("a".repeat(121));
  assert.ok(msg && msg.includes("120"));
});

test("W61-edit-text · validateDescription: empty allowed (optional field)", () => {
  assert.equal(validateDescription(""), null);
});

test("W61-edit-text · validateDescription: 1000 chars accepted", () => {
  assert.equal(validateDescription("x".repeat(1000)), null);
});

test("W61-edit-text · validateDescription: 1001 chars rejected", () => {
  const msg = validateDescription("x".repeat(1001));
  assert.ok(msg && msg.includes("1000"));
});

test("W61-edit-text · validateExpression: empty rejected", () => {
  assert.equal(validateExpression(""), "Expression is required");
});

test("W61-edit-text · validateExpression: whitespace-only rejected", () => {
  assert.equal(validateExpression("   "), "Expression is required");
});

test("W61-edit-text · validateExpression: simple SUM accepted", () => {
  assert.equal(validateExpression("SUM(sales_amount)"), null);
});

test("W61-edit-text · validateExpression: ratio with NULLIF accepted", () => {
  assert.equal(
    validateExpression("SUM(value_sales) / NULLIF(SUM(volume_sales), 0)"),
    null,
  );
});

test("W61-edit-text · validateExpression: semicolon rejected (multi-statement guard)", () => {
  const msg = validateExpression("SUM(x); DROP TABLE users");
  assert.ok(msg && msg.toLowerCase().includes("semicolon"));
});

test("W61-edit-text · validateExpression: dash-dash comment rejected", () => {
  const msg = validateExpression("SUM(x) -- hidden");
  assert.ok(msg && msg.toLowerCase().includes("comment"));
});

test("W61-edit-text · validateExpression: block comment rejected", () => {
  const msg = validateExpression("SUM(x) /* hidden */");
  assert.ok(msg && msg.toLowerCase().includes("comment"));
});

test("W61-edit-text · validateExpression: full SELECT statement rejected", () => {
  const msg = validateExpression("SELECT SUM(x) FROM sales");
  assert.ok(msg);
  // Either the SELECT or the FROM keyword guard fires first — both
  // are valid rejection reasons; we just care that *something* fires.
  const upper = msg!.toUpperCase();
  assert.ok(
    upper.includes("SELECT") || upper.includes("FROM"),
    "rejection cites a banned keyword",
  );
});

test("W61-edit-text · validateExpression: bare JOIN keyword rejected", () => {
  const msg = validateExpression("SUM(a) FROM t JOIN u ON t.id = u.id");
  assert.ok(msg);
});

test("W61-edit-text · validateExpression: bare WHERE keyword rejected", () => {
  const msg = validateExpression("SUM(x) WHERE y > 0");
  assert.ok(msg && msg.includes("WHERE"));
});

test("W61-edit-text · validateExpression: 2000 chars accepted", () => {
  // Build a string of length 2000 that doesn't trip any guard.
  const padding = "SUM(x)" + "+SUM(y)".repeat(280);
  const len2000 = padding.padEnd(2000, "+").slice(0, 2000);
  assert.equal(len2000.length, 2000);
  // The constructed string is just SUM/+/y chars — no banned keywords.
  assert.equal(validateExpression(len2000), null);
});

test("W61-edit-text · validateExpression: 2001 chars rejected", () => {
  const padding = "SUM(x)" + "+SUM(y)".repeat(290);
  const len2001 = padding.padEnd(2001, "+").slice(0, 2001);
  assert.equal(len2001.length, 2001);
  const msg = validateExpression(len2001);
  assert.ok(msg && msg.includes("2000"));
});

test("W61-edit-text · validateExpression: SELECT inside identifier not rejected", () => {
  // "SELECTOR" should not trip the "SELECT " guard since the trailing
  // space matters — this is what the padded ` ${trimmed.toUpperCase()} `
  // form is designed to allow.
  assert.equal(validateExpression("SUM(selector_count)"), null);
});

test("W61-edit-text · isMeaningfulChange: identical strings return false", () => {
  assert.equal(isMeaningfulChange("foo", "foo"), false);
});

test("W61-edit-text · isMeaningfulChange: differing strings return true", () => {
  assert.equal(isMeaningfulChange("foo", "bar"), true);
});

test("W61-edit-text · isMeaningfulChange: only whitespace difference returns false", () => {
  assert.equal(isMeaningfulChange("foo", "  foo  "), false);
});

test("W61-edit-text · isMeaningfulChange: empty vs whitespace returns false", () => {
  assert.equal(isMeaningfulChange("", "   "), false);
});
