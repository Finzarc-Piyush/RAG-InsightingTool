import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  countDistinctXPoints,
  isDegenerateTrendChart,
  isRenderableChart,
  DEGENERATE_TREND_CHART_TYPES,
} from "../shared/chartValidity.js";

/**
 * Wave W-1PT1 · a trend chart needs MORE THAN ONE point. `chartValidity` is the
 * single shared rule (server finalize + client render) that drops a
 * line/area/scatter chart whose x-axis materializes to < 2 distinct points — a
 * degenerate "single dot" trendline — at ANY granularity (day/week/month/quarter
 * all collapse to one point).
 */

describe("chartValidity · countDistinctXPoints", () => {
  it("counts distinct non-null x values, short-circuiting at 2", () => {
    assert.equal(
      countDistinctXPoints({ x: "m", data: [{ m: "2025-04", v: 1 }] }),
      1,
    );
    assert.equal(
      countDistinctXPoints({
        x: "m",
        data: [
          { m: "2025-04", v: 1 },
          { m: "2025-05", v: 2 },
          { m: "2025-06", v: 3 },
        ],
      }),
      2, // short-circuits — exact count above the threshold is irrelevant
    );
  });

  it("ignores null/undefined x values", () => {
    assert.equal(
      countDistinctXPoints({
        x: "m",
        data: [{ m: null, v: 1 }, { m: "2025-04", v: 2 }, { m: undefined as never, v: 3 }],
      }),
      1,
    );
  });

  it("treats multiple rows sharing one x (multi-series) as ONE point", () => {
    assert.equal(
      countDistinctXPoints({
        x: "m",
        data: [
          { m: "2025-04", series: "A", v: 1 },
          { m: "2025-04", series: "B", v: 2 },
        ],
      }),
      1,
    );
  });

  it("returns Infinity (unevaluable) when data or x is missing", () => {
    assert.equal(countDistinctXPoints({ x: "m" }), Infinity); // no data
    assert.equal(countDistinctXPoints({ data: [{ m: "x" }] }), Infinity); // no x
    assert.equal(countDistinctXPoints({ x: "", data: [{ "": "x" }] }), Infinity); // empty x key
    assert.equal(countDistinctXPoints({ x: "m", data: null }), Infinity);
  });

  it("returns 0 for an empty data array", () => {
    assert.equal(countDistinctXPoints({ x: "m", data: [] }), 0);
  });
});

describe("chartValidity · isDegenerateTrendChart", () => {
  const single = [{ m: "2025-04", v: 678 }];
  const multi = [
    { m: "2025-04", v: 1 },
    { m: "2025-05", v: 2 },
  ];

  it("flags a single-point line / area / scatter as degenerate", () => {
    assert.equal(isDegenerateTrendChart({ type: "line", x: "m", data: single }), true);
    assert.equal(isDegenerateTrendChart({ type: "area", x: "m", data: single }), true);
    assert.equal(isDegenerateTrendChart({ type: "scatter", x: "m", data: single }), true);
  });

  it("flags an EMPTY line/area/scatter as degenerate", () => {
    assert.equal(isDegenerateTrendChart({ type: "line", x: "m", data: [] }), true);
  });

  it("flags a multi-series line collapsing to one x as degenerate", () => {
    assert.equal(
      isDegenerateTrendChart({
        type: "line",
        x: "m",
        data: [
          { m: "2025-04", s: "A", v: 1 },
          { m: "2025-04", s: "B", v: 2 },
        ],
      }),
      true,
    );
  });

  it("does NOT flag a healthy multi-point trend", () => {
    assert.equal(isDegenerateTrendChart({ type: "line", x: "m", data: multi }), false);
    assert.equal(isDegenerateTrendChart({ type: "area", x: "m", data: multi }), false);
    assert.equal(isDegenerateTrendChart({ type: "scatter", x: "m", data: multi }), false);
  });

  it("never flags a single-category BAR or PIE (out of scope)", () => {
    assert.equal(isDegenerateTrendChart({ type: "bar", x: "region", data: single }), false);
    assert.equal(isDegenerateTrendChart({ type: "pie", x: "region", data: single }), false);
  });

  it("never flags an un-materialized chart (data absent → conservative keep)", () => {
    assert.equal(isDegenerateTrendChart({ type: "line", x: "m" }), false);
  });

  it("tolerates null / malformed input", () => {
    assert.equal(isDegenerateTrendChart(null), false);
    assert.equal(isDegenerateTrendChart(undefined), false);
    assert.equal(isDegenerateTrendChart({}), false);
  });

  it("isRenderableChart is the exact inverse", () => {
    assert.equal(isRenderableChart({ type: "line", x: "m", data: single }), false);
    assert.equal(isRenderableChart({ type: "line", x: "m", data: multi }), true);
    assert.equal(isRenderableChart({ type: "bar", x: "region", data: single }), true);
  });

  it("targets exactly line / area / scatter", () => {
    assert.deepEqual([...DEGENERATE_TREND_CHART_TYPES].sort(), ["area", "line", "scatter"]);
  });
});
