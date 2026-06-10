/**
 * Wave Z2 · map a chart tile's state to ChartOnlyModal props for the explicit
 * per-chart Expand/Maximize affordance. Pure — the testable seam of the expand
 * button (the button + modal mount are thin JSX).
 *
 * Passes the tile's already-filtered rows through as the modal's data and
 * mirrors the active filters so the zoomed view matches the tile exactly.
 */
import type { ChartSpec } from "@/shared/schema";
import type { ActiveChartFilters } from "@/lib/chartFilters";

export interface ExpandModalProps {
  chart: ChartSpec;
  chartData: Record<string, unknown>[];
  effectiveFilters: ActiveChartFilters;
  filtersApplied: boolean;
}

export function buildExpandModalProps(
  chart: ChartSpec,
  filters: ActiveChartFilters | undefined,
  filteredRows: Record<string, unknown>[],
): ExpandModalProps {
  const effectiveFilters = filters ?? {};
  return {
    chart,
    chartData: filteredRows,
    effectiveFilters,
    filtersApplied: Object.values(effectiveFilters).some((v) => v !== undefined),
  };
}
