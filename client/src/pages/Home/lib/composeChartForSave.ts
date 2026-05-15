import type { ChartSpec } from "@/shared/schema";

/**
 * Wave DR18C · merge a live insight onto a chart spec at "Add to
 * Dashboard" time, BUT only when the chart has no curated insight of
 * its own.
 *
 * Pre-DR18C the four "Add to Dashboard" entry points all funnelled
 * through `<DashboardModal>`, which only ever submitted the bare
 * `chart: ChartSpec` it was handed. The LIVE insight visible in chat
 * (fetched per-chart from the chart-key-insight endpoint into
 * `DataPreviewTable.chartInsight` / `pivotKeyInsight`) was never
 * merged onto the chart spec, so dashboards saved manually from chat
 * frequently rendered with no insight footer at all — the user saw
 * full insight text in chat and an empty card on the dashboard.
 *
 * DR18C threads the live insight from the two sites that have it
 * (ChartModal, DataPreviewTable) into the modal's add path. This
 * helper formalises the merge rule:
 *
 *   - if the chart already carries a `keyInsight` → keep it as-is
 *     (agent-emitted dashboards already curate this; never clobber)
 *   - if the chart has no keyInsight AND a live insight is provided
 *     → fill it in
 *   - otherwise → return the original chart unchanged
 *
 * Pure, no React, no async. Vitest exercises every branch.
 */
export function composeChartForSave(
  chart: ChartSpec,
  liveInsight: string | null | undefined,
): ChartSpec {
  if (!liveInsight) return chart;
  const trimmed = liveInsight.trim();
  if (!trimmed) return chart;
  if (typeof chart.keyInsight === "string" && chart.keyInsight.trim().length > 0) {
    return chart;
  }
  return { ...chart, keyInsight: trimmed };
}
