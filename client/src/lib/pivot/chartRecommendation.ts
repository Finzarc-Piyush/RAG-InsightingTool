import type { PivotUiConfig } from './types';
import { isTemporalFacetFieldId } from '@/lib/temporalFacetDisplay';

export type PivotChartKind = 'line' | 'bar' | 'scatter' | 'pie' | 'area' | 'heatmap';

export interface PivotChartRecommendationInput {
  pivotConfig: PivotUiConfig;
  numericColumns: string[];
  dateColumns: string[];
  rowCount?: number;
  colKeyCount?: number;
}

export interface PivotChartRecommendation {
  chartType: PivotChartKind;
  x: string | null;
  y: string | null;
  z: string | null;
  seriesColumn: string | null;
  barLayout: 'stacked' | 'grouped';
  reason: string;
}

const PIE_MAX_CATEGORIES = 8;
const HEATMAP_MAX_COL_KEYS = 24;
const HEATMAP_MAX_ROW_KEYS = 40;

function isDateLike(field: string | null, dateColumns: Set<string>): boolean {
  if (!field) return false;
  if (isTemporalFacetFieldId(field)) return true;
  if (dateColumns.has(field)) return true;
  const lower = field.toLowerCase();
  return /\b(date|month|week|year|time|period|quarter)\b/i.test(lower);
}

export function recommendPivotChart({
  pivotConfig,
  numericColumns,
  dateColumns,
  rowCount = 0,
  colKeyCount = 0,
}: PivotChartRecommendationInput): PivotChartRecommendation {
  const dateSet = new Set(dateColumns);
  const numericSet = new Set(numericColumns);
  const firstRow = pivotConfig.rows[0] ?? null;
  const firstCol = pivotConfig.columns[0] ?? null;
  const firstValue = pivotConfig.values[0]?.field ?? null;
  const yNumeric = firstValue ? numericSet.has(firstValue) : false;
  const xDateLike = isDateLike(firstRow, dateSet);

  if (xDateLike && yNumeric && rowCount >= 2) {
    return {
      chartType: 'line',
      x: firstRow,
      y: firstValue,
      z: null,
      seriesColumn: null,
      barLayout: 'stacked',
      reason: 'Temporal dimension detected, line chart selected by default.',
    };
  }

  if (
    firstRow &&
    firstCol &&
    firstValue &&
    yNumeric &&
    colKeyCount > 0 &&
    colKeyCount <= HEATMAP_MAX_COL_KEYS &&
    rowCount > 0 &&
    rowCount <= HEATMAP_MAX_ROW_KEYS
  ) {
    return {
      chartType: 'heatmap',
      x: firstRow,
      y: firstCol,
      z: firstValue,
      seriesColumn: null,
      barLayout: 'stacked',
      reason: 'Row and column dimensions available with manageable cardinality.',
    };
  }

  if (firstRow && firstValue && yNumeric && rowCount > 0 && rowCount <= PIE_MAX_CATEGORIES) {
    return {
      chartType: 'pie',
      x: firstRow,
      y: firstValue,
      z: null,
      seriesColumn: null,
      barLayout: 'stacked',
      reason: 'Low-cardinality category split; pie is readable here.',
    };
  }

  return {
    chartType: 'bar',
    x: firstRow,
    y: firstValue,
    z: null,
    seriesColumn: firstCol,
    barLayout: firstCol ? 'stacked' : 'grouped',
    reason: 'Categorical comparison baseline; bar is the safest default.',
  };
}

function barLikeReason(kind: string): string {
  return `${kind} chart from pivot row vs first value measure.`;
}

/**
 * Pick axes for a user-selected chart type (pivot “type only” mode).
 * Falls back toward {@link recommendPivotChart} when the type is not viable.
 */
export function recommendPivotChartForType(
  input: PivotChartRecommendationInput,
  forcedType: PivotChartKind
): PivotChartRecommendation {
  const auto = recommendPivotChart(input);
  const { pivotConfig, numericColumns, dateColumns, rowCount = 0, colKeyCount = 0 } = input;
  const dateSet = new Set(dateColumns);
  const numericSet = new Set(numericColumns);
  const firstRow = pivotConfig.rows[0] ?? null;
  const firstCol = pivotConfig.columns[0] ?? null;
  const firstValue = pivotConfig.values[0]?.field ?? null;
  const yNumeric = firstValue ? numericSet.has(firstValue) : false;
  const xDateLike = isDateLike(firstRow, dateSet);
  const meas = numericColumns.filter((c) => numericSet.has(c));
  const secondMeas = meas.find((m) => m !== firstValue) ?? meas[1] ?? firstValue;

  const canHeatmap =
    Boolean(firstRow) &&
    Boolean(firstCol) &&
    Boolean(firstValue) &&
    yNumeric &&
    colKeyCount > 0 &&
    rowCount > 0 &&
    colKeyCount <= HEATMAP_MAX_COL_KEYS &&
    rowCount <= HEATMAP_MAX_ROW_KEYS;

  const canScatter = meas.length >= 2;

  if (forcedType === 'heatmap') {
    if (canHeatmap) {
      return {
        chartType: 'heatmap',
        x: firstRow,
        y: firstCol,
        z: firstValue,
        seriesColumn: null,
        barLayout: 'stacked',
        reason: 'Heatmap: row × column with value measure.',
      };
    }
    return {
      chartType: 'heatmap',
      x: firstRow,
      y: firstCol,
      z: firstValue,
      seriesColumn: null,
      barLayout: 'stacked',
      reason: `Heatmap needs row + column fields and manageable cardinality. (${auto.reason})`,
    };
  }

  if (forcedType === 'scatter') {
    if (canScatter && firstValue && secondMeas) {
      return {
        chartType: 'scatter',
        x: firstValue,
        y: secondMeas,
        z: null,
        seriesColumn: null,
        barLayout: 'stacked',
        reason: 'Scatter: comparing two numeric measures from the pivot.',
      };
    }
    return {
      chartType: 'scatter',
      x: meas[0] ?? firstValue,
      y: meas[1] ?? meas[0] ?? firstValue,
      z: null,
      seriesColumn: null,
      barLayout: 'stacked',
      reason: `Scatter needs two numeric columns. (${auto.reason})`,
    };
  }

  if (forcedType === 'pie') {
    if (firstRow && firstValue && yNumeric && rowCount > 0 && rowCount <= PIE_MAX_CATEGORIES) {
      return {
        chartType: 'pie',
        x: firstRow,
        y: firstValue,
        z: null,
        seriesColumn: null,
        barLayout: 'stacked',
        reason: 'Pie: low-cardinality split on the row dimension.',
      };
    }
    return {
      chartType: 'pie',
      x: firstRow,
      y: firstValue,
      z: null,
      seriesColumn: null,
      barLayout: 'stacked',
      reason: `Pie is clearest with few categories. (${auto.reason})`,
    };
  }

  if (forcedType === 'line' || forcedType === 'area') {
    if (xDateLike && yNumeric && firstRow && firstValue && rowCount >= 2) {
      return {
        chartType: forcedType,
        x: firstRow,
        y: firstValue,
        z: null,
        seriesColumn: firstCol,
        barLayout: firstCol ? 'stacked' : 'grouped',
        reason: `${forcedType === 'line' ? 'Line' : 'Area'}: time-like row dimension with a measure.`,
      };
    }
    if (firstRow && firstValue && yNumeric) {
      return {
        chartType: forcedType,
        x: firstRow,
        y: firstValue,
        z: null,
        seriesColumn: firstCol,
        barLayout: firstCol ? 'stacked' : 'grouped',
        reason: barLikeReason(forcedType === 'line' ? 'Line' : 'Area'),
      };
    }
    return {
      chartType: forcedType,
      x: firstRow ?? auto.x,
      y: firstValue ?? auto.y,
      z: null,
      seriesColumn: firstCol,
      barLayout: firstCol ? 'stacked' : 'grouped',
      reason: `Add a row dimension and value measure. (${auto.reason})`,
    };
  }

  if (forcedType === 'bar') {
    if (firstRow && firstValue && yNumeric) {
      return {
        chartType: 'bar',
        x: firstRow,
        y: firstValue,
        z: null,
        seriesColumn: firstCol,
        barLayout: firstCol ? 'stacked' : 'grouped',
        reason: barLikeReason('Bar'),
      };
    }
    return {
      chartType: 'bar',
      x: firstRow ?? auto.x,
      y: firstValue ?? auto.y,
      z: null,
      seriesColumn: firstCol ?? auto.seriesColumn,
      barLayout: firstCol ? 'stacked' : 'grouped',
      reason: auto.reason,
    };
  }

  return auto;
}

