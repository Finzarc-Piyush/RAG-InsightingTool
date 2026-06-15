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
