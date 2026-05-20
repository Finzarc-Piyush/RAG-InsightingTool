/**
 * Wave W61-edit-enums · `validateCurrencyCode` pin.
 *
 * The enum cells themselves (`<EditableSelect>`) don't need
 * standalone validation because the option list is byte-locked to
 * the zod enum at the source; every selectable value is by
 * construction valid. The only enum-paired free-text field is
 * `currencyCode`, which is an `.optional()` `z.string()` constrained
 * to the ISO-4217 `/^[A-Z]{3}$/` regex when present.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { validateCurrencyCode } from "./semanticModelEditValidation.js";

test("W61-edit-enums · validateCurrencyCode: empty string accepted (optional field)", () => {
  assert.equal(validateCurrencyCode(""), null);
});

test("W61-edit-enums · validateCurrencyCode: whitespace-only accepted as empty", () => {
  assert.equal(validateCurrencyCode("   "), null);
});

test("W61-edit-enums · validateCurrencyCode: ISO-4217 USD accepted", () => {
  assert.equal(validateCurrencyCode("USD"), null);
});

test("W61-edit-enums · validateCurrencyCode: ISO-4217 INR accepted", () => {
  assert.equal(validateCurrencyCode("INR"), null);
});

test("W61-edit-enums · validateCurrencyCode: ISO-4217 EUR accepted", () => {
  assert.equal(validateCurrencyCode("EUR"), null);
});

test("W61-edit-enums · validateCurrencyCode: lowercase rejected", () => {
  const msg = validateCurrencyCode("usd");
  assert.ok(msg && msg.toLowerCase().includes("iso 4217"));
});

test("W61-edit-enums · validateCurrencyCode: two letters rejected", () => {
  assert.ok(validateCurrencyCode("US"));
});

test("W61-edit-enums · validateCurrencyCode: four letters rejected", () => {
  assert.ok(validateCurrencyCode("USDX"));
});

test("W61-edit-enums · validateCurrencyCode: digits rejected", () => {
  assert.ok(validateCurrencyCode("123"));
});

test("W61-edit-enums · validateCurrencyCode: mixed letters and digits rejected", () => {
  assert.ok(validateCurrencyCode("US1"));
});

test("W61-edit-enums · validateCurrencyCode: leading/trailing whitespace tolerated around valid code", () => {
  // Trimmed to "USD" — should pass. The save handler does its own
  // trim before persisting, so this just checks the validator's
  // friendliness during in-progress typing.
  assert.equal(validateCurrencyCode("  USD  "), null);
});

test("W61-edit-enums · validateCurrencyCode: special characters rejected", () => {
  assert.ok(validateCurrencyCode("U$D"));
});
