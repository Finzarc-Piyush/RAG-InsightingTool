/**
 * ============================================================================
 * attachReferenceLines.ts — org-average benchmark line on breakdown charts
 * ============================================================================
 * WHAT THIS FILE DOES
 *   A bar of "PJP adherence by ASM" means little without a reference: is 60%
 *   good? This adds an "Org avg" dashed reference line to each categorical
 *   breakdown chart so a manager instantly sees who is above / below average —
 *   the visual companion to the "Attention Areas" callout. The client computes
 *   the line position itself (`value: "mean"` over the chart's y-values), so the
 *   benchmark always matches what the tile shows.
 *
 * HOW IT CONNECTS
 *   Pure. Called from buildDashboard on the dashboard's ChartSpec[]; the client
 *   forwards `_autoLayers` into v2 `layers` (v1ToV2.ts) and both Bar/Line
 *   renderers render reference-line layers (resolveReferenceLines, layers.ts).
 */
import type { ChartSpec } from "../../../shared/schema.js";

type AutoLayer = NonNullable<ChartSpec["_autoLayers"]>[number];

const ORG_AVG_LAYER: AutoLayer = {
  type: "reference-line",
  on: "y",
  value: "mean", // client resolves the mean of the chart's y-values = org average
  label: "Org avg",
};

/**
 * Return copies of `charts` with an "Org avg" reference line added to each
 * categorical bar breakdown (≥3 categories) that doesn't already carry one.
 * Pure — never mutates the input charts (so the chat-surface charts are
 * unaffected; this is a dashboard-only benchmark).
 */
export function attachOrgAverageReferenceLines(charts: readonly ChartSpec[]): ChartSpec[] {
  return (charts ?? []).map((chart) => {
    if (!chart || chart.type !== "bar" || !chart.y) return chart;
    const data = Array.isArray(chart.data) ? chart.data : [];
    if (data.length < 3) return chart; // benchmark needs ≥3 units to be meaningful
    const existing = Array.isArray(chart._autoLayers) ? chart._autoLayers : [];
    if (existing.some((l) => l?.type === "reference-line")) return chart; // don't duplicate
    return { ...chart, _autoLayers: [...existing, ORG_AVG_LAYER] };
  });
}
