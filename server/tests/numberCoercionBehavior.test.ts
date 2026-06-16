import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  toNumber,
  toFiniteNumber,
  toNumberOrNull,
  roundTo,
} from "../lib/numberCoercion.js";

/**
 * Behavioral coverage for the shared numeric-coercion leaf module
 * (lib/numberCoercion.ts). Zero-import pure functions; this exercises real
 * input→output, including the load-bearing parseFloat-vs-Number distinction
 * the module's own docblock calls out ("12px" / "1,000" diverge between
 * toFiniteNumber and toNumberOrNull) plus the blank/non-finite edge cases.
 */

describe("numberCoercion · toNumber (%/comma strip, NaN on blank)", () => {
  it("strips percent + thousands commas and coerces", () => {
    assert.equal(toNumber("12%"), 12);
    assert.equal(toNumber("1,234"), 1234);
    assert.equal(toNumber(" 5 "), 5);
    assert.equal(toNumber(42), 42);
  });

  it("returns NaN for null / undefined / empty string", () => {
    assert.ok(Number.isNaN(toNumber(null)));
    assert.ok(Number.isNaN(toNumber(undefined)));
    assert.ok(Number.isNaN(toNumber("")));
  });

  it("returns NaN for genuinely non-numeric text (no aggressive strip)", () => {
    // toNumber only removes %/commas — it does NOT strip currency or units,
    // so "$5" and "12px" are NaN here (this is the documented contract that
    // distinguishes it from chartDownsampling's stricter toNumber).
    assert.ok(Number.isNaN(toNumber("$5")));
    assert.ok(Number.isNaN(toNumber("12px")));
  });
});

describe("numberCoercion · toFiniteNumber (Number(), null on blank/non-finite)", () => {
  it("accepts finite numbers and numeric strings", () => {
    assert.equal(toFiniteNumber(3.5), 3.5);
    assert.equal(toFiniteNumber("  7 "), 7);
    assert.equal(toFiniteNumber("0"), 0);
  });

  it("rejects blanks, non-finite numbers, and partially-numeric strings", () => {
    assert.equal(toFiniteNumber(""), null);
    assert.equal(toFiniteNumber("   "), null);
    assert.equal(toFiniteNumber(Number.NaN), null);
    assert.equal(toFiniteNumber(Number.POSITIVE_INFINITY), null);
    // Number("12px") is NaN → null (the divergence point vs toNumberOrNull).
    assert.equal(toFiniteNumber("12px"), null);
    // Number("1,000") is NaN → null (comma is not stripped here).
    assert.equal(toFiniteNumber("1,000"), null);
    assert.equal(toFiniteNumber(null), null);
    assert.equal(toFiniteNumber({}), null);
  });
});

describe("numberCoercion · toNumberOrNull (parseFloat, null fallback)", () => {
  it("parses leading-numeric strings parseFloat-style", () => {
    // The documented divergence: parseFloat("12px") === 12 (vs null above).
    assert.equal(toNumberOrNull("12px"), 12);
    // parseFloat("1,000") === 1 (stops at the comma), vs null above.
    assert.equal(toNumberOrNull("1,000"), 1);
    assert.equal(toNumberOrNull("3.14 rad"), 3.14);
    assert.equal(toNumberOrNull(8), 8);
  });

  it("returns null for blank, leading-non-numeric, and non-finite", () => {
    assert.equal(toNumberOrNull(""), null);
    assert.equal(toNumberOrNull("abc"), null);
    assert.equal(toNumberOrNull(Number.NaN), null);
    assert.equal(toNumberOrNull(null), null);
    assert.equal(toNumberOrNull(undefined), null);
  });
});

describe("numberCoercion · roundTo", () => {
  it("rounds to the requested decimal places (default 6)", () => {
    assert.equal(roundTo(1.23456789), 1.234568);
    assert.equal(roundTo(1.005, 2), 1); // float-repr edge: 1.005*100 → 100.49…
    assert.equal(roundTo(2.5, 0), 3);
    assert.equal(roundTo(123.456, 1), 123.5);
  });

  it("passes non-finite inputs through unchanged", () => {
    assert.ok(Number.isNaN(roundTo(Number.NaN)));
    assert.equal(roundTo(Number.POSITIVE_INFINITY), Number.POSITIVE_INFINITY);
    assert.equal(roundTo(Number.NEGATIVE_INFINITY), Number.NEGATIVE_INFINITY);
  });
});
