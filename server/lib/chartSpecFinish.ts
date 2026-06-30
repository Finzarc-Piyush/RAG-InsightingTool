/**
 * ============================================================================
 * chartSpecFinish.ts — the single "finish a ChartSpec" tail for chart builders
 * ============================================================================
 * WHAT THIS FILE DOES
 *   Given a validated ChartSpec and its already-processed data rows, computes the
 *   chart's axis domains and returns the render-ready spec: `{...spec, xLabel,
 *   yLabel, data, ...smartDomains}`. Domain rules:
 *     - heatmap → no numeric domains (the cell colour scale owns its range).
 *     - multi-series (spec.seriesKeys present) → yDomainForMultiSeriesRows over
 *       the series-key columns, combined per `multiSeriesYDomainKind`.
 *     - otherwise → calculateSmartDomainsForChart on x / y / y2 with the standard
 *       IQR padding options.
 *
 * WHY IT MATTERS
 *   This finishing tail was copy-pasted across four builders (chartFromTable, the
 *   visualPlanner deterministic fallback, the visualPlanner LLM path, and
 *   agentLoop.materializeDeferredBuildCharts) and DRIFTED: two of them skipped the
 *   multi-series branch and ran calculateSmartDomainsForChart on the bare `spec.y`
 *   column — which for a wide multi-series frame is not a data column, yielding a
 *   degenerate Y range. Routing every builder through this one function gives them
 *   identical, correct domains for multi-series charts. Callers keep their own
 *   axis-resolution / title / compile head and only delegate the tail.
 *
 * HOW IT CONNECTS
 *   Pure. Imports only the axis-scaling primitives from axisScaling.ts and the
 *   ChartSpec type. `processed` is the output of chartGenerator.processChartData
 *   (which also populates `spec.seriesKeys` in place for multi-series specs).
 */
import type { ChartSpec } from "../shared/schema.js";
import {
  calculateSmartDomainsForChart,
  multiSeriesYDomainKind,
  yDomainForMultiSeriesRows,
} from "./axisScaling.js";

const IQR_DOMAIN_OPTIONS = {
  useIQR: true,
  paddingPercent: 5,
  includeOutliers: true,
} as const;

/**
 * Attach axis domains + render labels to a compiled ChartSpec.
 * Returns a NEW object; does not mutate `spec`. Callers may spread extra fields
 * (e.g. `_agentEvidenceRef`) onto the result.
 */
export function finishChartSpec(
  spec: ChartSpec,
  processed: Record<string, any>[]
): ChartSpec {
  let smartDomains: Record<string, unknown> = {};
  if (spec.type === "heatmap") {
    smartDomains = {};
  } else if (spec.seriesKeys?.length) {
    smartDomains = yDomainForMultiSeriesRows(
      processed,
      spec.seriesKeys,
      multiSeriesYDomainKind(spec.type, spec.barLayout)
    );
  } else {
    smartDomains = calculateSmartDomainsForChart(
      processed,
      spec.x,
      spec.y,
      spec.y2 || undefined,
      {
        yOptions: { ...IQR_DOMAIN_OPTIONS },
        y2Options: spec.y2 ? { ...IQR_DOMAIN_OPTIONS } : undefined,
      }
    );
  }

  // W7 · when a NON-additive metric (GC%, margin %, realization …) was combined
  // across the dimension, surface that it is a weighted average — never a total —
  // via the existing axisReason subtitle (no client change). This is what stops a
  // chart of GC% by channel from reading as if the bars summed to a meaningful 100%+.
  let axisReason = spec.axisReason;
  if (spec.metricAdditivity === "non_additive" && spec.aggPolicy && spec.aggPolicy !== "sum") {
    const how =
      spec.aggPolicy === "weighted_mean"
        ? "a denominator-weighted average"
        : spec.aggPolicy === "recompute"
          ? "recomputed from its components (Σ numerator / Σ denominator)"
          : "an average";
    const note = `${spec.y} is a ratio — values shown are ${how} across ${spec.x}, not a sum.`;
    axisReason = axisReason ? `${axisReason} ${note}` : note;
  }

  return {
    ...spec,
    xLabel: spec.x,
    yLabel: spec.y,
    ...(axisReason ? { axisReason } : {}),
    data: processed,
    ...smartDomains,
  } as ChartSpec;
}
