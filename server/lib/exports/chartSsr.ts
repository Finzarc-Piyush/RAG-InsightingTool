/**
 * Server-side ECharts SVG renderer for exports (PPTX images + PDF).
 *
 * Translates a `ChartSpec` into a self-contained, on-brand SVG string. Vector
 * everywhere — sharp at any zoom, the opposite of the rastered-screenshot
 * amateur tell. Pure JS (ECharts SSR `renderer:'svg'`), no native deps, so it
 * stays Vercel-safe.
 *
 * This renderer is intentionally RICH (it is the deck's chart look):
 *   - Multi-series (grouped/stacked bars, multi-line) via `seriesColumn` /
 *     `seriesKeys` — the export reconstructs the in-app chart instead of
 *     collapsing every series into one monochrome bar set.
 *   - A legend when >1 series; per-series colours from the brand jewel ramp.
 *   - Data labels + axis ticks formatted compactly (1.2K / ₫3.4M / 12%).
 *   - Rounded bars, gradient area fills, light horizontal gridlines only,
 *     trimmed/rotated category labels, a non-clipping donut with a centre total,
 *     dual Y axis (`y2`), and a scatter trend line.
 *
 * What it deliberately does NOT do: interactive features (tooltips, hover,
 * drill-through) — static export only.
 */
import * as echarts from "echarts";
import type { ChartSpec } from "../../shared/schema.js";
import { isChartSpecV2 } from "../../shared/schema.js";
import { agentLog } from "../agents/runtime/agentLogger.js";
import { toFiniteNumber } from "../numberCoercion.js";
import { cartesianSeries, scatterSeries, pivotSeries } from "./chartSpecSeries.js";
import { formatPeriodKeyForDisplay } from "../dateUtils.js";
import { EXPORT_HEX, EXPORT_CATEGORICAL_HEX, withHash } from "./brandPalette.js";
import { formatAxisValue, formatCompact, inferColumnFormat } from "./numberFormatExport.js";

/** Brand palette for this renderer ('#'-prefixed for ECharts). */
const EXPORT_BRAND = {
  primary: withHash(EXPORT_HEX.primary),
  accent: withHash(EXPORT_HEX.accent),
  foreground: withHash(EXPORT_HEX.foreground),
  ink: withHash(EXPORT_HEX.foreground),
  inkSoft: withHash(EXPORT_HEX.inkSoft),
  muted: withHash(EXPORT_HEX.muted),
  border: withHash(EXPORT_HEX.border),
  gridline: withHash(EXPORT_HEX.gridline),
  background: withHash(EXPORT_HEX.background),
  categorical: EXPORT_CATEGORICAL_HEX,
};

const FONT_FAMILY = "Inter, ui-sans-serif, system-ui, sans-serif";

const AXIS_LABEL = { color: EXPORT_BRAND.muted, fontFamily: FONT_FAMILY, fontSize: 12 };
const AXIS_NAME = { color: EXPORT_BRAND.inkSoft, fontFamily: FONT_FAMILY, fontSize: 12, fontWeight: 600 as const };
const LABEL_FONT = { fontFamily: FONT_FAMILY, fontSize: 11 };

export interface RenderChartSvgOptions {
  width?: number;
  height?: number;
  /** Suppress the in-chart title (slide layouts draw their own). Default true. */
  suppressTitle?: boolean;
}

export function renderChartSpecToSvg(
  spec: ChartSpec,
  opts: RenderChartSvgOptions = {}
): string | null {
  const width = opts.width ?? 1024;
  const height = opts.height ?? 576;
  // Wave V0 · this renderer is v1-only. A v2 ChartSpecV2 (e.g. a converted or
  // natively-v2 chart that reaches a persisted `charts` array) would otherwise
  // fall through to a silent null → an INVISIBLE gap in a shared PPTX/PDF.
  // Make it loud + visible: log and emit a placeholder rather than nothing.
  // (The real v2→export adapter is a later wave; this is the safety net.)
  if (isChartSpecV2(spec)) {
    agentLog("chartSsr.v2SpecUnsupported", {
      mark: String((spec as { mark?: unknown }).mark ?? ""),
      title: (spec as { config?: { title?: { text?: string } } }).config?.title?.text,
    });
    return placeholderSvg(width, height);
  }
  const option = chartSpecToEchartsOption(spec, opts);
  if (!option) return null;
  const chart = echarts.init(null, null, { renderer: "svg", ssr: true, width, height });
  try {
    chart.setOption(option);
    return chart.renderToSVGString();
  } finally {
    chart.dispose();
  }
}

interface EchartsLikeOption {
  [key: string]: unknown;
}

export function chartSpecToEchartsOption(
  spec: ChartSpec,
  opts: RenderChartSvgOptions = {}
): EchartsLikeOption | null {
  // Wave V0 · v1-only. v2 specs have no `.type` and would hit the `default`
  // branch silently; surface it explicitly so the drop is observable.
  if (isChartSpecV2(spec)) {
    agentLog("chartSsr.v2SpecUnsupported", { mark: String((spec as { mark?: unknown }).mark ?? "") });
    return null;
  }
  const data = spec.data ?? [];
  if (data.length === 0) return null;
  const showTitle = opts.suppressTitle === false;
  switch (spec.type) {
    case "bar":
    case "line":
    case "area":
      return cartesianOption(spec, data, showTitle);
    case "scatter":
      return scatterOption(spec, data, showTitle);
    case "pie":
      return pieOption(spec, data, showTitle);
    case "heatmap":
      return heatmapOption(spec, data, showTitle);
    default: {
      const _exhaustive: never = spec.type;
      void _exhaustive;
      return null;
    }
  }
}

/**
 * Wave V0 · a visible, on-brand "unavailable in this format" tile, drawn when a
 * chart can't be rendered for export (currently: a v2 spec). Beats an invisible
 * gap on a slide a manager is presenting from.
 */
function placeholderSvg(width: number, height: number): string {
  const cx = width / 2;
  const cy = height / 2;
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}">` +
    `<rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="12" ` +
    `fill="${EXPORT_BRAND.background}" stroke="${EXPORT_BRAND.border}" stroke-width="1.5" ` +
    `stroke-dasharray="6 5"/>` +
    `<text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="middle" ` +
    `font-family="${FONT_FAMILY}" font-size="16" font-weight="600" ` +
    `fill="${EXPORT_BRAND.inkSoft}">${esc("Chart not available in this export format")}</text>` +
    `</svg>`
  );
}

type DataRow = Record<string, string | number | null>;

function readNum(row: DataRow, key: string): number | null {
  return toFiniteNumber(row[key]);
}

const color = (i: number): string =>
  EXPORT_BRAND.categorical[i % EXPORT_BRAND.categorical.length] ?? EXPORT_BRAND.primary;

/** Trim a long category label to keep axes readable. */
const trimLabel = (s: string, max = 16): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

function titleBlock(spec: ChartSpec, showTitle: boolean): EchartsLikeOption | undefined {
  if (!showTitle) return undefined;
  return {
    text: spec.title,
    left: 0,
    top: 0,
    textStyle: { color: EXPORT_BRAND.ink, fontFamily: FONT_FAMILY, fontSize: 17, fontWeight: 700 },
  };
}

function cartesianOption(
  spec: ChartSpec,
  data: DataRow[],
  showTitle: boolean
): EchartsLikeOption {
  const xKey = spec.x;
  const yKey = spec.y;
  const seriesColumn = (spec as ChartSpec & { seriesColumn?: string }).seriesColumn;
  const seriesKeys = (spec as ChartSpec & { seriesKeys?: string[] }).seriesKeys;
  const barLayout = (spec as ChartSpec & { barLayout?: "grouped" | "stacked" }).barLayout;
  const stacked = barLayout === "stacked";

  const pivot = pivotSeries(data, xKey, yKey, { seriesColumn, seriesKeys, seriesName: spec.yLabel ?? yKey });
  const categories = pivot.categories.map((c) => String(c));
  const multi = pivot.series.length > 1;
  const isPercent = inferColumnFormat(spec.yLabel ?? yKey) === "percent";

  const maxLen = categories.reduce((m, c) => Math.max(m, c.length), 0);
  const rotate = categories.length > 8 || maxLen > 9 ? 32 : 0;

  // Only label bars when the count is modest (else clutter).
  const totalMarks = categories.length * pivot.series.length;
  const showBarLabels = (spec as ChartSpec & { dataLabels?: boolean }).dataLabels !== false && totalMarks <= 26;

  const baseType = spec.type === "area" ? "line" : spec.type;
  const labelFmt = (p: { value: number | null }): string =>
    p.value === null || p.value === undefined ? "" : formatCompact(Number(p.value), { percent: isPercent });

  const series: EchartsLikeOption[] = pivot.series.map((s, i) => {
    const c = color(i);
    const common: EchartsLikeOption = { name: s.name, data: s.values };
    if (baseType === "bar") {
      return {
        ...common,
        type: "bar",
        stack: stacked ? "total" : undefined,
        barMaxWidth: multi ? 34 : 56,
        itemStyle: { color: c, borderRadius: stacked ? 0 : [3, 3, 0, 0] },
        label: {
          show: showBarLabels,
          position: stacked ? "inside" : "top",
          color: stacked ? "#fff" : EXPORT_BRAND.inkSoft,
          ...LABEL_FONT,
          fontWeight: 600,
          formatter: labelFmt,
        },
      };
    }
    // line / area
    return {
      ...common,
      type: "line",
      smooth: false,
      symbol: "circle",
      symbolSize: categories.length > 24 ? 0 : 6,
      lineStyle: { color: c, width: 2.6 },
      itemStyle: { color: c },
      ...(spec.type === "area"
        ? {
            areaStyle: {
              opacity: 1,
              color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                { offset: 0, color: hexA(c, 0.28) },
                { offset: 1, color: hexA(c, 0.02) },
              ]),
            },
          }
        : {}),
      label: {
        show: !multi && showBarLabels,
        position: "top",
        color: EXPORT_BRAND.inkSoft,
        ...LABEL_FONT,
        fontWeight: 600,
        formatter: labelFmt,
      },
    };
  });

  // Optional secondary axis (single y2 series).
  const y2Key = (spec as ChartSpec & { y2?: string }).y2;
  let yAxis: EchartsLikeOption | EchartsLikeOption[] = buildValueAxis(spec.yLabel ?? yKey, spec.yDomain, isPercent);
  if (y2Key) {
    const y2Series = cartesianSeries(data, xKey, y2Key, spec.y2Label ?? y2Key);
    series.push({
      name: spec.y2Label ?? y2Key,
      type: "line",
      yAxisIndex: 1,
      data: y2Series.values,
      smooth: false,
      symbol: "circle",
      symbolSize: 6,
      lineStyle: { color: EXPORT_BRAND.accent, width: 2.6, type: "dashed" },
      itemStyle: { color: EXPORT_BRAND.accent },
    } as EchartsLikeOption);
    yAxis = [
      buildValueAxis(spec.yLabel ?? yKey, spec.yDomain, isPercent),
      buildValueAxis(spec.y2Label ?? y2Key, undefined, inferColumnFormat(spec.y2Label ?? y2Key) === "percent", true),
    ];
  }

  const showLegend = multi || !!y2Key;
  return {
    animation: false,
    backgroundColor: EXPORT_BRAND.background,
    textStyle: { fontFamily: FONT_FAMILY, color: EXPORT_BRAND.ink },
    title: titleBlock(spec, showTitle),
    legend: legendBlock(showLegend, showTitle),
    grid: {
      left: 6,
      right: y2Key ? 14 : 18,
      top: (showLegend ? 40 : 26) + (showTitle ? 26 : 0),
      bottom: rotate ? 18 : 6,
      containLabel: true,
    },
    xAxis: {
      type: "category",
      data: categories,
      name: spec.xLabel && spec.xLabel !== xKey ? spec.xLabel : undefined,
      nameLocation: "middle",
      nameGap: rotate ? 48 : 30,
      nameTextStyle: AXIS_NAME,
      boundaryGap: true,
      axisLabel: {
        ...AXIS_LABEL,
        // No hardcoded category threshold: let ECharts thin labels by actual
        // rendered overlap (area-aware), the same way the on-screen charts do.
        // When everything fits, "auto" still shows every label.
        interval: "auto",
        hideOverlap: true,
        rotate,
        formatter: (v: string) => trimLabel(String(v)),
      },
      axisTick: { show: false },
      axisLine: { lineStyle: { color: EXPORT_BRAND.border } },
    },
    yAxis,
    series,
  };
}

function buildValueAxis(
  label: string,
  domain: readonly [number, number] | undefined,
  isPercent: boolean,
  secondary = false
): EchartsLikeOption {
  return {
    type: "value",
    name: label,
    nameLocation: "end",
    nameGap: 12,
    nameTextStyle: { ...AXIS_NAME, align: secondary ? "right" : "left" },
    min: domain?.[0],
    max: domain?.[1],
    axisLabel: { ...AXIS_LABEL, formatter: (v: number) => formatAxisValue(v, isPercent ? "%" : undefined) },
    axisLine: { show: false },
    axisTick: { show: false },
    splitLine: { show: !secondary, lineStyle: { color: EXPORT_BRAND.gridline } },
  };
}

function legendBlock(show: boolean, showTitle: boolean): EchartsLikeOption {
  // Top-RIGHT so it never collides with the top-left y-axis unit label.
  return {
    show,
    top: showTitle ? 26 : 4,
    right: 0,
    icon: "roundRect",
    itemWidth: 11,
    itemHeight: 11,
    itemGap: 18,
    textStyle: { color: EXPORT_BRAND.inkSoft, fontFamily: FONT_FAMILY, fontSize: 12 },
  };
}

function scatterOption(spec: ChartSpec, data: DataRow[], showTitle: boolean): EchartsLikeOption {
  const points = scatterSeries(data, spec.x, spec.y, spec.yLabel ?? spec.y).values;
  const series: EchartsLikeOption[] = [
    {
      type: "scatter",
      data: points,
      symbolSize: 9,
      itemStyle: { color: hexA(EXPORT_BRAND.primary, 0.62), borderColor: EXPORT_BRAND.primary, borderWidth: 0.6 },
    },
  ];
  // Optional trend line (two endpoints given by the spec).
  const trend = (spec as ChartSpec & { trendLine?: Array<Record<string, number | string>> }).trendLine;
  if (trend && trend.length >= 2) {
    const tp = trend
      .map((p) => [toFiniteNumber(p[spec.x]), toFiniteNumber(p[spec.y])])
      .filter((p): p is [number, number] => p[0] !== null && p[1] !== null);
    if (tp.length >= 2) {
      series.push({
        type: "line",
        data: tp,
        symbol: "none",
        lineStyle: { color: EXPORT_BRAND.accent, width: 2.4, type: "dashed" },
        z: 1,
      });
    }
  }
  return {
    animation: false,
    backgroundColor: EXPORT_BRAND.background,
    textStyle: { fontFamily: FONT_FAMILY, color: EXPORT_BRAND.ink },
    title: titleBlock(spec, showTitle),
    grid: { left: 6, right: 18, top: showTitle ? 44 : 30, bottom: 8, containLabel: true },
    xAxis: {
      type: "value",
      name: spec.xLabel ?? spec.x,
      nameLocation: "middle",
      nameGap: 30,
      nameTextStyle: AXIS_NAME,
      min: spec.xDomain?.[0],
      max: spec.xDomain?.[1],
      axisLabel: { ...AXIS_LABEL, formatter: (v: number) => formatAxisValue(v, spec.xLabel) },
      axisLine: { lineStyle: { color: EXPORT_BRAND.border } },
      axisTick: { show: false },
      splitLine: { lineStyle: { color: EXPORT_BRAND.gridline } },
    },
    yAxis: buildValueAxis(spec.yLabel ?? spec.y, spec.yDomain, inferColumnFormat(spec.yLabel ?? spec.y) === "percent"),
    series,
  };
}

function pieOption(spec: ChartSpec, data: DataRow[], showTitle: boolean): EchartsLikeOption {
  const slices = data
    .map((r) => ({ name: String(r[spec.x] ?? ""), value: readNum(r, spec.y) ?? 0 }))
    .filter((s) => s.value > 0)
    .sort((a, b) => b.value - a.value);
  const total = slices.reduce((a, s) => a + s.value, 0);
  const isPercent = inferColumnFormat(spec.yLabel ?? spec.y) === "percent";
  const centerVal = isPercent ? "100%" : formatCompact(total);

  return {
    animation: false,
    backgroundColor: EXPORT_BRAND.background,
    textStyle: { fontFamily: FONT_FAMILY, color: EXPORT_BRAND.ink },
    color: EXPORT_BRAND.categorical,
    title: [
      ...(showTitle ? [titleBlock(spec, true) as EchartsLikeOption] : []),
      // Centre total inside the donut hole.
      {
        text: centerVal,
        subtext: "Total",
        left: "34%",
        top: "44%",
        textAlign: "center",
        textStyle: { color: EXPORT_BRAND.ink, fontFamily: FONT_FAMILY, fontSize: 22, fontWeight: 700 },
        subtextStyle: { color: EXPORT_BRAND.muted, fontFamily: FONT_FAMILY, fontSize: 11 },
      },
    ],
    legend: {
      orient: "vertical",
      right: "3%",
      top: "middle",
      icon: "roundRect",
      itemWidth: 11,
      itemHeight: 11,
      itemGap: 12,
      formatter: (name: string) => trimLabel(name, 22),
      textStyle: { color: EXPORT_BRAND.inkSoft, fontFamily: FONT_FAMILY, fontSize: 12 },
    },
    series: [
      {
        type: "pie",
        radius: ["46%", "72%"],
        center: ["34%", "54%"],
        avoidLabelOverlap: true,
        itemStyle: { borderColor: "#fff", borderWidth: 2 },
        label: {
          show: true,
          position: "inside",
          formatter: (p: { percent: number }) => (p.percent >= 6 ? `${Math.round(p.percent)}%` : ""),
          color: "#fff",
          fontFamily: FONT_FAMILY,
          fontSize: 11,
          fontWeight: 700,
        },
        labelLine: { show: false },
        data: slices,
      },
    ],
  };
}

function heatmapOption(spec: ChartSpec, data: DataRow[], showTitle: boolean): EchartsLikeOption | null {
  if (!spec.z) return null;
  const xCats = Array.from(new Set(data.map((r) => String(r[spec.x] ?? ""))));
  const yCats = Array.from(new Set(data.map((r) => String(r[spec.y] ?? ""))));
  const xIdx = new Map(xCats.map((v, i) => [v, i]));
  const yIdx = new Map(yCats.map((v, i) => [v, i]));
  const cells = data
    .map((r) => {
      const x = xIdx.get(String(r[spec.x] ?? ""));
      const y = yIdx.get(String(r[spec.y] ?? ""));
      const z = readNum(r, spec.z!);
      if (x === undefined || y === undefined || z === null) return null;
      return [x, y, z] as [number, number, number];
    })
    .filter((c): c is [number, number, number] => c !== null);
  const zValues = cells.map((c) => c[2]);
  const min = Math.min(...zValues, 0);
  const max = Math.max(...zValues, 1);
  return {
    animation: false,
    backgroundColor: EXPORT_BRAND.background,
    textStyle: { fontFamily: FONT_FAMILY, color: EXPORT_BRAND.ink },
    title: titleBlock(spec, showTitle),
    grid: { left: 6, right: 18, top: showTitle ? 38 : 14, bottom: 44, containLabel: true },
    xAxis: {
      type: "category",
      data: xCats,
      axisLabel: { ...AXIS_LABEL, formatter: (v: string) => trimLabel(String(v)) },
      axisTick: { show: false },
      axisLine: { lineStyle: { color: EXPORT_BRAND.border } },
      splitArea: { show: true },
    },
    yAxis: {
      type: "category",
      data: yCats,
      axisLabel: { ...AXIS_LABEL, formatter: (v: string) => trimLabel(String(v)) },
      axisTick: { show: false },
      axisLine: { show: false },
      splitArea: { show: true },
    },
    visualMap: {
      min,
      max,
      calculable: false,
      orient: "horizontal",
      left: "center",
      bottom: 2,
      itemWidth: 14,
      itemHeight: 90,
      // Sequential single-hue ramp — light navy → deep navy (more = darker).
      inRange: { color: ["#DCE5F0", EXPORT_BRAND.primary] },
      textStyle: { color: EXPORT_BRAND.muted, fontFamily: FONT_FAMILY, fontSize: 11 },
    },
    series: [
      {
        type: "heatmap",
        data: cells,
        label: { show: false },
        itemStyle: { borderColor: "#fff", borderWidth: 1 },
        emphasis: { itemStyle: { borderColor: EXPORT_BRAND.ink } },
      },
    ],
  };
}

/** Hex colour with an alpha channel (ECharts accepts 8-digit hex). */
function hexA(hex: string, alpha: number): string {
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
    .toString(16)
    .padStart(2, "0");
  return `${hex}${a}`;
}

export { EXPORT_BRAND, FONT_FAMILY, formatPeriodKeyForDisplay };
