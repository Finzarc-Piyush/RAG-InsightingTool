/**
 * Chronological ordering for pivot row/column labels and chart axes.
 *
 * The implementation now lives in the shared, server+client sort authority
 * `server/shared/chartSort.ts` (so there is exactly ONE copy of the temporal
 * key logic). This file is a thin re-export that preserves the historic import
 * path `@/lib/temporalAxisSort` for its existing callers (pivot buildPivotModel,
 * ChartRenderer, FilterDataPanel, the visx Line/Area renderers, chartRechartsShared).
 */
export {
  parseTemporalLabelSortKey,
  compareTemporalOrLexicalLabels,
} from "../../../server/shared/chartSort";
