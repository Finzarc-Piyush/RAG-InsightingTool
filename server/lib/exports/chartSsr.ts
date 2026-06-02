/**
 * W-EXP-4 · Server-side ECharts SVG renderer.
 *
 * Translates a `ChartSpec` (server/shared/schema.ts) into a self-contained
 * SVG string, suitable for:
 *   - Direct inclusion in a print-styled React route (W-EXP-8 PDF flow)
 *   - Rasterization to PNG by pptxgenjs as a fallback when a chart type is
 *     not natively `addChart`-able (heatmap; future treemap/sankey)
 *
 * Why ECharts SVG SSR (vs. node-canvas, vs. headless Chromium screenshot)?
 *   - Pure JS, no native deps — Vercel-safe (cairo/pango would tank the
 *     function size limit).
 *   - Vector everywhere — prints sharp at any zoom; the second-biggest
 *     amateur tell of analytical decks is rastered chart screenshots.
 *   - Reuses the same chart vocabulary the UI uses, so a future v2-chart
 *     migration can share encoding mappers.
 *
 * What this file deliberately does NOT do:
 *   - Render the dashboard's interactive features (tooltips, hover state,
 *     drill-through). Static export only.
 *   - Pull design tokens at runtime — palette comes from a single source
 *     of truth (`exportTheme.ts`-equivalent constants here, mirrored from
 *     `client/src/pages/Dashboard/exportTheme.ts`).
 *   - Embed font files. Fonts are referenced by family name; the renderer
 *     (Puppeteer print route) loads the actual font face. For pptxgenjs
 *     rasterization fallback we ship without bundled fonts — the SVG falls
 *     back to system sans, acceptable since the PPT path uses it only for
 *     chart types pptxgenjs can't render natively (rare).
 */
import * as echarts from "echarts";
import type { ChartSpec } from "../../shared/schema.js";
import { formatPeriodKeyForDisplay } from "../dateUtils.js";

/**
 * Brand palette mirrored from `client/src/pages/Dashboard/exportTheme.ts`.
 * Keep in sync there — both files reference the same hex values so the
 * renderer (this file) and the existing client export match. The duplication
 * is intentional: the client file is browser-bundled and importing it on
 * the server forces a `vite` round-trip we don't want.
 */
const EXPORT_BRAND = {
  primary: "#0B63F6",
  accent: "#0EA5E9",
  foreground: "#111827",
  muted: "#6B7280",
  border: "#D1D5DB",
  background: "#FFFFFF",
  // 8-step categorical palette — matches the dashboard's Tailwind chart
  // palette (the first 8 of the 12-color cycle in `client/src/index.css`).
  categorical: [
    "#0B63F6", // primary blue
    "#0EA5E9", // sky
    "#10B981", // emerald
    "#F59E0B", // amber
    "#EF4444", // red
    "#8B5CF6", // violet
    "#EC4899", // pink
    "#14B8A6", // teal
  ],
} as const;

const FONT_FAMILY = "Inter, ui-sans-serif, system-ui, sans-serif";

export interface RenderChartSvgOptions {
  /** Logical pixel width of the SVG; renderer scales typography accordingly. */
  width?: number;
  /** Logical pixel height. */
  height?: number;
  /**
   * When true, suppresses the chart title in favour of the slide's
   * `actionTitle` (PPT/PDF layouts already render their own title).
   * Default true.
   */
  suppressTitle?: boolean;
}

/**
 * Render a `ChartSpec` to SVG. Returns the SVG string (`<svg …>…</svg>`),
 * or null when the chart type or data shape isn't supported. Callers
 * (renderers) fall back gracefully — typically by skipping the slide or
 * rendering a "chart unavailable" placeholder.
 */
export function renderChartSpecToSvg(
  spec: ChartSpec,
  opts: RenderChartSvgOptions = {}
): string | null {
  const width = opts.width ?? 1024;
  const height = opts.height ?? 576;

  const option = chartSpecToEchartsOption(spec, opts);
  if (!option) return null;

  // ECharts SSR pattern — `init(null, null, { ssr: true, renderer: 'svg' })`
  // produces a chart instance that emits an SVG string via
  // `renderToSVGString()`. No DOM, no canvas, no native deps.
  const chart = echarts.init(null, null, {
    renderer: "svg",
    ssr: true,
    width,
    height,
  });
  try {
    chart.setOption(option);
    const svg = chart.renderToSVGString();
    // Strip ECharts-injected `xmlns:xlink` if absent — older ECharts versions
    // emit invalid SVG when xlink isn't actually used. Trivial cosmetic.
    return svg;
  } finally {
    chart.dispose();
  }
}

interface EchartsLikeOption {
  // Loose-typed by design — ECharts' option surface is enormous and the
  // chart-spec-to-option mapper is the only consumer. A stricter type would
  // either pull `EChartsOption` from `echarts` (heavy) or invent a partial
  // shadow shape (drift risk). The `unknown` outer record is the right level.
  [key: string]: unknown;
}

/** Map a `ChartSpec` to an ECharts option object. Pure function; testable. */
export function chartSpecToEchartsOption(
  spec: ChartSpec,
  opts: RenderChartSvgOptions = {}
): EchartsLikeOption | null {
  const data = spec.data ?? [];
  if (data.length === 0) return null;

  const showTitle = opts.suppressTitle === false;
  const baseTextStyle = { fontFamily: FONT_FAMILY, color: EXPORT_BRAND.foreground };

  switch (spec.type) {
    case "bar":
    case "line":
    case "area":
      return cartesianOption(spec, data, showTitle, baseTextStyle);
    case "scatter":
      return scatterOption(spec, data, showTitle, baseTextStyle);
    case "pie":
      return pieOption(spec, data, showTitle, baseTextStyle);
    case "heatmap":
      return heatmapOption(spec, data, showTitle, baseTextStyle);
    default: {
      const _exhaustive: never = spec.type;
      void _exhaustive;
      return null;
    }
  }
}

type DataRow = Record<string, string | number | null>;
type TextStyle = { fontFamily: string; color: string };

function readNum(row: DataRow, key: string): number | null {
  const v = row[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function cartesianOption(
  spec: ChartSpec,
  data: DataRow[],
  showTitle: boolean,
  textStyle: TextStyle
): EchartsLikeOption {
  const xKey = spec.x;
  const yKey = spec.y;
  // Single series for now (the planner-fed slim data we render here is one
  // chart per slide). Multi-series via seriesColumn lands in the v2 chart
  // overhaul — out of scope for the export-rewrite stream.
  // Canonical period keys ("2023-Q1") → human labels ("Q1 2023") for display.
  // Positional category axis: y-values align by index, so order is preserved.
  const xValues = data.map((r) => formatPeriodKeyForDisplay(r[xKey]));
  const yValues = data.map((r) => readNum(r, yKey) ?? 0);

  const seriesType = spec.type === "area" ? "line" : spec.type;
  const series: EchartsLikeOption = {
    name: spec.yLabel ?? yKey,
    type: seriesType,
    data: yValues,
    itemStyle: { color: EXPORT_BRAND.primary },
    lineStyle: { color: EXPORT_BRAND.primary, width: 2 },
    smooth: false,
  };
  if (spec.type === "area") {
    series.areaStyle = { color: EXPORT_BRAND.primary, opacity: 0.18 };
  }

  return {
    animation: false,
    backgroundColor: EXPORT_BRAND.background,
    textStyle,
    title: showTitle
      ? {
          text: spec.title,
          left: "left",
          textStyle: { ...textStyle, fontSize: 16, fontWeight: 600 },
        }
      : undefined,
    grid: { left: 56, right: 24, top: showTitle ? 56 : 24, bottom: 48 },
    xAxis: {
      type: "category",
      data: xValues,
      name: spec.xLabel ?? xKey,
      nameLocation: "middle",
      nameGap: 32,
      axisLabel: { color: EXPORT_BRAND.foreground, fontFamily: FONT_FAMILY },
      axisLine: { lineStyle: { color: EXPORT_BRAND.border } },
    },
    yAxis: {
      type: "value",
      name: spec.yLabel ?? yKey,
      nameLocation: "middle",
      nameGap: 44,
      min: spec.yDomain?.[0],
      max: spec.yDomain?.[1],
      axisLabel: { color: EXPORT_BRAND.foreground, fontFamily: FONT_FAMILY },
      splitLine: { lineStyle: { color: EXPORT_BRAND.border, type: "dashed" } },
    },
    series: [series],
  };
}

function scatterOption(
  spec: ChartSpec,
  data: DataRow[],
  showTitle: boolean,
  textStyle: TextStyle
): EchartsLikeOption {
  const points = data
    .map((r) => [readNum(r, spec.x), readNum(r, spec.y)] as [number | null, number | null])
    .filter((p): p is [number, number] => p[0] !== null && p[1] !== null);
  return {
    animation: false,
    backgroundColor: EXPORT_BRAND.background,
    textStyle,
    title: showTitle
      ? {
          text: spec.title,
          left: "left",
          textStyle: { ...textStyle, fontSize: 16, fontWeight: 600 },
        }
      : undefined,
    grid: { left: 56, right: 24, top: showTitle ? 56 : 24, bottom: 48 },
    xAxis: {
      type: "value",
      name: spec.xLabel ?? spec.x,
      nameLocation: "middle",
      nameGap: 32,
      min: spec.xDomain?.[0],
      max: spec.xDomain?.[1],
      axisLabel: { color: EXPORT_BRAND.foreground, fontFamily: FONT_FAMILY },
      axisLine: { lineStyle: { color: EXPORT_BRAND.border } },
    },
    yAxis: {
      type: "value",
      name: spec.yLabel ?? spec.y,
      nameLocation: "middle",
      nameGap: 44,
      min: spec.yDomain?.[0],
      max: spec.yDomain?.[1],
      axisLabel: { color: EXPORT_BRAND.foreground, fontFamily: FONT_FAMILY },
      splitLine: { lineStyle: { color: EXPORT_BRAND.border, type: "dashed" } },
    },
    series: [
      {
        type: "scatter",
        data: points,
        symbolSize: 8,
        itemStyle: { color: EXPORT_BRAND.primary, opacity: 0.7 },
      },
    ],
  };
}

function pieOption(
  spec: ChartSpec,
  data: DataRow[],
  showTitle: boolean,
  textStyle: TextStyle
): EchartsLikeOption {
  const slices = data
    .map((r) => ({
      name: String(r[spec.x] ?? ""),
      value: readNum(r, spec.y) ?? 0,
    }))
    .filter((s) => s.value > 0);
  return {
    animation: false,
    backgroundColor: EXPORT_BRAND.background,
    textStyle,
    title: showTitle
      ? {
          text: spec.title,
          left: "left",
          textStyle: { ...textStyle, fontSize: 16, fontWeight: 600 },
        }
      : undefined,
    color: EXPORT_BRAND.categorical,
    series: [
      {
        type: "pie",
        radius: ["40%", "70%"],
        data: slices,
        label: {
          color: EXPORT_BRAND.foreground,
          fontFamily: FONT_FAMILY,
          formatter: "{b}: {d}%",
        },
        labelLine: { lineStyle: { color: EXPORT_BRAND.border } },
      },
    ],
  };
}

function heatmapOption(
  spec: ChartSpec,
  data: DataRow[],
  showTitle: boolean,
  textStyle: TextStyle
): EchartsLikeOption | null {
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
      return [x, y, z];
    })
    .filter((c): c is [number, number, number] => c !== null);
  const zValues = cells.map((c) => c[2]);
  const min = Math.min(...zValues, 0);
  const max = Math.max(...zValues, 1);
  return {
    animation: false,
    backgroundColor: EXPORT_BRAND.background,
    textStyle,
    title: showTitle
      ? {
          text: spec.title,
          left: "left",
          textStyle: { ...textStyle, fontSize: 16, fontWeight: 600 },
        }
      : undefined,
    grid: { left: 64, right: 24, top: showTitle ? 56 : 24, bottom: 60 },
    xAxis: {
      type: "category",
      data: xCats,
      name: spec.xLabel ?? spec.x,
      nameLocation: "middle",
      nameGap: 32,
      axisLabel: { color: EXPORT_BRAND.foreground, fontFamily: FONT_FAMILY },
      splitArea: { show: true },
    },
    yAxis: {
      type: "category",
      data: yCats,
      name: spec.yLabel ?? spec.y,
      nameLocation: "middle",
      nameGap: 44,
      axisLabel: { color: EXPORT_BRAND.foreground, fontFamily: FONT_FAMILY },
      splitArea: { show: true },
    },
    visualMap: {
      min,
      max,
      calculable: false,
      orient: "horizontal",
      left: "center",
      bottom: 0,
      inRange: { color: ["#EAF2FE", EXPORT_BRAND.primary] },
      textStyle: { color: EXPORT_BRAND.foreground, fontFamily: FONT_FAMILY },
    },
    series: [
      {
        type: "heatmap",
        data: cells,
        label: { show: false },
        emphasis: { itemStyle: { borderColor: EXPORT_BRAND.foreground } },
      },
    ],
  };
}

/**
 * Re-exported for renderers that need to reference the palette directly
 * (e.g. pptxgenjs `addChart` color arrays). One source of truth.
 */
export { EXPORT_BRAND, FONT_FAMILY };
