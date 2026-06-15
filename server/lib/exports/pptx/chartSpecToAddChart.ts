/**
 * W-EXP-6 · Translate `ChartSpec` to a pptxgenjs `addChart` invocation.
 *
 * Implements the `ChartRenderer` callback consumed by ChartWithInsight /
 * TwoChartCompare layouts. Returns true when it placed a NATIVE chart on
 * the slide; false when the type isn't supported (caller falls back to
 * SVG → image).
 *
 * Why native: pptxgenjs's `addChart` ships an embedded XLSX inside the
 * .pptx that PowerPoint, Keynote, and Google Slides all open as a real
 * editable chart. The recipient can right-click → Edit Data, recolour to
 * brand, swap an axis. That is the entire point of doing exports right;
 * raster screenshots can't do this.
 *
 * Currently native: bar, line, area, pie, scatter.
 * Falls back to SVG: heatmap (no native PowerPoint heatmap), and any
 * future chart type until explicitly mapped.
 */
import { PPTX_BRAND, PPTX_FONT } from "./master.js";
import { PPTX_CHART_TYPE } from "./types.js";
import type { PptxRectShape } from "./types.js";
import type { ChartSpec } from "../../../shared/schema.js";
import { formatPeriodKeyForDisplay } from "../../dateUtils.js";
import {
  cartesianSeries,
  scatterSeries,
  readNum,
  type CartesianSeries,
  type ScatterSeries,
} from "../chartSpecSeries.js";

interface AddChartTarget {
  addChart: (chartType: unknown, data: unknown, options: Partial<PptxRectShape> & Record<string, unknown>) => unknown;
}

function buildCartesianSeries(spec: ChartSpec): CartesianSeries[] {
  return [cartesianSeries(spec.data ?? [], spec.x, spec.y, spec.yLabel ?? spec.y)];
}

function buildScatterSeries(spec: ChartSpec): ScatterSeries[] {
  return [scatterSeries(spec.data ?? [], spec.x, spec.y, spec.yLabel ?? spec.y)];
}

function buildPieSeries(spec: ChartSpec): CartesianSeries[] {
  const data = spec.data ?? [];
  const labels = data.map((r) => formatPeriodKeyForDisplay(r[spec.x]));
  const values = data.map((r) => readNum(r[spec.y]) ?? 0);
  return [
    {
      name: spec.yLabel ?? spec.y,
      labels,
      values,
    },
  ];
}

const SHARED_CHART_OPTS: Record<string, unknown> = {
  chartColors: PPTX_BRAND.categorical,
  showLegend: false,
  showTitle: false,
  // Axis text styling — pptxgenjs accepts these per-axis when applicable.
  catAxisLabelFontFace: PPTX_FONT,
  catAxisLabelFontSize: 10,
  catAxisLabelColor: PPTX_BRAND.foreground,
  valAxisLabelFontFace: PPTX_FONT,
  valAxisLabelFontSize: 10,
  valAxisLabelColor: PPTX_BRAND.foreground,
  dataLabelFontFace: PPTX_FONT,
  dataLabelColor: PPTX_BRAND.foreground,
  // Grid — subtle dashed horizontal lines, no vertical grid.
  valGridLine: { style: "dash", size: 0.5, color: PPTX_BRAND.border },
  catGridLine: { style: "none" },
};

/**
 * Place a native pptxgenjs chart for `spec` inside `bounds` on `target`.
 * Returns true on success, false when the type isn't supported.
 */
export function chartSpecToAddChart(
  spec: ChartSpec,
  target: AddChartTarget,
  bounds: PptxRectShape
): boolean {
  const data = spec.data ?? [];
  if (data.length === 0) return false;

  const baseOpts = { ...bounds, ...SHARED_CHART_OPTS };

  switch (spec.type) {
    case "bar": {
      target.addChart(PPTX_CHART_TYPE.bar, buildCartesianSeries(spec), {
        ...baseOpts,
        barDir: "col", // vertical bars by default
        barGrouping: spec.barLayout === "stacked" ? "stacked" : "clustered",
      });
      return true;
    }
    case "line": {
      target.addChart(PPTX_CHART_TYPE.line, buildCartesianSeries(spec), {
        ...baseOpts,
        lineSmooth: false,
        lineDataSymbol: "circle",
        lineDataSymbolSize: 6,
      });
      return true;
    }
    case "area": {
      target.addChart(PPTX_CHART_TYPE.area, buildCartesianSeries(spec), baseOpts);
      return true;
    }
    case "pie": {
      target.addChart(PPTX_CHART_TYPE.pie, buildPieSeries(spec), {
        ...baseOpts,
        showPercent: true,
        dataLabelPosition: "outEnd",
      });
      return true;
    }
    case "scatter": {
      target.addChart(PPTX_CHART_TYPE.scatter, buildScatterSeries(spec), {
        ...baseOpts,
        lineSize: 0,
      });
      return true;
    }
    case "heatmap":
      // No native heatmap in pptxgenjs — caller falls back to SVG → image.
      return false;
    default: {
      const _exhaustive: never = spec.type;
      void _exhaustive;
      return false;
    }
  }
}
