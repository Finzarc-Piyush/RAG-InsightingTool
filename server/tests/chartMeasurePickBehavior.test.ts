/**
 * Behavioral coverage for the shared x/y axis-pick heuristics used by the
 * deterministic table→chart builders
 * (server/lib/agents/runtime/chartMeasurePick.ts). Pure module, zero deps —
 * hermetic.
 *
 * isNumericishOnSample splits a result table's columns into numeric measures
 * vs categorical dimensions; scoreMeasure ranks numeric columns by how
 * measure-like their NAME is so the y-axis prefers a computed rate/aggregate
 * over raw helper columns. We assert the real ranking order and the
 * boolean-indicator guard (the very drift this module was hoisted to prevent).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isNumericishOnSample,
  scoreMeasure,
} from "../lib/agents/runtime/chartMeasurePick.js";

describe("isNumericishOnSample", () => {
  it("is true for a column of plain numbers", () => {
    const sample = [{ sales: 10 }, { sales: 20 }];
    assert.equal(isNumericishOnSample("sales", sample), true);
  });

  it("is true for numeric-looking strings after stripping %/commas", () => {
    assert.equal(isNumericishOnSample("rate", [{ rate: "12.5%" }]), true);
    assert.equal(isNumericishOnSample("rev", [{ rev: "1,200" }]), true);
  });

  it("is false for a categorical / non-numeric column", () => {
    const sample = [{ region: "West" }, { region: "East" }];
    assert.equal(isNumericishOnSample("region", sample), false);
  });

  it("skips null/empty cells and decides on the first numeric cell within the cap", () => {
    const sample = [
      { v: null },
      { v: "" },
      { v: 42 }, // first real value
    ];
    assert.equal(isNumericishOnSample("v", sample), true);
  });

  it("only scans the first 20 cells (a number past the cap is not seen)", () => {
    // 20 blanks, then a number at index 20 → beyond the cap, so still not numeric.
    const sample = Array.from({ length: 20 }, () => ({ v: "" as unknown }));
    sample.push({ v: 99 });
    assert.equal(isNumericishOnSample("v", sample), false);
  });

  it("is false on an empty sample", () => {
    assert.equal(isNumericishOnSample("v", []), false);
  });
});

describe("scoreMeasure", () => {
  it("ranks a computed rate/share alias above raw aggregates", () => {
    assert.ok(scoreMeasure("pjp_adherence_rate") > scoreMeasure("revenue_sum"));
    assert.ok(scoreMeasure("conversion_ratio") > scoreMeasure("orders_count"));
    assert.ok(scoreMeasure("market_share") > scoreMeasure("units_total"));
  });

  it("orders the aggregate families: sum > avg > count > min/max > total", () => {
    const sum = scoreMeasure("revenue_sum");
    const avg = scoreMeasure("price_avg");
    const count = scoreMeasure("orders_count");
    const min = scoreMeasure("temp_min");
    const total = scoreMeasure("units_total");
    assert.ok(sum > avg, "sum > avg");
    assert.ok(avg > count, "avg > count");
    assert.ok(count > min, "count > min");
    assert.ok(min > total, "min > total");
  });

  it("forces double-underscore countIf helper columns below everything", () => {
    // The numerator/denominator helpers must never win the y-axis over the rate.
    assert.equal(scoreMeasure("adherence__matching"), -1);
    assert.equal(scoreMeasure("adherence__total"), -1);
    assert.ok(scoreMeasure("adherence_rate") > scoreMeasure("adherence__matching"));
  });

  it("does NOT penalize single-underscore user aliases like revenue_total", () => {
    // `_total` (single underscore) is a legitimate measure, scored above 0.
    assert.ok(scoreMeasure("revenue_total") > -1);
    assert.equal(scoreMeasure("revenue_total"), 1);
  });

  it("scores a plain numeric name with no recognizable suffix as 0", () => {
    assert.equal(scoreMeasure("value"), 0);
    assert.equal(scoreMeasure("x"), 0);
  });
});
