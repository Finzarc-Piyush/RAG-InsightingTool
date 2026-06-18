/**
 * chartSpecSeries.ts — shared ChartSpec → series/label extraction for exporters.
 *
 * The ECharts-SSR renderer (chartSsr.ts) and the pptxgenjs mapper
 * (pptx/chartSpecToAddChart.ts) independently walked a chart's rows to build
 * the same cartesian {labels, values} and scatter [x,y][] series. This module
 * owns that extraction once; each exporter keeps its own OUTPUT shaping (ECharts
 * option object vs pptxgenjs addChart args). Pie is intentionally NOT here — the
 * two exporters' pie shapes genuinely diverge.
 *
 * Pure leaf module. `readNum` is the single numeric coercer for the exporters
 * (delegates to numberCoercion.toFiniteNumber).
 */
import { toFiniteNumber } from "../numberCoercion.js";
import { formatPeriodKeyForDisplay } from "../dateUtils.js";

export interface CartesianSeries {
  name: string;
  labels: string[];
  values: number[];
}

export interface ScatterSeries {
  name: string;
  values: Array<[number, number]>;
}

/** Coerce a chart cell to a finite number, or null. */
export const readNum = (v: unknown): number | null => toFiniteNumber(v);

/**
 * Cartesian (bar/line/area) extraction: canonical period keys → human labels
 * (positional, so value alignment is preserved); missing measures → 0.
 */
export function cartesianSeries(
  rows: ReadonlyArray<Record<string, unknown>>,
  xKey: string,
  yKey: string,
  name: string
): CartesianSeries {
  return {
    name,
    labels: rows.map((r) => formatPeriodKeyForDisplay(r[xKey])),
    values: rows.map((r) => readNum(r[yKey]) ?? 0),
  };
}

/** Scatter extraction: [x, y] pairs, dropping rows where either is non-numeric. */
export function scatterSeries(
  rows: ReadonlyArray<Record<string, unknown>>,
  xKey: string,
  yKey: string,
  name: string
): ScatterSeries {
  const values = rows
    .map(
      (r) =>
        [readNum(r[xKey]), readNum(r[yKey])] as [number | null, number | null]
    )
    .filter((p): p is [number, number] => p[0] !== null && p[1] !== null);
  return { name, values };
}

export interface MultiSeries {
  /** X-axis category labels (display form, first-seen order). */
  categories: string[];
  /** One entry per series; `values` aligned positionally to `categories`. */
  series: Array<{ name: string; values: Array<number | null> }>;
}

/**
 * Pivot rows into a MULTI-SERIES shape for grouped/stacked bars and multi-line
 * charts. Three modes, in priority order:
 *   1. `seriesColumn` set → categories = distinct `xKey`; series = distinct
 *      `seriesColumn` values; each cell = SUM of `yKey` for that (x, series).
 *   2. `seriesKeys` set (wide format — several measure columns) → categories =
 *      `xKey` per row; one series per key, value = `row[key]`.
 *   3. neither → a single series from `yKey` (same as `cartesianSeries`).
 *
 * Missing (x, series) cells are `null` (a gap for lines, no bar for bars).
 * This is what lets the export reconstruct the in-app chart instead of
 * collapsing every series into one monochrome bar set.
 */
export function pivotSeries(
  rows: ReadonlyArray<Record<string, unknown>>,
  xKey: string,
  yKey: string,
  opts: { seriesColumn?: string; seriesKeys?: string[]; seriesName?: string } = {}
): MultiSeries {
  const orderedUnique = (vals: Array<string>): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const v of vals) {
      if (!seen.has(v)) { seen.add(v); out.push(v); }
    }
    return out;
  };

  // Mode 1 — long format with an explicit series column.
  if (opts.seriesColumn && opts.seriesColumn !== xKey) {
    const sc = opts.seriesColumn;
    const catKeys = orderedUnique(rows.map((r) => String(r[xKey] ?? "")));
    const seriesNames = orderedUnique(rows.map((r) => String(r[sc] ?? "")));
    const catIdx = new Map(catKeys.map((c, i) => [c, i]));
    const acc = new Map<string, Array<number | null>>(
      seriesNames.map((s) => [s, new Array<number | null>(catKeys.length).fill(null)])
    );
    for (const r of rows) {
      const ci = catIdx.get(String(r[xKey] ?? ""));
      const sName = String(r[sc] ?? "");
      const v = readNum(r[yKey]);
      if (ci === undefined || v === null) continue;
      const arr = acc.get(sName)!;
      arr[ci] = (arr[ci] ?? 0) + v;
    }
    return {
      categories: catKeys.map((c) => formatPeriodKeyForDisplay(c)),
      series: seriesNames.map((s) => ({ name: s, values: acc.get(s)! })),
    };
  }

  // Mode 2 — wide format with several measure columns.
  if (opts.seriesKeys && opts.seriesKeys.length > 0) {
    const keys = opts.seriesKeys.filter((k) => k !== xKey);
    if (keys.length > 0) {
      return {
        categories: rows.map((r) => formatPeriodKeyForDisplay(r[xKey])),
        series: keys.map((k) => ({ name: k, values: rows.map((r) => readNum(r[k])) })),
      };
    }
  }

  // Mode 3 — single series.
  const cs = cartesianSeries(rows, xKey, yKey, opts.seriesName ?? yKey);
  return { categories: cs.labels, series: [{ name: cs.name, values: cs.values }] };
}
