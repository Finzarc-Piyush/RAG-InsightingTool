import type { ChartSpec } from "@/shared/schema";
import type { PivotUiConfig, PivotValueSpec } from "@/lib/pivot/types";

/**
 * Wave DR18D · derive a `PivotUiConfig` from a chart spec so the same
 * underlying `chart.data` rows can be rendered as either a chart
 * (existing) or a pivot table (new toggle).
 *
 * Two row shapes exist (see `processChartData` / `pivotLongToWideBar`):
 *
 *   - Long / aggregated rows ({ [x]: …, [y]: number }):
 *       chart.x          → rows[0]    (the categorical axis)
 *       chart.seriesColumn (if any) → columns[0]  (series breakdown)
 *       chart.y          → values[0] with sum aggregation
 *
 *   - WIDE multi-series rows ({ [x]: …, <sanitizedSeriesKey>: number, … }):
 *       the server has already pivoted long→wide, so `chart.y` and
 *       `chart.seriesColumn` are NOT keys on the rows — the measure lives
 *       under each `chart.seriesKeys` entry. Reading `chart.y` here would
 *       yield `undefined` → 0 for every cell (the all-zeros bug). Instead
 *       we emit one value spec per series key, read directly from the wide
 *       columns, so the pivot shows real numbers.
 *
 * Returns `null` when the chart can't sensibly become a pivot — no x,
 * no y, or no data array. The caller hides the toggle button in that
 * case so users don't see a "View as pivot" affordance that yields
 * nothing.
 *
 * Pure function — no React, no async, no DOM. The downstream
 * `buildPivotModel` is also pure, so the entire chart→pivot pipeline
 * runs client-side without touching the session or the server.
 */
export function chartSpecToPivotConfig(
  chart: ChartSpec,
): { config: PivotUiConfig; valueSpecs: PivotValueSpec[] } | null {
  if (!chart) return null;
  if (typeof chart.x !== "string" || chart.x.trim().length === 0) return null;
  if (typeof chart.y !== "string" || chart.y.trim().length === 0) return null;
  if (!Array.isArray(chart.data)) return null;

  const firstRow = (chart.data[0] ?? {}) as Record<string, unknown>;
  const yInRow = chart.y in firstRow;
  const hasSeriesColumn =
    typeof chart.seriesColumn === "string" &&
    chart.seriesColumn.trim().length > 0;

  // Wide multi-series detection: `chart.y` is absent from the rows and the
  // sanitized series keys are present instead. Prefer the explicit
  // `seriesKeys` the server sets; fall back to "every numeric non-x key" for
  // older specs that lack it.
  let seriesKeys: string[] = Array.isArray(chart.seriesKeys)
    ? chart.seriesKeys.filter((k) => typeof k === "string" && k in firstRow)
    : [];
  if (hasSeriesColumn && !yInRow && seriesKeys.length === 0) {
    seriesKeys = Object.keys(firstRow).filter(
      (k) =>
        k !== chart.x &&
        k !== chart.seriesColumn &&
        typeof firstRow[k] === "number",
    );
  }

  if (hasSeriesColumn && !yInRow && seriesKeys.length > 0) {
    const valueSpecs: PivotValueSpec[] = seriesKeys.map((k) => ({
      id: k,
      field: k,
      agg: "sum" as const,
    }));
    const config: PivotUiConfig = {
      filters: [],
      rows: [chart.x],
      columns: [],
      values: valueSpecs,
      unused: [],
    };
    return { config, valueSpecs };
  }

  const valueSpecs: PivotValueSpec[] = [
    { id: "value", field: chart.y, agg: "sum" },
  ];

  const columns: string[] = hasSeriesColumn
    ? [chart.seriesColumn as string]
    : [];

  const config: PivotUiConfig = {
    filters: [],
    rows: [chart.x],
    columns,
    values: valueSpecs,
    unused: [],
  };

  return { config, valueSpecs };
}
