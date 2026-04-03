/**
 * Time bucketing / resampling helpers used when charts request explicit aggregation.
 * `optimizeChartData` applies `downsampleChartData` (time bucketing + point caps).
 */

import { ChartSpec } from '../shared/schema.js';
import {
  normalizeDateToPeriod,
  DatePeriod,
  parseFlexibleDate,
} from './dateUtils.js';
import { findMatchingColumn } from './agents/utils/columnMatcher.js';

const MAX_CHART_POINTS = 5000;

function toNumber(value: any): number {
  if (value === null || value === undefined || value === '') return NaN;
  if (typeof value === 'number') return isNaN(value) || !isFinite(value) ? NaN : value;
  const cleaned = String(value).replace(/[%,$€£¥₹\s]/g, '').trim();
  return Number(cleaned);
}

/** Date instance or parseable date string (ISO / common numeric formats). */
export function chartCellAsDateLoose(value: unknown): Date | null {
  if (value instanceof Date && !isNaN(value.getTime())) return value;
  if (typeof value === 'string') {
    const d = parseFlexibleDate(value);
    return d && !isNaN(d.getTime()) ? d : null;
  }
  return null;
}

function xIsDeclaredDate(
  xSpec: string,
  available: string[],
  declared?: string[]
): boolean {
  if (!declared?.length) return false;
  const mx = findMatchingColumn(xSpec, available) || xSpec;
  return declared.some((d) => (findMatchingColumn(d, available) || d) === mx);
}

export function resampleTimeSeries(
  data: Record<string, any>[],
  xColumn: string,
  yColumn: string,
  period: DatePeriod = 'day',
  aggregate: 'sum' | 'mean' | 'count' = 'mean'
): Record<string, any>[] {
  if (data.length === 0) return [];

  const grouped = new Map<string, { values: number[]; date: Date | null }>();

  for (const row of data) {
    const date = chartCellAsDateLoose(row[xColumn]);
    const yValue = toNumber(row[yColumn]);

    if (isNaN(yValue)) continue;

    if (date) {
      const normalized = normalizeDateToPeriod(date, period);
      if (normalized) {
        const key = normalized.normalizedKey;
        if (!grouped.has(key)) {
          grouped.set(key, { values: [], date });
        }
        grouped.get(key)!.values.push(yValue);
      }
    } else {
      const key = String(row[xColumn]);
      if (!grouped.has(key)) {
        grouped.set(key, { values: [], date: null });
      }
      grouped.get(key)!.values.push(yValue);
    }
  }

  const result: Record<string, any>[] = [];
  for (const [key, { values }] of grouped.entries()) {
    let aggregatedValue: number;
    switch (aggregate) {
      case 'sum':
        aggregatedValue = values.reduce((a, b) => a + b, 0);
        break;
      case 'mean':
        aggregatedValue = values.reduce((a, b) => a + b, 0) / values.length;
        break;
      case 'count':
        aggregatedValue = values.length;
        break;
      default:
        aggregatedValue = values[0];
    }

    result.push({
      [xColumn]: key,
      [yColumn]: aggregatedValue,
    });
  }

  return result.sort((a, b) => {
    const dateA = chartCellAsDateLoose(a[xColumn]);
    const dateB = chartCellAsDateLoose(b[xColumn]);
    if (dateA && dateB) return dateA.getTime() - dateB.getTime();
    return String(a[xColumn]).localeCompare(String(b[xColumn]));
  });
}

/** Like {@link resampleTimeSeries} but keeps multiple numeric columns (wide multi-series rows). */
export function resampleTimeSeriesMulti(
  data: Record<string, any>[],
  xColumn: string,
  valueColumns: string[],
  period: DatePeriod = "day",
  aggregate: "sum" | "mean" | "count" = "mean"
): Record<string, any>[] {
  if (data.length === 0) return [];

  type Bucket = { perCol: Map<string, number[]>; date: Date | null };
  const grouped = new Map<string, Bucket>();

  for (const row of data) {
    const date = chartCellAsDateLoose(row[xColumn]);
    let key: string;
    let bucketDate: Date | null = null;

    if (date) {
      const normalized = normalizeDateToPeriod(date, period);
      if (!normalized) continue;
      key = normalized.normalizedKey;
      bucketDate = date;
    } else {
      key = String(row[xColumn]);
    }

    if (!grouped.has(key)) {
      grouped.set(key, { perCol: new Map(), date: bucketDate });
    }
    const g = grouped.get(key)!;

    for (const col of valueColumns) {
      const yValue = toNumber(row[col]);
      if (isNaN(yValue)) continue;
      if (!g.perCol.has(col)) g.perCol.set(col, []);
      g.perCol.get(col)!.push(yValue);
    }
  }

  const result: Record<string, any>[] = [];
  for (const [key, { perCol }] of grouped.entries()) {
    const out: Record<string, any> = { [xColumn]: key };
    for (const col of valueColumns) {
      const values = perCol.get(col);
      if (!values || values.length === 0) continue;
      let aggregatedValue: number;
      switch (aggregate) {
        case "sum":
          aggregatedValue = values.reduce((a, b) => a + b, 0);
          break;
        case "mean":
          aggregatedValue = values.reduce((a, b) => a + b, 0) / values.length;
          break;
        case "count":
          aggregatedValue = values.length;
          break;
        default:
          aggregatedValue = values[0];
      }
      out[col] = aggregatedValue;
    }
    if (Object.keys(out).length > 1) result.push(out);
  }

  return result.sort((a, b) => {
    const dateA = chartCellAsDateLoose(a[xColumn]);
    const dateB = chartCellAsDateLoose(b[xColumn]);
    if (dateA && dateB) return dateA.getTime() - dateB.getTime();
    return String(a[xColumn]).localeCompare(String(b[xColumn]));
  });
}

export function inferOptimalPeriodForChartColumn(
  data: Record<string, any>[],
  xColumn: string
): DatePeriod | null {
  return determineOptimalPeriod(data, xColumn);
}

function determineOptimalPeriod(data: Record<string, any>[], xColumn: string): DatePeriod | null {
  if (data.length < 2) return null;

  const dates = data
    .map((row) => chartCellAsDateLoose(row[xColumn]))
    .filter((d): d is Date => d !== null);

  if (dates.length < 2) return null;

  dates.sort((a, b) => a.getTime() - b.getTime());
  const timeSpan = dates[dates.length - 1].getTime() - dates[0].getTime();
  const days = timeSpan / (1000 * 60 * 60 * 24);

  if (days > 365 * 2) return 'year';
  if (days > 90) return 'month';
  if (days > 14) return 'week';
  return 'day';
}

function downsampleLTTB(
  data: Record<string, any>[],
  xKey: string,
  yKey: string,
  threshold: number
): Record<string, any>[] {
  if (data.length <= threshold) {
    return data;
  }

  const dataLength = data.length;
  if (threshold >= dataLength || threshold === 0) {
    return data;
  }

  const sampled: Record<string, any>[] = [];
  const every = (dataLength - 2) / (threshold - 2);
  let a = 0;
  let nextA = 0;
  let maxAreaPoint: Record<string, any>;
  let maxArea: number;
  let area: number;
  let rangeA: number;
  let rangeB: number;

  sampled.push(data[a]);

  for (let i = 0; i < threshold - 2; i++) {
    rangeA = Math.floor((i + 1) * every) + 1;
    rangeB = Math.floor((i + 2) * every) + 1;
    if (rangeB > dataLength) {
      rangeB = dataLength;
    }

    const avgX = (toNumber(data[rangeA][xKey]) + toNumber(data[rangeB][xKey])) / 2;
    const avgY = (toNumber(data[rangeA][yKey]) + toNumber(data[rangeB][yKey])) / 2;

    const rangeOffs = Math.floor((i + 0) * every) + 1;
    const rangeTo = Math.floor((i + 1) * every) + 1;

    const pointAX = toNumber(data[a][xKey]);
    const pointAY = toNumber(data[a][yKey]);

    maxArea = -1;
    maxAreaPoint = data[rangeOffs];

    for (let j = rangeOffs; j < rangeTo && j < dataLength; j++) {
      area =
        Math.abs(
          (pointAX - avgX) * (toNumber(data[j][yKey]) - pointAY) -
            (pointAX - toNumber(data[j][xKey])) * (avgY - pointAY)
        ) * 0.5;
      if (area > maxArea) {
        maxArea = area;
        maxAreaPoint = data[j];
        nextA = j;
      }
    }

    sampled.push(maxAreaPoint);
    a = nextA;
  }

  sampled.push(data[dataLength - 1]);
  return sampled;
}

function aggregateDownsample(
  data: Record<string, any>[],
  xColumn: string,
  yColumn: string,
  maxPoints: number,
  aggregate: 'sum' | 'mean' | 'count'
): Record<string, any>[] {
  if (data.length <= maxPoints) return data;

  const bucketSize = Math.ceil(data.length / maxPoints);
  const result: Record<string, any>[] = [];

  for (let i = 0; i < data.length; i += bucketSize) {
    const bucket = data.slice(i, Math.min(i + bucketSize, data.length));
    if (bucket.length === 0) continue;

    const xValues = bucket.map((row) => row[xColumn]);
    const yValues = bucket.map((row) => toNumber(row[yColumn])).filter((v) => !isNaN(v));

    if (yValues.length === 0) continue;

    let aggregatedY: number;
    switch (aggregate) {
      case 'sum':
        aggregatedY = yValues.reduce((a, b) => a + b, 0);
        break;
      case 'mean':
        aggregatedY = yValues.reduce((a, b) => a + b, 0) / yValues.length;
        break;
      case 'count':
        aggregatedY = yValues.length;
        break;
      default:
        aggregatedY = yValues[0];
    }

    const xRepresentative = xValues[Math.floor(xValues.length / 2)];
    result.push({
      [xColumn]: xRepresentative,
      [yColumn]: aggregatedY,
    });
  }

  return result;
}

function aggregateDownsampleMulti(
  data: Record<string, any>[],
  xColumn: string,
  valueColumns: string[],
  maxPoints: number,
  aggregate: "sum" | "mean" | "count"
): Record<string, any>[] {
  if (data.length <= maxPoints) return data;

  const bucketSize = Math.ceil(data.length / maxPoints);
  const result: Record<string, any>[] = [];

  for (let i = 0; i < data.length; i += bucketSize) {
    const bucket = data.slice(i, Math.min(i + bucketSize, data.length));
    if (bucket.length === 0) continue;

    const xValues = bucket.map((row) => row[xColumn]);
    const xRepresentative = xValues[Math.floor(xValues.length / 2)];
    const out: Record<string, any> = { [xColumn]: xRepresentative };

    for (const col of valueColumns) {
      const yValues = bucket.map((row) => toNumber(row[col])).filter((v) => !isNaN(v));
      if (yValues.length === 0) continue;
      let aggregatedY: number;
      switch (aggregate) {
        case "sum":
          aggregatedY = yValues.reduce((a, b) => a + b, 0);
          break;
        case "mean":
          aggregatedY = yValues.reduce((a, b) => a + b, 0) / yValues.length;
          break;
        case "count":
          aggregatedY = yValues.length;
          break;
        default:
          aggregatedY = yValues[0];
      }
      out[col] = aggregatedY;
    }
    if (Object.keys(out).length > 1) result.push(out);
  }

  return result;
}

export function downsampleChartData(
  data: Record<string, any>[],
  chartSpec: ChartSpec,
  maxPoints: number = MAX_CHART_POINTS,
  declaredDateColumns?: string[],
  datePeriodHint?: DatePeriod | null
): Record<string, any>[] {
  if (data.length === 0) return data;

  const { type, x, y, aggregate = 'none' } = chartSpec;
  const availableColumns = Object.keys(data[0] || {});
  const matchedX = findMatchingColumn(x, availableColumns) || x;
  const matchedY = findMatchingColumn(y, availableColumns) || y;

  const seriesKeysPresent =
    chartSpec.seriesKeys?.filter((k) => availableColumns.includes(k)) ?? [];
  const valueColumns =
    seriesKeysPresent.length > 0 ? seriesKeysPresent : [matchedY];
  const primaryYForLttb = valueColumns[0] ?? matchedY;

  const isDateCol = xIsDeclaredDate(x, availableColumns, declaredDateColumns);
  const hasDates =
    isDateCol &&
    data.some((row) => chartCellAsDateLoose(row[matchedX]) !== null);

  let working = data;

  if (
    (type === 'line' || type === 'area') &&
    hasDates &&
    aggregate === 'none' &&
    working.length > 1
  ) {
    const period =
      datePeriodHint ?? determineOptimalPeriod(working, matchedX);
    if (period) {
      console.log(
        `📊 Time series: bucketing to ${period} (rows=${working.length})`
      );
      working =
        seriesKeysPresent.length > 0 ?
          resampleTimeSeriesMulti(working, matchedX, valueColumns, period, "sum")
        : resampleTimeSeries(working, matchedX, matchedY, period, "sum");
    }
  }

  if (working.length <= maxPoints) return working;

  const { aggregate: agg = 'none' } = chartSpec;

  const hasDatesAfter =
    isDateCol &&
    working.some((row) => chartCellAsDateLoose(row[matchedX]) !== null);

  if ((type === 'line' || type === 'area') && hasDatesAfter && agg === 'none') {
    const period = datePeriodHint ?? determineOptimalPeriod(working, matchedX);
    if (period) {
      console.log(`📊 Time series detected: Resampling to ${period} periods (${working.length} → ~${Math.ceil(working.length / (period === 'day' ? 1 : period === 'week' ? 7 : period === 'month' ? 30 : 365))} points)`);
      const resampled =
        seriesKeysPresent.length > 0 ?
          resampleTimeSeriesMulti(working, matchedX, valueColumns, period, "sum")
        : resampleTimeSeries(working, matchedX, matchedY, period, "sum");
      if (resampled.length > maxPoints) {
        return downsampleLTTB(resampled, matchedX, primaryYForLttb, maxPoints);
      }
      return resampled;
    }
  }

  if (agg !== 'none') {
    console.log(`📊 Using aggregation-based downsampling (${working.length} → ${maxPoints} points)`);
    return seriesKeysPresent.length > 0 ?
        aggregateDownsampleMulti(
          working,
          matchedX,
          valueColumns,
          maxPoints,
          agg as "sum" | "mean" | "count"
        )
      : aggregateDownsample(
          working,
          matchedX,
          matchedY,
          maxPoints,
          agg as "sum" | "mean" | "count"
        );
  }

  if ((type === 'line' || type === 'area') && !hasDatesAfter) {
    const firstX = toNumber(working[0]?.[matchedX]);
    if (!isNaN(firstX)) {
      console.log(`📊 Using LTTB downsampling for line chart (${working.length} → ${maxPoints} points)`);
      return downsampleLTTB(working, matchedX, primaryYForLttb, maxPoints);
    }
  }

  if (type === 'scatter') {
    console.log(`📊 Using stratified sampling for scatter plot (${working.length} → ${maxPoints} points)`);
    return aggregateDownsample(working, matchedX, matchedY, maxPoints, 'mean');
  }

  console.log(`📊 Using simple decimation (${working.length} → ${maxPoints} points)`);
  const step = Math.floor(working.length / maxPoints);
  return working.filter((_, idx) => idx % step === 0).slice(0, maxPoints);
}

export function optimizeChartData(
  data: Record<string, any>[],
  chartSpec: ChartSpec,
  declaredDateColumns?: string[],
  datePeriodHint?: DatePeriod | null
): Record<string, any>[] {
  return downsampleChartData(
    data,
    chartSpec,
    MAX_CHART_POINTS,
    declaredDateColumns,
    datePeriodHint
  );
}
