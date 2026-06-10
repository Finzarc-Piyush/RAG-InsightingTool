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

/**
 * Regression: real multi-series charts reach the client in WIDE format —
 * `processChartData`/`pivotLongToWideBar` pivots long→wide so `chart.y`
 * ("Sales") and `chart.seriesColumn` ("Brand") are NOT keys on the rows;
 * the measure lives under each sanitized `seriesKeys` entry. The old config
 * read `chart.y` and produced 0 for every cell (the reported bug). These
 * tests use the wide shape the server actually emits.
 */
const wideChart: ChartSpec = {
  type: "bar",
  title: "Sales by quarter, by brand (wide)",
  x: "Quarter",
  y: "Sales", // measure name — absent from the wide rows
  seriesColumn: "Brand", // original series column — absent from the wide rows
  seriesKeys: ["Marico", "Purite"],
  data: [
    { Quarter: "Q1", Marico: 100, Purite: 60 },
    { Quarter: "Q2", Marico: 110, Purite: 70 },
    { Quarter: "Q3", Marico: 130, Purite: 80 },
  ],
};

describe("chart → pivot integration (wide multi-series)", () => {
  it("maps each series key to its own value spec (not chart.y)", () => {
    const derived = chartSpecToPivotConfig(wideChart)!;
    expect(derived.config.rows).toEqual(["Quarter"]);
    expect(derived.config.columns).toEqual([]);
    expect(derived.valueSpecs.map((v) => v.field)).toEqual([
      "Marico",
      "Purite",
    ]);
  });

  it("produces real (non-zero) values from the wide columns", () => {
    const derived = chartSpecToPivotConfig(wideChart)!;
    const model = buildPivotModel(
      wideChart.data as Record<string, unknown>[],
      derived.config,
      derived.valueSpecs,
      {},
    );
    const flat = flattenPivotTree(model.tree, new Set());
    const q1 = flat.find((r) => r.label === "Q1" && r.kind === "data");
    expect(q1?.values?.flatValues?.["Marico"]).toBe(100);
    expect(q1?.values?.flatValues?.["Purite"]).toBe(60);
    // Grand totals confirm the all-zeros regression is gone.
    expect(model.tree.grandTotal.flatValues?.["Marico"]).toBe(340);
    expect(model.tree.grandTotal.flatValues?.["Purite"]).toBe(210);
  });

  it("falls back to numeric non-x keys when seriesKeys is absent", () => {
    const noKeys: ChartSpec = { ...wideChart, seriesKeys: undefined };
    const derived = chartSpecToPivotConfig(noKeys)!;
    expect(derived.valueSpecs.map((v) => v.field).sort()).toEqual([
      "Marico",
      "Purite",
    ]);
  });
});

/**
 * W1/W2 regression: a computed RATE column (e.g. pjp_adherence_rate) is already
 * aggregated per group in chart.data. The old config summed it ('sum'), which
 * collapsed structural-zero groups to 0 and produced a meaningless grand total.
 * The pivot must DISPLAY the per-group rate ('first' identity agg).
 */
const rateChart: ChartSpec = {
  type: "bar",
  title: "pjp_adherence_rate by ASM",
  x: "ASM",
  y: "pjp_adherence_rate",
  data: [
    { ASM: "North UP", pjp_adherence_rate: 0.39 },
    { ASM: "Kolkata", pjp_adherence_rate: 0.31 },
    { ASM: "Gujarat West", pjp_adherence_rate: 0.06 },
  ],
};

describe("chart → pivot integration (computed rate column)", () => {
  it("uses the identity ('first') agg for a *_rate column, not sum", () => {
    const derived = chartSpecToPivotConfig(rateChart)!;
    expect(derived.valueSpecs[0].agg).toBe("first");
  });

  it("displays each group's computed rate as-is (no re-summing, no 0 collapse)", () => {
    const derived = chartSpecToPivotConfig(rateChart)!;
    const model = buildPivotModel(
      rateChart.data as Record<string, unknown>[],
      derived.config,
      derived.valueSpecs,
      {},
    );
    const flat = flattenPivotTree(model.tree, new Set());
    const north = flat.find((r) => r.label === "North UP" && r.kind === "data");
    expect(north?.values?.flatValues?.["value"]).toBeCloseTo(0.39);
    const guj = flat.find((r) => r.label === "Gujarat West" && r.kind === "data");
    expect(guj?.values?.flatValues?.["value"]).toBeCloseTo(0.06);
  });

  it("resolves the rate field case-insensitively (alias casing drift)", () => {
    // chart.y is lowercase but the data column kept the original alias casing.
    const drift: ChartSpec = {
      ...rateChart,
      y: "pjp_adherence_rate",
      data: [
        { ASM: "A", "PJP Adherence_rate": 0.5 },
        { ASM: "B", "PJP Adherence_rate": 0.2 },
        { ASM: "C", "PJP Adherence_rate": 0.1 },
      ],
    };
    const derived = chartSpecToPivotConfig(drift)!;
    const model = buildPivotModel(
      drift.data as Record<string, unknown>[],
      derived.config,
      derived.valueSpecs,
      {},
    );
    const flat = flattenPivotTree(model.tree, new Set());
    const a = flat.find((r) => r.label === "A" && r.kind === "data");
    expect(a?.values?.flatValues?.["value"]).toBeCloseTo(0.5);
  });

  it("a raw count column (Compliance Visit) still sums", () => {
    const countChart: ChartSpec = {
      type: "bar",
      title: "Compliance Visit by ASM",
      x: "ASM",
      y: "Compliance Visit",
      data: [
        { ASM: "A", "Compliance Visit": 10 },
        { ASM: "A", "Compliance Visit": 20 },
        { ASM: "B", "Compliance Visit": 5 },
      ],
    };
    const derived = chartSpecToPivotConfig(countChart)!;
    expect(derived.valueSpecs[0].agg).toBe("sum");
  });
});
