import { describe, expect, test } from "vitest";
import { isDegenerateTrendChart, isRenderableChart } from "@/shared/chartValidity";

/**
 * Wave W-1PT1 · the client filters degenerate single-point trendlines out of the
 * dashboard tile list and the chat answer-card list using the SAME predicate the
 * server applies at finalize. This locks that the cross-package shim
 * (`@/shared/chartValidity` → `server/shared/chartValidity`) resolves under the
 * client toolchain, and re-checks the rule from the client's vantage.
 */
describe("chartValidity (client shim) — hide single-point trendlines", () => {
  const single = [{ "Month · Time": "2025-04", "NR (Rs Cr)": 678 }];
  const multi = [
    { "Month · Time": "2025-03", "NR (Rs Cr)": 600 },
    { "Month · Time": "2025-04", "NR (Rs Cr)": 678 },
  ];

  test("a single-point line/area/scatter is degenerate (filtered out)", () => {
    expect(isDegenerateTrendChart({ type: "line", x: "Month · Time", data: single })).toBe(true);
    expect(isDegenerateTrendChart({ type: "area", x: "Month · Time", data: single })).toBe(true);
    expect(isDegenerateTrendChart({ type: "scatter", x: "Month · Time", data: single })).toBe(true);
  });

  test("a healthy multi-point trend renders", () => {
    expect(isRenderableChart({ type: "line", x: "Month · Time", data: multi })).toBe(true);
  });

  test("a single-category bar still renders (out of scope)", () => {
    expect(isRenderableChart({ type: "bar", x: "region", data: [{ region: "East", sales: 5 }] })).toBe(true);
  });

  test("filtering a tile list drops only the degenerate trend", () => {
    const charts = [
      { type: "line", x: "Month · Time", data: single }, // drop
      { type: "line", x: "Month · Time", data: multi }, // keep
      { type: "bar", x: "region", data: [{ region: "East", sales: 5 }] }, // keep
    ];
    const kept = charts.filter(isRenderableChart);
    expect(kept).toHaveLength(2);
    expect(kept[0]).toBe(charts[1]);
    expect(kept[1]).toBe(charts[2]);
  });
});
