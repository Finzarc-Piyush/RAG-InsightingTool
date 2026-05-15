import { describe, expect, it } from "vitest";
import { chartSpecToPivotConfig } from "./chartSpecToPivotConfig";
import type { ChartSpec } from "@/shared/schema";

const minimal = (overrides: Partial<ChartSpec> = {}): ChartSpec =>
  ({
    type: "bar",
    title: "Test",
    x: "Region",
    y: "Sales",
    data: [{ Region: "North", Sales: 1 }],
    ...overrides,
  }) as ChartSpec;

describe("DR18D · chartSpecToPivotConfig", () => {
  it("happy path: chart with x + y → row + value, no series → no columns", () => {
    const out = chartSpecToPivotConfig(minimal());
    expect(out).not.toBeNull();
    expect(out!.config.rows).toEqual(["Region"]);
    expect(out!.config.columns).toEqual([]);
    expect(out!.config.values).toEqual([
      { id: "value", field: "Sales", agg: "sum" },
    ]);
    expect(out!.valueSpecs).toEqual(out!.config.values);
  });

  it("chart with seriesColumn → columns[0] = seriesColumn", () => {
    const out = chartSpecToPivotConfig(minimal({ seriesColumn: "Segment" }));
    expect(out!.config.columns).toEqual(["Segment"]);
    expect(out!.config.rows).toEqual(["Region"]);
  });

  it("returns null when chart.x is missing", () => {
    expect(chartSpecToPivotConfig(minimal({ x: "" }))).toBeNull();
    expect(
      chartSpecToPivotConfig(minimal({ x: undefined as unknown as string })),
    ).toBeNull();
  });

  it("returns null when chart.y is missing", () => {
    expect(chartSpecToPivotConfig(minimal({ y: "" }))).toBeNull();
    expect(
      chartSpecToPivotConfig(minimal({ y: undefined as unknown as string })),
    ).toBeNull();
  });

  it("returns null when chart.data is not an array (heatmap-z-only, etc.)", () => {
    expect(
      chartSpecToPivotConfig(minimal({ data: undefined as unknown as any[] })),
    ).toBeNull();
  });

  it("returns a valid config even when chart.data is empty (lets renderer show 'no rows')", () => {
    const out = chartSpecToPivotConfig(minimal({ data: [] }));
    expect(out).not.toBeNull();
    expect(out!.config.rows).toEqual(["Region"]);
  });

  it("ignores whitespace-only seriesColumn (treats as no series)", () => {
    const out = chartSpecToPivotConfig(minimal({ seriesColumn: "   " }));
    expect(out!.config.columns).toEqual([]);
  });

  it("populates filters/unused as empty arrays (matches PivotUiConfig shape)", () => {
    const out = chartSpecToPivotConfig(minimal())!;
    expect(out.config.filters).toEqual([]);
    expect(out.config.unused).toEqual([]);
  });

  it("returns null when given a falsy chart", () => {
    expect(chartSpecToPivotConfig(null as unknown as ChartSpec)).toBeNull();
    expect(chartSpecToPivotConfig(undefined as unknown as ChartSpec)).toBeNull();
  });
});
