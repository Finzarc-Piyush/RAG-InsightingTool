/**
 * PV2 · Per-mark validity map for the pivot's "Change chart type" dropdown.
 *
 * Returns a `Record<PivotChartKind, { valid, reason }>` so the UI can disable
 * options that don't fit the current pivot config and surface the reason as
 * a tooltip. Mirrors the `recommendPivotChartForType` validity checks already
 * encoded in `chartRecommendation.ts` so the dropdown and the recommender
 * agree on which marks are renderable.
 *
 * Pure: no client-only imports. Lives under `server/shared/` and is mirrored
 * to the client via the same cross-package re-export pattern as the
 * recommender (see `client/src/lib/pivot/chartTypeValidity.ts`).
 */

import {
  type PivotChartKind,
  type PivotChartRecommendationInput,
  normalizePivotMeasureFieldForChart,
} from './chartRecommendation.js';

const PIE_MAX_CATEGORIES = 8;
const HEATMAP_MAX_COL_KEYS = 24;
const HEATMAP_MAX_ROW_KEYS = 40;
const RADAR_MAX_SPOKES = 8;

const ALL_PIVOT_CHART_KINDS = [
  'bar',
  'line',
  'area',
  'scatter',
  'pie',
  'donut',
  'heatmap',
  'radar',
  'bubble',
  'waterfall',
] as const satisfies readonly PivotChartKind[];

export const PIVOT_CHART_KINDS: readonly PivotChartKind[] = ALL_PIVOT_CHART_KINDS;

export interface MarkValidity {
  valid: boolean;
  reason: string;
}

export type PivotChartValidityMap = Record<PivotChartKind, MarkValidity>;

const VALID = (reason: string): MarkValidity => ({ valid: true, reason });
const INVALID = (reason: string): MarkValidity => ({ valid: false, reason });

export function chartTypeValidityForPivot(
  input: PivotChartRecommendationInput
): PivotChartValidityMap {
  const {
    pivotConfig,
    numericColumns,
    rowCount = 0,
    colKeyCount = 0,
  } = input;
  const numericSet = new Set(numericColumns);
  const firstRow = pivotConfig.rows[0] ?? null;
  const firstCol = pivotConfig.columns[0] ?? null;
  const firstValueField = pivotConfig.values[0]?.field ?? null;
  const firstValueResolved =
    normalizePivotMeasureFieldForChart(firstValueField, numericColumns) ?? firstValueField;
  const yNumeric = firstValueResolved ? numericSet.has(firstValueResolved) : false;
  const numericMeasureCount = numericColumns.length;
  const valueFieldsAllNumeric =
    pivotConfig.values.length > 0 &&
    pivotConfig.values.every((v) => {
      if (numericSet.has(v.field)) return true;
      const stem = normalizePivotMeasureFieldForChart(v.field, numericColumns);
      return stem != null && numericSet.has(stem);
    });

  const hasRowMeasure = Boolean(firstRow && firstValueResolved && yNumeric);

  // bar / line / area — same minimum: row dim + numeric measure.
  const barLike = hasRowMeasure
    ? VALID('Categorical comparison.')
    : INVALID('Add a row dimension and a numeric measure.');

  const pieLike =
    hasRowMeasure && rowCount > 0 && rowCount <= PIE_MAX_CATEGORIES
      ? VALID('Low-cardinality split on the row dimension.')
      : INVALID(
          rowCount > PIE_MAX_CATEGORIES
            ? `Pie/donut is unreadable past ${PIE_MAX_CATEGORIES} categories.`
            : 'Pie/donut needs a row dimension and a numeric measure.'
        );

  const scatterValidity =
    numericMeasureCount >= 2
      ? VALID('Two numeric measures available.')
      : INVALID('Scatter needs two numeric measures.');

  const bubbleValidity =
    numericMeasureCount >= 3
      ? VALID('Three numeric measures available (X, Y, size).')
      : INVALID('Bubble needs three numeric measures.');

  const heatmapValidity =
    Boolean(firstRow) &&
    Boolean(firstCol) &&
    yNumeric &&
    colKeyCount > 0 &&
    rowCount > 0 &&
    colKeyCount <= HEATMAP_MAX_COL_KEYS &&
    rowCount <= HEATMAP_MAX_ROW_KEYS
      ? VALID('Row × column with a numeric value.')
      : INVALID(
          !firstCol
            ? 'Heatmap needs a column dimension.'
            : colKeyCount > HEATMAP_MAX_COL_KEYS || rowCount > HEATMAP_MAX_ROW_KEYS
              ? `Heatmap cardinality must stay within ${HEATMAP_MAX_ROW_KEYS}×${HEATMAP_MAX_COL_KEYS}.`
              : 'Heatmap needs a row dim, column dim, and numeric value.'
        );

  const radarValidity =
    pivotConfig.rows.length >= 1 &&
    pivotConfig.values.length >= 3 &&
    valueFieldsAllNumeric &&
    Boolean(firstRow) &&
    rowCount > 0 &&
    rowCount <= RADAR_MAX_SPOKES
      ? VALID('Multi-measure profile across one entity dimension.')
      : INVALID(
          rowCount > RADAR_MAX_SPOKES
            ? `Radar is unreadable past ${RADAR_MAX_SPOKES} spokes.`
            : 'Radar needs ≥3 numeric measures over one row dimension.'
        );

  // Waterfall is intentionally permissive — the use-case is signaled by data,
  // not constraints. Same minimum as bar.
  const waterfallValidity = hasRowMeasure
    ? VALID('Cumulative-bridge breakdown of a numeric measure.')
    : INVALID('Waterfall needs a row dimension and a numeric measure.');

  return {
    bar: barLike,
    line: barLike,
    area: barLike,
    scatter: scatterValidity,
    pie: pieLike,
    donut: pieLike,
    heatmap: heatmapValidity,
    radar: radarValidity,
    bubble: bubbleValidity,
    waterfall: waterfallValidity,
  };
}
