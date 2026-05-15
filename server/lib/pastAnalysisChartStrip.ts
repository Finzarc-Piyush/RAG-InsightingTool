/**
 * AMR2 · Pure helper: strip the inline row data from each chart spec before
 * persistence to the `past_analyses` Cosmos doc.
 *
 * The chart's `data` array (record-per-row) is the heaviest part of any spec
 * — a 5000-row chart can blow past the 2MB Cosmos document cap on its own.
 * For cross-session recall, the rows aren't needed: the rich AnswerCard +
 * chart rendering pipeline rebuilds visualisations from the inline series
 * encoded in the spec (axis fields, agg, layers), and the pivot artifact
 * (AMR3) holds the aggregated rows independently. Everything else on the
 * spec — `type`, axis encodings, `keyInsight`, `businessCommentary`,
 * `_autoLayers`, `_agentProvenance`, `_suggestedAlts` — survives unchanged.
 *
 * Mirrors the intermediate-strip pattern already in place at
 * `chatStream.service.ts:1449` for in-session message persistence.
 */

import type { ChartSpec } from "../shared/schema.js";

export function stripChartDataForPastAnalysis(charts: ChartSpec[]): ChartSpec[] {
  return charts.map((c) => {
    const { data: _data, ...rest } = c as ChartSpec & { data?: unknown };
    return rest as ChartSpec;
  });
}
