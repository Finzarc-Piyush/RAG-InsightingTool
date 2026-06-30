/**
 * Translate a `ChartSpec` to a native pptxgenjs `addChart` invocation.
 *
 * Native is the DEFAULT chart path because it renders in every viewer
 * (PowerPoint, Keynote, Google Slides) AND ships an embedded XLSX so the
 * recipient can right-click → Edit Data / recolour — the whole point of doing
 * analytical exports right. This builder makes native charts actually look
 * clean: MULTI-SERIES (grouped/stacked bars, multi-line) via `pivotSeries`,
 * data labels with compact number formatting, the brand jewel palette, a
 * legend when there is more than one series, subtle horizontal gridlines, and
 * a doughnut for share charts.
 *
 * Returns true when it placed a native chart; false when the type/shape isn't
 * natively renderable (heatmap; dual-axis `y2`) — the caller falls back to the
 * SVG renderer.
 */
import { PPTX_BRAND, PPTX_FONT } from "./master.js";
import { PPTX_CHART_TYPE } from "./types.js";
import type { PptxRectShape } from "./types.js";
import type { ChartSpec } from "../../../shared/schema.js";
import { pivotSeries } from "../chartSpecSeries.js";
import { scatterSeries } from "../chartSpecSeries.js";
import { inferColumnFormat } from "../numberFormatExport.js";
import {
  finiteOrZero,
  sanitizeValues,
  maxFiniteAbs,
  safeLabel,
  safeSeriesName,
  isDegenerateNative,
} from "./chartValueSanitize.js";

interface AddChartTarget {
  addChart: (chartType: unknown, data: unknown, options: Partial<PptxRectShape> & Record<string, unknown>) => unknown;
}

type NativeSeries = { name: string; labels: string[]; values: number[] };

/** Excel number-format code for data labels / value axis, from column + magnitude. */
function formatCodeFor(values: number[], columnName: string | undefined): string {
  const kind = inferColumnFormat(columnName);
  const maxAbs = maxFiniteAbs(values);
  if (kind === "percent") return maxAbs <= 1 ? "0.0%" : '#,##0.0"%"';
  if (maxAbs >= 1000) return '[>=1000000]#,##0.0,,"M";[>=1000]#,##0.0,"K";#,##0';
  return "#,##0.##";
}

function commonOpts(
  bounds: PptxRectShape,
  opts: { multi: boolean; valFmt: string; legendPos?: string }
): Record<string, unknown> {
  return {
    ...bounds,
    chartColors: PPTX_BRAND.categorical,
    showTitle: false,
    showLegend: opts.multi,
    legendPos: opts.legendPos ?? "t",
    legendColor: PPTX_BRAND.inkSoft,
    legendFontFace: PPTX_FONT,
    legendFontSize: 10,
    // Axes — muted labels, subtle horizontal gridlines only.
    catAxisLabelColor: PPTX_BRAND.muted,
    catAxisLabelFontFace: PPTX_FONT,
    catAxisLabelFontSize: 10,
    catAxisLineShow: true,
    catGridLine: { style: "none" },
    valAxisLabelColor: PPTX_BRAND.muted,
    valAxisLabelFontFace: PPTX_FONT,
    valAxisLabelFontSize: 10,
    valAxisLabelFormatCode: opts.valFmt,
    valAxisLineShow: false,
    valGridLine: { style: "solid", size: 0.5, color: PPTX_BRAND.gridline },
    // Data labels.
    dataLabelColor: PPTX_BRAND.inkSoft,
    dataLabelFontFace: PPTX_FONT,
    dataLabelFontSize: 9,
    dataLabelFontBold: true,
    dataLabelFormatCode: opts.valFmt,
  };
}

export function chartSpecToAddChart(
  spec: ChartSpec,
  target: AddChartTarget,
  bounds: PptxRectShape
): boolean {
  const data = spec.data ?? [];
  if (data.length === 0) return false;

  // Dual-axis and heatmap have no clean native form — use the SVG path.
  if ((spec as ChartSpec & { y2?: string }).y2) return false;
  if (spec.type === "heatmap") return false;

  const yKey = spec.y;
  const seriesColumn = (spec as ChartSpec & { seriesColumn?: string }).seriesColumn;
  const seriesKeys = (spec as ChartSpec & { seriesKeys?: string[] }).seriesKeys;

  switch (spec.type) {
    case "bar":
    case "line":
    case "area": {
      const pivot = pivotSeries(data, spec.x, yKey, { seriesColumn, seriesKeys, seriesName: spec.yLabel ?? yKey });
      const categories = pivot.categories.map(safeLabel);
      const series: NativeSeries[] = pivot.series.map((s) => ({
        name: safeSeriesName(s.name, spec.yLabel ?? yKey),
        labels: categories,
        values: sanitizeValues(s.values),
      }));
      // Empty / all-zero charts serialize to corrupt OOXML — bail to the
      // caller's placeholder instead of emitting a broken chart part.
      if (isDegenerateNative({ categories, series })) return false;

      const multi = series.length > 1;
      const allVals = series.flatMap((s) => s.values);
      const valFmt = formatCodeFor(allVals, spec.yLabel ?? yKey);
      const totalMarks = categories.length * series.length;
      const showLabels = (spec as ChartSpec & { dataLabels?: boolean }).dataLabels !== false && totalMarks <= 26;
      const stacked = (spec as ChartSpec & { barLayout?: "grouped" | "stacked" }).barLayout === "stacked";
      const base = commonOpts(bounds, { multi, valFmt });

      // A single-point line/area is a meaningless lone dot (the deck's "by Month"
      // single-period chart) — render it as a bar (a clean value callout) instead,
      // reusing the tested bar branch. Honors the in-app single-point suppression
      // on the export path.
      const effectiveBar = spec.type === "bar" || categories.length <= 1;
      if (effectiveBar) {
        target.addChart(PPTX_CHART_TYPE.bar, series, {
          ...base,
          barDir: "col",
          barGrouping: stacked ? "stacked" : "clustered",
          barGapWidthPct: 45,
          barOverlapPct: stacked ? 100 : -12,
          showValue: showLabels,
          dataLabelPosition: stacked ? "ctr" : "outEnd",
        });
      } else {
        target.addChart(spec.type === "area" ? PPTX_CHART_TYPE.area : PPTX_CHART_TYPE.line, series, {
          ...base,
          lineSmooth: false,
          lineSize: 2.5,
          lineDataSymbol: "circle",
          lineDataSymbolSize: 6,
          showValue: showLabels && !multi,
          dataLabelPosition: "t",
        });
      }
      return true;
    }

    case "pie": {
      const labels = data.map((r) => safeLabel(r[spec.x]));
      const values = data.map((r) => finiteOrZero(r[yKey]));
      if (values.every((v) => v === 0)) return false;
      target.addChart(PPTX_CHART_TYPE.doughnut, [{ name: safeSeriesName(spec.yLabel ?? yKey), labels, values }], {
        ...bounds,
        chartColors: PPTX_BRAND.categorical,
        showTitle: false,
        showLegend: true,
        legendPos: "r",
        legendColor: PPTX_BRAND.inkSoft,
        legendFontFace: PPTX_FONT,
        legendFontSize: 10,
        showPercent: true,
        showValue: false,
        dataLabelColor: "FFFFFF",
        dataLabelFontFace: PPTX_FONT,
        dataLabelFontSize: 10,
        dataLabelFontBold: true,
        dataLabelPosition: "ctr",
        holeSize: 58,
      });
      return true;
    }

    case "scatter": {
      const pts = scatterSeries(data, spec.x, spec.y, spec.yLabel ?? spec.y).values;
      if (pts.length < 1) return false;
      const xs = pts.map((p) => finiteOrZero(p[0]));
      const ys = pts.map((p) => finiteOrZero(p[1]));
      target.addChart(
        PPTX_CHART_TYPE.scatter,
        [
          { name: "X", values: xs },
          { name: safeSeriesName(spec.yLabel ?? spec.y), values: ys },
        ],
        {
          ...commonOpts(bounds, { multi: false, valFmt: formatCodeFor(ys, spec.yLabel ?? spec.y) }),
          lineSize: 0,
          lineDataSymbol: "circle",
          lineDataSymbolSize: 7,
        }
      );
      return true;
    }

    default: {
      const _exhaustive: never = spec.type;
      void _exhaustive;
      return false;
    }
  }
}
