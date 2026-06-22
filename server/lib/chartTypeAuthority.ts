/**
 * ============================================================================
 * chartTypeAuthority.ts — the ONE place that decides line vs bar
 * ============================================================================
 * WHAT THIS FILE DOES
 *   Answers a single question every chart builder needs: "is this chart's
 *   x-axis a TIME axis?" — and, from that, "should it be a line or a bar?".
 *   A time progression must be a line; a categorical breakdown must be a bar.
 *
 * WHY IT MATTERS
 *   This decision used to be re-implemented inline in several builders
 *   (chartFromTable, the dashboard feature sweep, the build_chart tool, the
 *   verifier) with NON-UNIFORM inputs — one checked temporal facet keys, the
 *   next only checked the raw date-column list. That divergence let temporal
 *   FACET columns ("Day · Date", "Week · Date") slip through one path as
 *   ordinary categories and render as bars, while the same column rendered as a
 *   line elsewhere. Centralising the predicate (and feeding it uniform inputs at
 *   every call site) is what closes that class of bug. See
 *   docs/decisions/centralized-chart-type.md and lesson L-026 (an instance of
 *   the L-019 "single authority needs uniform inputs" rule). Sibling
 *   authorities: temporalGrainAuthority (which GRAIN) and queryIntentAuthority
 *   (which depth). This file deliberately stays a thin leaf — it imports only
 *   the facet-key detector, so the boolean predicate never drags the grain
 *   machinery into lightweight consumers (verifier, chartGenerator).
 *
 * HOW IT CONNECTS
 *   Consumed by chartFromTable.ts, dashboardFeatureSweep.ts, the build_chart
 *   tool (registerTools.ts) and verifier.ts. Pure, no I/O.
 */
import { isTemporalFacetColumnKey } from "./temporalFacetColumns.js";

export interface TemporalXInput {
  /** summary.dateColumns — the raw declared date/source columns. */
  dateColumns: readonly string[];
  /**
   * True when an upstream period resolver POSITIVELY picked `x` as a coherent
   * period axis (chartFromTable passes `Boolean(periodAxis.pickedColumn)`).
   * Builders without a period resolver omit it (defaults false), in which case
   * the test reduces to "raw date column OR temporal facet key".
   */
  periodAxisPicked?: boolean;
}

/**
 * THE single test for "is this x-axis temporal" used to decide line vs bar.
 * Uniform across every chart builder — raw date column, temporal facet key
 * (e.g. "Day · Date" / legacy "__tf_*"), or an explicitly resolved period axis.
 */
export function isTemporalChartX(x: string, input: TemporalXInput): boolean {
  return (
    input.dateColumns.includes(x) ||
    isTemporalFacetColumnKey(x) ||
    Boolean(input.periodAxisPicked)
  );
}

/** Canonical line-vs-bar resolution for a single (x, measure) chart. */
export function resolveChartType(
  x: string,
  input: TemporalXInput
): "line" | "bar" {
  return isTemporalChartX(x, input) ? "line" : "bar";
}
