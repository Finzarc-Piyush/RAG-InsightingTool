/**
 * Stream B · unit tests for the native-chart boundary sanitizer
 * (`chartValueSanitize.ts`) — the single authority for what reaches a native
 * pptxgenjs `addChart`. Non-finite values, empty labels, and empty series names
 * are exactly the inputs that make pptxgenjs emit corrupt OOXML (the "Repair"
 * prompt + dropped/blank slides).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  finiteOrZero,
  sanitizeValues,
  maxFiniteAbs,
  safeLabel,
  safeSeriesName,
  isDegenerateNative,
  EMPTY_LABEL_PLACEHOLDER,
} from "../lib/exports/pptx/chartValueSanitize.js";

describe("chartValueSanitize", () => {
  it("finiteOrZero coerces non-finite / non-numeric to 0", () => {
    assert.equal(finiteOrZero(NaN), 0);
    assert.equal(finiteOrZero(Infinity), 0);
    assert.equal(finiteOrZero(-Infinity), 0);
    assert.equal(finiteOrZero(null), 0);
    assert.equal(finiteOrZero(undefined), 0);
    assert.equal(finiteOrZero("abc"), 0);
    assert.equal(finiteOrZero("12"), 12);
    assert.equal(finiteOrZero(5), 5);
  });

  it("sanitizeValues preserves length and finiteness", () => {
    assert.deepEqual(sanitizeValues([1, NaN, null, undefined, 3]), [1, 0, 0, 0, 3]);
    assert.equal(sanitizeValues([]).length, 0);
  });

  it("maxFiniteAbs ignores non-finite and seeds at 0", () => {
    assert.equal(maxFiniteAbs([NaN, 3, -5, Infinity]), 5);
    assert.equal(maxFiniteAbs([]), 0);
    assert.equal(maxFiniteAbs([NaN, Infinity]), 0);
  });

  it("safeLabel replaces empty/blank/null with the placeholder", () => {
    assert.equal(safeLabel(""), EMPTY_LABEL_PLACEHOLDER);
    assert.equal(safeLabel("   "), EMPTY_LABEL_PLACEHOLDER);
    assert.equal(safeLabel(null), EMPTY_LABEL_PLACEHOLDER);
    assert.equal(safeLabel("GT"), "GT");
    assert.equal(safeLabel(0), "0");
  });

  it("safeSeriesName falls back when empty", () => {
    assert.equal(safeSeriesName(""), "Series");
    assert.equal(safeSeriesName("   ", "NR"), "NR");
    assert.equal(safeSeriesName("Volume"), "Volume");
  });

  it("isDegenerateNative flags empty / all-zero charts", () => {
    assert.equal(isDegenerateNative({ categories: [], series: [{ values: [1] }] }), true);
    assert.equal(isDegenerateNative({ categories: ["a"], series: [] }), true);
    assert.equal(isDegenerateNative({ categories: ["a", "b"], series: [{ values: [0, 0] }] }), true);
    assert.equal(isDegenerateNative({ categories: ["a", "b"], series: [{ values: [0, 1] }] }), false);
  });
});
