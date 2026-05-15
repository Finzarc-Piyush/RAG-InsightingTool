import { describe, expect, it } from "vitest";
import type { ChartSpec } from "@/shared/schema";
import { chartSpecToPivotConfig } from "./chartSpecToPivotConfig";
import {
  buildPivotModel,
  flattenPivotTree,
} from "@/lib/pivot/buildPivotModel";

/**
 * Integration coverage for the read-only chart→pivot transformation chain
 * that powers the chat surface's new pivot-view toggle. Tests the pure
 * pipeline (chartSpecToPivotConfig → buildPivotModel → flattenPivotTree)
 * directly so it runs under the existing vitest node environment without
 * needing jsdom or @testing-library — these helpers are what
 * <ChartTilePivotView> wraps.
 */

const sampleChart: ChartSpec = {
  type: "bar",
  title: "Sales by quarter, by brand",
  x: "Quarter",
  y: "Sales",
  seriesColumn: "Brand",
  data: [
    { Quarter: "Q1", Brand: "Marico", Sales: 100 },
    { Quarter: "Q1", Brand: "Purite", Sales: 60 },
    { Quarter: "Q2", Brand: "Marico", Sales: 110 },
    { Quarter: "Q2", Brand: "Purite", Sales: 70 },
    { Quarter: "Q3", Brand: "Marico", Sales: 130 },
    { Quarter: "Q3", Brand: "Purite", Sales: 80 },
  ],
};

describe("chart → pivot integration (read-only view)", () => {
  it("produces a pivot tree with one top-level node per distinct x value", () => {
    const derived = chartSpecToPivotConfig(sampleChart)!;
    const model = buildPivotModel(
      sampleChart.data as Record<string, unknown>[],
      derived.config,
      derived.valueSpecs,
      {},
    );
    expect(model.tree.nodes.length).toBe(3);
    const labels = model.tree.nodes.map((n) => n.label);
    expect(labels).toEqual(["Q1", "Q2", "Q3"]);
  });

  it("uses the seriesColumn to populate column keys", () => {
    const derived = chartSpecToPivotConfig(sampleChart)!;
    const model = buildPivotModel(
      sampleChart.data as Record<string, unknown>[],
      derived.config,
      derived.valueSpecs,
      {},
    );
    expect(model.colField).toBe("Brand");
    expect(model.colKeys).toEqual(expect.arrayContaining(["Marico", "Purite"]));
  });

  it("flattens to one data row per distinct x value plus a grand-total row", () => {
    // Single row field → tree nodes are leaves, not groups. The flat output
    // is one 'data' row per leaf plus a grand-total row at the bottom.
    const derived = chartSpecToPivotConfig(sampleChart)!;
    const model = buildPivotModel(
      sampleChart.data as Record<string, unknown>[],
      derived.config,
      derived.valueSpecs,
      {},
    );
    const flat = flattenPivotTree(model.tree, new Set());
    const dataRows = flat.filter((r) => r.kind === "data");
    expect(dataRows.length).toBe(3);
    expect(flat.some((r) => r.kind === "grand")).toBe(true);
  });

  it("nested row dimensions produce expandable groups that collapse to a single row", () => {
    // Add a second row dimension so the tree has actual groups to collapse —
    // mirrors what the chat surface produces when users drill into a finer
    // breakdown.
    const derived = chartSpecToPivotConfig(sampleChart)!;
    const twoRowConfig = {
      ...derived.config,
      rows: ["Quarter", "Brand"],
    };
    const model = buildPivotModel(
      sampleChart.data as Record<string, unknown>[],
      twoRowConfig,
      derived.valueSpecs,
      {},
    );
    const expanded = flattenPivotTree(model.tree, new Set());
    const allTopLevel = new Set<string>(model.tree.nodes.map((n) => n.pathKey));
    const collapsed = flattenPivotTree(model.tree, allTopLevel);
    // Collapsing every top-level group strictly shrinks the visible row set.
    expect(collapsed.length).toBeLessThan(expanded.length);
    expect(collapsed.some((r) => r.kind === "collapsed")).toBe(true);
  });

  it("renders rows-only layout when chart has no seriesColumn", () => {
    const noSeries: ChartSpec = { ...sampleChart, seriesColumn: undefined };
    const derived = chartSpecToPivotConfig(noSeries)!;
    expect(derived.config.columns).toEqual([]);
    const model = buildPivotModel(
      noSeries.data as Record<string, unknown>[],
      derived.config,
      derived.valueSpecs,
      {},
    );
    expect(model.tree.nodes.length).toBe(3);
    expect(model.colField).toBeNull();
  });

  it("respects an explicit pre-filtered data subset (modal pre-filter path)", () => {
    const derived = chartSpecToPivotConfig(sampleChart)!;
    const onlyMarico = (sampleChart.data as Record<string, unknown>[]).filter(
      (r) => r.Brand === "Marico",
    );
    const model = buildPivotModel(
      onlyMarico,
      derived.config,
      derived.valueSpecs,
      {},
    );
    expect(model.tree.nodes.length).toBe(3); // still 3 quarters
    expect(model.colKeys).toContain("Marico");
    expect(model.colKeys).not.toContain("Purite");
  });
});
