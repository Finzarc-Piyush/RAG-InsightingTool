import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectRollingWindowIntent } from "../lib/agents/runtime/planArgRepairs.js";

/**
 * Wave W2 · Pins the rolling-window / cumulative intent detector.
 *
 * The detector recognises phrasings that map to Wave W1's
 * `windowAggregations` rather than `perDimension` nested aggregation.
 * Conservative — anything ambiguous returns null so the question goes
 * to the full planner with no automatic repair.
 */

describe("Wave W2 · detectRollingWindowIntent — primary phrasings", () => {
  it("'rolling 4-week average sales' → mean / rows:4 / week", () => {
    const intent = detectRollingWindowIntent("rolling 4-week average sales");
    assert.ok(intent);
    assert.equal(intent!.operation, "mean");
    assert.deepEqual(intent!.frame, { rows: 4 });
    assert.equal(intent!.temporalUnit, "week");
  });

  it("'4-week rolling average' → mean / rows:4 / week", () => {
    const intent = detectRollingWindowIntent("4-week rolling average of revenue");
    assert.ok(intent);
    assert.equal(intent!.operation, "mean");
    assert.deepEqual(intent!.frame, { rows: 4 });
    assert.equal(intent!.temporalUnit, "week");
  });

  it("'trailing 7-day mean' → mean / rows:7 / day", () => {
    const intent = detectRollingWindowIntent("trailing 7-day mean conversion");
    assert.ok(intent);
    assert.equal(intent!.operation, "mean");
    assert.deepEqual(intent!.frame, { rows: 7 });
    assert.equal(intent!.temporalUnit, "day");
  });

  it("'moving average over last 30 days' → mean / rows:30 / day", () => {
    const intent = detectRollingWindowIntent(
      "show me moving average over last 30 days"
    );
    assert.ok(intent);
    assert.equal(intent!.operation, "mean");
    assert.deepEqual(intent!.frame, { rows: 30 });
    assert.equal(intent!.temporalUnit, "day");
  });

  it("'rolling 12-month sum' → sum / rows:12 / month", () => {
    const intent = detectRollingWindowIntent("rolling 12-month sum of sales");
    assert.ok(intent);
    assert.equal(intent!.operation, "sum");
    assert.deepEqual(intent!.frame, { rows: 12 });
    assert.equal(intent!.temporalUnit, "month");
  });
});

describe("Wave W2 · cumulative / running-total / period-to-date", () => {
  it("'cumulative sales by brand' → sum / unbounded preceding / year (default grain)", () => {
    const intent = detectRollingWindowIntent("cumulative sales by brand");
    assert.ok(intent);
    assert.equal(intent!.operation, "sum");
    assert.deepEqual(intent!.frame, { range: "unbounded_preceding" });
    assert.equal(intent!.temporalUnit, "year");
  });

  it("'running total of revenue' → sum / unbounded preceding", () => {
    const intent = detectRollingWindowIntent("running total of revenue");
    assert.ok(intent);
    assert.equal(intent!.operation, "sum");
    assert.deepEqual(intent!.frame, { range: "unbounded_preceding" });
  });

  it("'YTD revenue' → sum / unbounded preceding / year", () => {
    const intent = detectRollingWindowIntent("YTD revenue by region");
    assert.ok(intent);
    assert.equal(intent!.operation, "sum");
    assert.equal(intent!.temporalUnit, "year");
  });

  it("'year-to-date sales' → sum / year", () => {
    const intent = detectRollingWindowIntent("year-to-date sales");
    assert.ok(intent);
    assert.equal(intent!.temporalUnit, "year");
  });

  it("'QTD' → sum / quarter", () => {
    const intent = detectRollingWindowIntent("QTD revenue");
    assert.ok(intent);
    assert.equal(intent!.temporalUnit, "quarter");
  });

  it("'month-to-date' → sum / month", () => {
    const intent = detectRollingWindowIntent("month-to-date sales");
    assert.ok(intent);
    assert.equal(intent!.temporalUnit, "month");
  });
});

describe("Wave W2 · rejections (conservative)", () => {
  it("empty / nullish → null", () => {
    assert.equal(detectRollingWindowIntent(""), null);
    assert.equal(detectRollingWindowIntent(undefined), null);
    assert.equal(detectRollingWindowIntent("   "), null);
  });

  it("plain 'average sales' (no rolling / cumulative cue) → null", () => {
    assert.equal(detectRollingWindowIntent("average sales by region"), null);
  });

  it("'top 10 brands' → null", () => {
    assert.equal(detectRollingWindowIntent("top 10 brands by sales"), null);
  });

  it("N > 365 in a rolling window → null (caps the window size at the schema limit)", () => {
    assert.equal(
      detectRollingWindowIntent("rolling 999-day average"),
      null
    );
  });

  it("'rolling' without a number → null (we need an explicit window size)", () => {
    assert.equal(detectRollingWindowIntent("rolling average sales"), null);
  });
});
