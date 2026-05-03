import { describe, expect, it } from "vitest";
import {
  V1_CHART_TYPES,
  V2_MARKS,
  ECHARTS_MARKS,
  isPremiumChartEnabled,
  getAllPremiumChartFlags,
  anyPremiumChartEnabled,
} from "./featureFlags";

describe("featureFlags · catalogs", () => {
  it("V1_CHART_TYPES enumerates the 6 legacy mark types", () => {
    expect([...V1_CHART_TYPES].sort()).toEqual(
      ["area", "bar", "heatmap", "line", "pie", "scatter"].sort(),
    );
  });

  it("V2_MARKS includes every legacy mark plus the v2 catalog", () => {
    for (const t of V1_CHART_TYPES) {
      // 'scatter' (v1) maps to 'point' (v2); 'pie' maps to 'arc';
      // 'heatmap' maps to 'rect'. The original v1 names should also be
      // present except for those 3 renamings — verify by relaxed check.
      const v2HasIt =
        (V2_MARKS as readonly string[]).includes(t) ||
        (t === "scatter" && (V2_MARKS as readonly string[]).includes("point")) ||
        (t === "pie" && (V2_MARKS as readonly string[]).includes("arc")) ||
        (t === "heatmap" && (V2_MARKS as readonly string[]).includes("rect"));
      expect(v2HasIt, `v2 lacks legacy mark "${t}"`).toBe(true);
    }
  });

  it("ECHARTS_MARKS contains only specialty marks (not the simple ones)", () => {
    const simple = ["bar", "line", "area", "point", "arc", "rect"];
    for (const m of simple) {
      expect(ECHARTS_MARKS.has(m as never)).toBe(false);
    }
    expect(ECHARTS_MARKS.has("treemap")).toBe(true);
    expect(ECHARTS_MARKS.has("sankey")).toBe(true);
    expect(ECHARTS_MARKS.has("choropleth")).toBe(true);
  });
});

describe("featureFlags · resolution", () => {
  it("defaults every v1 type to false (legacy renderer)", () => {
    const all = getAllPremiumChartFlags();
    for (const t of V1_CHART_TYPES) {
      expect(all[t]).toBe(false);
    }
  });

  it("isPremiumChartEnabled returns false by default for every type", () => {
    for (const t of V1_CHART_TYPES) {
      expect(isPremiumChartEnabled(t)).toBe(false);
    }
  });

  it("anyPremiumChartEnabled is false when all flags default", () => {
    expect(anyPremiumChartEnabled()).toBe(false);
  });
});
