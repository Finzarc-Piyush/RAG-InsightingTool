import { describe, expect, it } from "vitest";
import { __test__ } from "./InteractiveChartCard";
import type { ChartSpec, ChartSpecV2 } from "@/shared/schema";

const baseBar: ChartSpec = {
  type: "bar",
  title: "t",
  x: "month",
  y: "revenue",
  seriesColumn: "region",
  seriesKeys: ["A", "B", "C"],
  barLayout: "stacked",
};

describe("coerceMarkType", () => {
  it("is a no-op when next === current", () => {
    const out = __test__.coerceMarkType(baseBar, "bar");
    expect(out).toBe(baseBar);
  });

  it("strips barLayout when leaving bar", () => {
    const out = __test__.coerceMarkType(baseBar, "line");
    expect(out.type).toBe("line");
    expect(out.barLayout).toBeUndefined();
    expect(out.x).toBe("month");
    expect(out.y).toBe("revenue");
    expect(out.seriesColumn).toBe("region");
    expect(out.seriesKeys).toEqual(["A", "B", "C"]);
  });

  it("preserves barLayout when staying within bar->bar (already covered by no-op)", () => {
    const out = __test__.coerceMarkType({ ...baseBar }, "bar");
    expect(out.barLayout).toBe("stacked");
  });

  it("does not invent barLayout when entering bar from line", () => {
    const lineSpec: ChartSpec = { ...baseBar, type: "line" };
    delete (lineSpec as Partial<ChartSpec>).barLayout;
    const out = __test__.coerceMarkType(lineSpec, "bar");
    expect(out.type).toBe("bar");
    expect(out.barLayout).toBeUndefined();
  });
});

describe("chartIdentityKey", () => {
  it("returns the same key for two structurally identical v1 specs handed back as different object refs", () => {
    const a = __test__.chartIdentityKey({ ...baseBar });
    const b = __test__.chartIdentityKey({ ...baseBar });
    expect(a).toBe(b);
  });

  it("ignores fields that the toolbar is allowed to mutate (barLayout)", () => {
    const a = __test__.chartIdentityKey({ ...baseBar, barLayout: "stacked" });
    const b = __test__.chartIdentityKey({ ...baseBar, barLayout: "grouped" });
    expect(a).toBe(b);
  });

  it("changes when the encoding meaningfully differs (different y)", () => {
    const a = __test__.chartIdentityKey({ ...baseBar });
    const b = __test__.chartIdentityKey({ ...baseBar, y: "profit" });
    expect(a).not.toBe(b);
  });

  it("changes when seriesKeys change (multi-series identity)", () => {
    const a = __test__.chartIdentityKey({ ...baseBar });
    const b = __test__.chartIdentityKey({ ...baseBar, seriesKeys: ["A", "B"] });
    expect(a).not.toBe(b);
  });

  it("changes when seriesColumn changes (single-series-via-grouping identity)", () => {
    const a = __test__.chartIdentityKey({ ...baseBar, seriesColumn: "region" });
    const b = __test__.chartIdentityKey({ ...baseBar, seriesColumn: "channel" });
    expect(a).not.toBe(b);
  });

  it("changes when data length changes (catches partial→updated emissions)", () => {
    const a = __test__.chartIdentityKey({ ...baseBar, data: [] });
    const b = __test__.chartIdentityKey({
      ...baseBar,
      data: [{ month: "2024-01", revenue: 10 }],
    });
    expect(a).not.toBe(b);
  });

  it("is stable when only the data array reference changes (same length)", () => {
    const rows = [{ month: "2024-01", revenue: 10 }];
    const a = __test__.chartIdentityKey({ ...baseBar, data: rows });
    const b = __test__.chartIdentityKey({ ...baseBar, data: [...rows] });
    expect(a).toBe(b);
  });
});

describe("canShowPivotToggle", () => {
  const baseWithData: ChartSpec = {
    ...baseBar,
    data: [
      { month: "2024-01", revenue: 10, region: "A" },
      { month: "2024-02", revenue: 12, region: "B" },
    ],
  };

  it("returns true for a v1 chart with x, y, and non-empty data", () => {
    expect(__test__.canShowPivotToggle(baseWithData)).toBe(true);
  });

  it("returns false when chart is null", () => {
    expect(__test__.canShowPivotToggle(null)).toBe(false);
  });

  it("returns false for v2 specs (pivot pipeline doesn't traverse them)", () => {
    const v2: ChartSpecV2 = {
      version: 2,
      mark: "bar",
      title: "v2",
      data: { rows: [] },
      encoding: { x: { field: "month" }, y: { field: "revenue" } },
    } as unknown as ChartSpecV2;
    expect(__test__.canShowPivotToggle(v2)).toBe(false);
  });

  it("returns false when data array is empty (streaming pre-data state)", () => {
    expect(__test__.canShowPivotToggle({ ...baseWithData, data: [] })).toBe(false);
  });

  it("returns false when chart is missing y (chartSpecToPivotConfig null)", () => {
    expect(
      __test__.canShowPivotToggle({
        ...baseWithData,
        y: "" as ChartSpec["y"],
      }),
    ).toBe(false);
  });

  it("returns false when chart.data is undefined", () => {
    const { data: _omit, ...withoutData } = baseWithData;
    expect(__test__.canShowPivotToggle(withoutData as ChartSpec)).toBe(false);
  });
});
