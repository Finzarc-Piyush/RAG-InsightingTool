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

