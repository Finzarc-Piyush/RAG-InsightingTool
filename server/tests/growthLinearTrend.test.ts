// WGR4 · linearTrend tests — pin the OLS slope/R² helper used by
// compute_growth's "trend" mode, including the small-n and all-equal edges
// that the forecasting linearFit guards out.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { linearTrend } from "../lib/growth/linearTrend.js";

describe("WGR4 · linearTrend", () => {
  it("rising series → positive slope, R²≈1", () => {
    const r = linearTrend([1, 2, 3, 4, 5]);
    assert.ok(r.slope > 0, `expected slope>0, got ${r.slope}`);
    assert.ok(Math.abs(r.slope - 1) < 1e-9, `expected slope≈1, got ${r.slope}`);
    assert.ok(r.r2 > 0.999, `expected r2≈1, got ${r.r2}`);
  });

  it("falling series → negative slope", () => {
    const r = linearTrend([10, 8, 6, 4, 2]);
    assert.ok(r.slope < 0, `expected slope<0, got ${r.slope}`);
    assert.ok(r.r2 > 0.999, `expected r2≈1, got ${r.r2}`);
  });

  it("all-equal values → slope 0, r2 0 (flat)", () => {
    const r = linearTrend([7, 7, 7, 7]);
    assert.equal(r.slope, 0);
    assert.equal(r.r2, 0);
    assert.equal(r.intercept, 7);
  });

  it("noisy upward drift → positive slope, modest R² in (0,1)", () => {
    const r = linearTrend([1, 5, 2, 6, 3, 8]);
    assert.ok(r.slope > 0, `expected slope>0, got ${r.slope}`);
    assert.ok(r.r2 > 0 && r.r2 < 1, `expected 0<r2<1, got ${r.r2}`);
  });

  it("single value → slope 0, intercept = the value", () => {
    const r = linearTrend([42]);
    assert.deepEqual(r, { slope: 0, intercept: 42, r2: 0 });
  });

  it("two values → exact slope", () => {
    const r = linearTrend([3, 9]);
    assert.equal(r.slope, 6);
    assert.equal(r.intercept, 3);
    assert.equal(r.r2, 1);
  });

  it("empty array → all zero", () => {
    assert.deepEqual(linearTrend([]), { slope: 0, intercept: 0, r2: 0 });
  });

  it("R² is clamped to [0,1]", () => {
    const r = linearTrend([100, -100, 100, -100]);
    assert.ok(r.r2 >= 0 && r.r2 <= 1, `r2 out of range: ${r.r2}`);
  });
});
