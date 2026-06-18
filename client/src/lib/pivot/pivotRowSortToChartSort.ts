import type { ChartSortSpec } from "@/shared/chartSort";
import type { PivotUiConfig } from "./types";

/**
 * Wave S7 · map a pivot's row sort to a chart sort, so toggling a sorted pivot
 * to a chart opens the chart in the SAME order. `rowLabel` → category axis,
 * a measure sort → value. Returns `undefined` when the pivot has no explicit
 * row sort, letting the chart fall back to its own auto axis-order default.
 */
export function pivotRowSortToChartSort(
  rowSort: PivotUiConfig["rowSort"] | undefined,
): ChartSortSpec | undefined {
  if (!rowSort) return undefined;
  const by = rowSort.primary === "rowLabel" ? "category" : "value";
  return { by, direction: rowSort.direction };
}
