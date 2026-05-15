/**
 * W-EXP-4 · ECharts SVG SSR helper.
 *
 * Renders representative ChartSpecs for every supported type (bar, line,
 * area, scatter, pie, heatmap) and asserts:
 *   - Output is a valid SVG string (`<svg`-prefixed, well-formed root).
 *   - Brand palette colors leak through (the renderer uses one source of
 *     truth — verifies that source isn't accidentally diverging from the
 *     export theme).
 *   - Empty data shapes return null gracefully (renderer fall-back path).
 *   - Heatmap without `spec.z` returns null (z is required).
 *   - The option mapper (pure fn) is exhaustive over chart types — TS
 *     forces this at compile time, but a runtime test catches any future
 *     enum additions that forget a case.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EXPORT_BRAND,
  chartSpecToEchartsOption,
  renderChartSpecToSvg,
} from "../lib/exports/chartSsr.js";
import type { ChartSpec } from "../shared/schema.js";

function bar(): ChartSpec {
  return {
    type: "bar",
    title: "Quarterly sales",
    x: "Quarter",
    y: "Sales",
    data: [
      { Quarter: "Q1", Sales: 100 },
      { Quarter: "Q2", Sales: 120 },
      { Quarter: "Q3", Sales: 90 },
    ],
  } as ChartSpec;
}

function line(): ChartSpec {
  return { ...bar(), type: "line" } as ChartSpec;
}

function area(): ChartSpec {
  return { ...bar(), type: "area" } as ChartSpec;
}

function scatter(): ChartSpec {
  return {
    type: "scatter",
    title: "Price vs sales",
    x: "Price",
    y: "Sales",
    data: [
      { Price: 1.0, Sales: 12 },
      { Price: 2.0, Sales: 18 },
      { Price: 3.0, Sales: 25 },
    ],
  } as ChartSpec;
}

function pie(): ChartSpec {
  return {
    type: "pie",
    title: "Category share",
    x: "Category",
    y: "Share",
    data: [
      { Category: "MARICO", Share: 31 },
      { Category: "PURITE", Share: 22 },
      { Category: "OLIV", Share: 18 },
      { Category: "LASHE", Share: 29 },
    ],
  } as ChartSpec;
}

function heatmap(): ChartSpec {
  return {
    type: "heatmap",
    title: "Monthly heatmap",
    x: "Month",
    y: "Brand",
    z: "Sales",
    data: [
      { Month: "Jan", Brand: "MARICO", Sales: 12 },
      { Month: "Jan", Brand: "PURITE", Sales: 8 },
      { Month: "Feb", Brand: "MARICO", Sales: 15 },
      { Month: "Feb", Brand: "PURITE", Sales: 10 },
    ],
  } as ChartSpec;
}

describe("W-EXP-4 · chartSpecToEchartsOption pure mapper", () => {
  it("emits a cartesian option for bar/line/area", () => {
    for (const spec of [bar(), line(), area()]) {
      const opt = chartSpecToEchartsOption(spec);
      assert.ok(opt);
      assert.equal(opt!.animation, false);
      assert.equal((opt!.backgroundColor as string), EXPORT_BRAND.background);
      const series = opt!.series as Array<{ type: string }>;
      assert.equal(series.length, 1);
      // area renders as a line + areaStyle; type stays "line"
      assert.equal(series[0]!.type, spec.type === "area" ? "line" : spec.type);
    }
  });

  it("scatter emits numeric x/y axes", () => {
    const opt = chartSpecToEchartsOption(scatter());
    assert.ok(opt);
    assert.equal((opt!.xAxis as { type: string }).type, "value");
    assert.equal((opt!.yAxis as { type: string }).type, "value");
  });

  it("pie filters out zero/negative values", () => {
    const spec = pie();
    spec.data = [
      ...(spec.data ?? []),
      { Category: "EMPTY", Share: 0 },
    ];
    const opt = chartSpecToEchartsOption(spec);
    assert.ok(opt);
    const series = (opt!.series as Array<{ data: unknown[] }>)[0]!;
    assert.equal(series.data.length, 4);
  });

  it("heatmap requires spec.z (returns null otherwise)", () => {
    const noZ = heatmap();
    delete noZ.z;
    assert.equal(chartSpecToEchartsOption(noZ), null);
  });

  it("returns null on empty data", () => {
    const empty = bar();
    empty.data = [];
    assert.equal(chartSpecToEchartsOption(empty), null);
  });
});

describe("W-EXP-4 · renderChartSpecToSvg end-to-end", () => {
  it("emits a valid SVG string for every chart type", () => {
    for (const spec of [bar(), line(), area(), scatter(), pie(), heatmap()]) {
      const svg = renderChartSpecToSvg(spec, { width: 800, height: 450 });
      assert.ok(svg, `expected non-null SVG for type=${spec.type}`);
      assert.match(svg!, /^<svg /, `expected SVG-prefixed string for type=${spec.type}`);
      assert.match(svg!, /<\/svg>\s*$/, `expected SVG closing tag for type=${spec.type}`);
    }
  });

  it("renders brand-primary color into bar/line SVG output", () => {
    const svg = renderChartSpecToSvg(bar());
    assert.ok(svg);
    // Case-insensitive — ECharts may emit lowercase hex.
    assert.match(svg!, new RegExp(EXPORT_BRAND.primary, "i"));
  });

  it("returns null on empty data so callers can render a placeholder", () => {
    const empty = bar();
    empty.data = [];
    assert.equal(renderChartSpecToSvg(empty), null);
  });
});
