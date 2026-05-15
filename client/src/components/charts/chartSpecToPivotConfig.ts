import type { ChartSpec } from "@/shared/schema";
import type { PivotUiConfig, PivotValueSpec } from "@/lib/pivot/types";

/**
 * Wave DR18D · derive a `PivotUiConfig` from a chart spec so the same
 * underlying `chart.data` rows can be rendered as either a chart
 * (existing) or a pivot table (new toggle).
 *
 * Mapping:
 *   - chart.x          → rows[0]    (the categorical axis)
 *   - chart.seriesColumn (if any) → columns[0]  (the series breakdown)
 *   - chart.y          → values[0] with sum aggregation
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

  const valueSpecs: PivotValueSpec[] = [
    { id: "value", field: chart.y, agg: "sum" },
  ];

  const columns: string[] =
    typeof chart.seriesColumn === "string" && chart.seriesColumn.trim().length > 0
      ? [chart.seriesColumn]
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
