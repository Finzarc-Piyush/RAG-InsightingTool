import { ChartSpec } from '../shared/schema.js';
import { isTemporalFacetColumnKey } from './temporalFacetColumns.js';
import { findMatchingColumn } from './agents/utils/columnMatcher.js';
import {
  normalizeDateToPeriod,
  DatePeriod,
  parseFlexibleDate,
  detectPeriodFromQuery,
} from './dateUtils.js';
import { inferTemporalGrainFromDates, formatDateForChartAxis } from './temporalGrain.js';
import {
  optimizeChartData,
  inferOptimalPeriodForChartColumn,
} from './chartDownsampling.js';

export type ProcessChartDataOptions = {
  /** Used to pick date bucket (year/month/...) for aggregated line charts and downsampling. */
  chartQuestion?: string;
};

/** Safe object key for pivoted series (Recharts dataKey). */
export function sanitizeSeriesKey(raw: string): string {
  const s = String(raw).trim() || "series";
  return s.replace(/[^\w\u00C0-\u024F]/g, "_").slice(0, 80);
}

/**
 * Long-format rows (xCat, seriesCat, measure) → wide rows for grouped/stacked bars.
 * Mutates chartSpec.seriesKeys with display keys aligned to sanitized keys in rows.
 */
export function pivotLongToWideBar(
  data: Record<string, any>[],
  xCol: string,
  seriesCol: string,
  valueCol: string,
  aggregate: "sum" | "mean" | "count",
  chartSpec: ChartSpec
): { rows: Record<string, any>[]; seriesKeys: string[] } {
  const pairMap = new Map<string, number[]>();
  const xOrder: string[] = [];
  const xSeen = new Set<string>();
  const rawSeriesOrder: string[] = [];
  const seriesSeen = new Set<string>();

  for (const row of data) {
    const xVal = row[xCol];
    const sVal = row[seriesCol];
    if (xVal === null || xVal === undefined || xVal === "") continue;
    if (sVal === null || sVal === undefined || sVal === "") continue;
    const xv = String(xVal);
    const sv = String(sVal);
    if (!xSeen.has(xv)) {
      xSeen.add(xv);
      xOrder.push(xv);
    }
    if (!seriesSeen.has(sv)) {
      seriesSeen.add(sv);
      rawSeriesOrder.push(sv);
    }
    const key = `${xv}\u0000${sv}`;
    const n = toNumber(row[valueCol]);
    if (isNaN(n)) continue;
    if (!pairMap.has(key)) pairMap.set(key, []);
    pairMap.get(key)!.push(n);
  }

  const displayToSanitized = new Map<string, string>();
  const usedSan = new Set<string>();
  for (const raw of rawSeriesOrder) {
    let san = sanitizeSeriesKey(raw);
    if (usedSan.has(san)) {
      let i = 2;
      while (usedSan.has(`${san}_${i}`)) i++;
      san = `${san}_${i}`;
    }
    usedSan.add(san);
    displayToSanitized.set(raw, san);
  }

  const seriesKeys = rawSeriesOrder.map((r) => displayToSanitized.get(r)!);

  const rows: Record<string, any>[] = [];
  for (const xv of xOrder) {
    const out: Record<string, any> = { [xCol]: xv };
    for (const rawS of rawSeriesOrder) {
      const san = displayToSanitized.get(rawS)!;
      const key = `${xv}\u0000${rawS}`;
      const vals = pairMap.get(key);
      let v = 0;
      if (vals && vals.length > 0) {
        if (aggregate === "sum" || aggregate === "count") {
          v = aggregate === "count" ? vals.length : vals.reduce((a, b) => a + b, 0);
        } else {
          v = vals.reduce((a, b) => a + b, 0) / vals.length;
        }
      }
      out[san] = v;
    }
    rows.push(out);
  }

  chartSpec.seriesKeys = seriesKeys;
  return { rows, seriesKeys };
}

function processHeatmapLongData(
  data: Record<string, any>[],
  rowCol: string,
  colCol: string,
  valueCol: string
): Record<string, any>[] {
  const cellMap = new Map<string, { row: string; col: string; values: number[] }>();

  for (const row of data) {
    const rv = row[rowCol];
    const cv = row[colCol];
    if (rv === null || rv === undefined || rv === "") continue;
    if (cv === null || cv === undefined || cv === "") continue;
    const rk = String(rv);
    const ck = String(cv);
    const key = `${rk}\u0000${ck}`;
    const n = toNumber(row[valueCol]);
    if (isNaN(n)) continue;
    if (!cellMap.has(key)) {
      cellMap.set(key, { row: rk, col: ck, values: [] });
    }
    cellMap.get(key)!.values.push(n);
  }

  const out: Record<string, any>[] = [];
  for (const { row, col, values } of cellMap.values()) {
    const v = values.reduce((a, b) => a + b, 0);
    out.push({
      [rowCol]: convertValueForSchema(row),
      [colCol]: convertValueForSchema(col),
      [valueCol]: v,
    });
  }
  return out;
}

// Maximum data points for visualization to ensure good performance
// Updated to 5000 as per requirements - all downsampling now handled by chartDownsampling.ts
const MAX_POINTS_LINE_CHART = 5000;  // For line/area charts
const MAX_POINTS_SCATTER = 5000;     // For scatter plots
const MAX_POINTS_CORRELATION = 5000; // For correlation charts

// Helper to clean numeric values (strip %, commas, etc.)
function toNumber(value: any): number {
  if (value === null || value === undefined || value === '') return NaN;
  const cleaned = String(value).replace(/[%,]/g, '').trim();
  return Number(cleaned);
}

// Helper function to convert Date objects to strings for schema validation
function convertValueForSchema(value: any): string | number | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') return isNaN(value) || !isFinite(value) ? null : value;
  if (typeof value === 'string') return value;
  // For other types, convert to string
  return String(value);
}

/**
 * Largest-Triangle-Three-Buckets (LTTB) downsampling algorithm
 * Preserves visual shape better than simple decimation for line charts
 * Based on: https://github.com/sveinn-steinarsson/flot-downsample
 */
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

  sampled.push(data[a]); // Always add the first point

  for (let i = 0; i < threshold - 2; i++) {
    // Calculate point range for this bucket
    rangeA = Math.floor((i + 1) * every) + 1;
    rangeB = Math.floor((i + 2) * every) + 1;
    if (rangeB > dataLength) {
      rangeB = dataLength;
    }

    // Calculate point range average point
    const avgX = (data[rangeA][xKey] + data[rangeB][xKey]) / 2;
    const avgY = (data[rangeA][yKey] + data[rangeB][yKey]) / 2;

    // Get the range for this bucket
    const rangeOffs = Math.floor((i + 0) * every) + 1;
    const rangeTo = Math.floor((i + 1) * every) + 1;

    // Point a
    const pointAX = data[a][xKey];
    const pointAY = data[a][yKey];

    maxArea = -1;
    maxAreaPoint = data[rangeOffs];

    for (let j = rangeOffs; j < rangeTo && j < dataLength; j++) {
      // Calculate triangle area over three buckets
      area = Math.abs(
        (pointAX - avgX) * (data[j][yKey] - pointAY) -
        (pointAX - data[j][xKey]) * (avgY - pointAY)
      ) * 0.5;
      if (area > maxArea) {
        maxArea = area;
        maxAreaPoint = data[j];
        nextA = j; // Next a is this b
      }
    }

    sampled.push(maxAreaPoint);
    a = nextA; // This a is the next a (chosen b)
  }

  sampled.push(data[dataLength - 1]); // Always add last point

  return sampled;
}

/**
 * Smart downsampling for scatter plots
 * Uses stratified sampling to ensure good coverage across the data range
 */
function downsampleScatter(
  data: Record<string, any>[],
  xKey: string,
  yKey: string,
  threshold: number
): Record<string, any>[] {
  if (data.length <= threshold) {
    return data;
  }

  // Sort data by x values for better sampling
  const sorted = [...data].sort((a, b) => {
    const aVal = toNumber(a[xKey]);
    const bVal = toNumber(b[xKey]);
    if (isNaN(aVal) || isNaN(bVal)) return 0;
    return aVal - bVal;
  });

  // Use stratified sampling: divide into buckets and sample evenly from each
  const bucketSize = Math.ceil(sorted.length / threshold);
  const sampled: Record<string, any>[] = [];

  for (let i = 0; i < sorted.length; i += bucketSize) {
    const bucket = sorted.slice(i, Math.min(i + bucketSize, sorted.length));
    // Take the middle point from each bucket (or first if bucket is small)
    const index = Math.floor(bucket.length / 2);
    sampled.push(bucket[index]);
  }

  // Ensure we don't exceed threshold
  if (sampled.length > threshold) {
    const step = Math.floor(sampled.length / threshold);
    return sampled.filter((_, idx) => idx % step === 0).slice(0, threshold);
  }

  return sampled;
}

/**
 * Simple decimation downsampling (fallback for non-numeric x-axis)
 */
function downsampleSimple(
  data: Record<string, any>[],
  threshold: number
): Record<string, any>[] {
  if (data.length <= threshold) {
    return data;
  }

  const step = Math.floor(data.length / threshold);
  return data.filter((_, idx) => idx % step === 0).slice(0, threshold);
}

function parseDate(value: unknown): Date | null {
  if (value instanceof Date && !isNaN(value.getTime())) return value;
  return null;
}

function coerceChartDate(raw: unknown): Date | null {
  if (raw instanceof Date && !isNaN(raw.getTime())) return raw;
  if (typeof raw === "string") {
    const d = parseFlexibleDate(raw);
    return d && !isNaN(d.getTime()) ? d : null;
  }
  return null;
}

/** X is temporal if listed in dateColumns or is a precomputed __tf_* facet (derived from dates). */
function xColumnIsDeclaredDate(
  xSpec: string,
  available: string[],
  declared?: string[]
): boolean {
  const mx = findMatchingColumn(xSpec, available) || xSpec;
  if (isTemporalFacetColumnKey(mx)) return true;
  if (!declared?.length) return false;
  return declared.some((d) => (findMatchingColumn(d, available) || d) === mx);
}

function chartXLooksTemporal(xCol: string, rows: Record<string, any>[], profileSaysDate: boolean): boolean {
  if (!profileSaysDate || rows.length === 0) return false;
  return rows.some((r) => coerceChartDate(r[xCol]) !== null);
}

/** Format X for display when values are real Date instances (no string parsing). */
function applyTemporalXAxisLabels(
  rows: Record<string, any>[],
  xCol: string,
  profileSaysDate: boolean
): Record<string, any>[] {
  if (rows.length === 0 || !chartXLooksTemporal(xCol, rows, profileSaysDate)) return rows;
  const dates: Date[] = [];
  for (const row of rows) {
    const p = coerceChartDate(row[xCol]);
    if (p) dates.push(p);
  }
  if (dates.length === 0) return rows;
  const grain = inferTemporalGrainFromDates(dates);
  return rows.map((row) => {
    const p = coerceChartDate(row[xCol]);
    if (!p) return row;
    return { ...row, [xCol]: formatDateForChartAxis(p, grain) };
  });
}

function compareValues(a: any, b: any, xIsDeclaredDate: boolean): number {
  const aStr = String(a);
  const bStr = String(b);
  if (xIsDeclaredDate) {
    const aDate = a instanceof Date && !isNaN(a.getTime()) ? a : null;
    const bDate = b instanceof Date && !isNaN(b.getTime()) ? b : null;
    if (aDate && bDate) return aDate.getTime() - bDate.getTime();
    const aCoerced = aDate ?? coerceChartDate(a);
    const bCoerced = bDate ?? coerceChartDate(b);
    if (aCoerced && bCoerced) return aCoerced.getTime() - bCoerced.getTime();
    if (aCoerced && !bCoerced) return -1;
    if (!aCoerced && bCoerced) return 1;
  }
  return aStr.localeCompare(bStr);
}

/**
 * Process data in batches synchronously for large datasets
 * Used for aggregations that need to be merged
 */
function processChartDataSyncStreaming(
  data: Record<string, any>[],
  chartSpec: ChartSpec
): Record<string, any>[] {
  const batchSize = 10000;
  const { x, y, aggregate = 'none' } = chartSpec;
  const availableColumns = Object.keys(data[0] || {});
  const matchedX = findMatchingColumn(x, availableColumns) || x;
  const matchedY = findMatchingColumn(y, availableColumns) || y;
  
  console.log(`📊 Processing ${data.length} rows in batches of ${batchSize} for aggregation`);
  
  const batchResults: Record<string, any>[][] = [];
  for (let i = 0; i < data.length; i += batchSize) {
    const batch = data.slice(i, i + batchSize);
    const batchResult = processChartData(batch, { ...chartSpec, aggregate: 'none' }); // Process without aggregation first
    // Then aggregate this batch
    const aggregated = aggregateData(batchResult, matchedX, matchedY, aggregate);
    batchResults.push(aggregated);
  }
  
  // Merge aggregated results
  return mergeAggregatedResults(batchResults, matchedX, matchedY, aggregate);
}

/**
 * Process data in batches for large datasets
 * This reduces memory usage and improves performance for datasets >10k rows
 */
async function processInBatches<T>(
  data: Record<string, any>[],
  batchSize: number,
  processor: (batch: Record<string, any>[]) => T
): Promise<T[]> {
  const batches: T[] = [];
  for (let i = 0; i < data.length; i += batchSize) {
    const batch = data.slice(i, i + batchSize);
    batches.push(processor(batch));
  }
  return batches;
}

/**
 * Merge aggregated results from multiple batches
 * Used when processing large datasets in batches
 */
function mergeAggregatedResults(
  batchResults: Record<string, any>[][],
  groupBy: string,
  valueColumn: string,
  aggregateType: string
): Record<string, any>[] {
  if (batchResults.length === 0) return [];
  if (batchResults.length === 1) return batchResults[0];
  
  const merged = new Map<string, { values: number[]; displayLabel?: string }>();
  
  for (const batchResult of batchResults) {
    for (const row of batchResult) {
      const key = String(row[groupBy]);
      const value = toNumber(row[valueColumn]);
      
      if (!isNaN(value)) {
        if (!merged.has(key)) {
          merged.set(key, { values: [], displayLabel: row[groupBy] });
        }
        merged.get(key)!.values.push(value);
      }
    }
  }
  
  const result: Record<string, any>[] = [];
  for (const [key, { values, displayLabel }] of Array.from(merged.entries())) {
    let aggregatedValue: number;
    switch (aggregateType) {
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
      [groupBy]: displayLabel || key,
      [valueColumn]: aggregatedValue,
    });
  }
  
  return result;
}

/**
 * Process chart data with streaming support for large datasets
 */
export async function processChartDataStreaming(
  data: Record<string, any>[],
  chartSpec: ChartSpec,
  batchSize: number = 10000,
  declaredDateColumns?: string[]
): Promise<Record<string, any>[]> {
  const { type, aggregate = 'none' } = chartSpec;
  
  // For large datasets with aggregation, use batch processing
  if (data.length > batchSize && aggregate !== 'none') {
    console.log(`📊 Processing ${data.length} rows in batches of ${batchSize} for aggregation`);
    
    const batchResults = await processInBatches(
      data,
      batchSize,
      (batch) => {
        // Process each batch as if it were the full dataset
        // We'll merge the results afterward
        const tempSpec = { ...chartSpec };
        return processChartData(batch, tempSpec, declaredDateColumns);
      }
    );
    
    // Merge aggregated results
    const { x, y } = chartSpec;
    const availableColumns = Object.keys(data[0] || {});
    const matchedX = findMatchingColumn(x, availableColumns) || x;
    const matchedY = findMatchingColumn(y, availableColumns) || y;
    
    return mergeAggregatedResults(batchResults, matchedX, matchedY, aggregate);
  }
  
  // For non-aggregated or small datasets, use regular processing
  return processChartData(data, chartSpec, declaredDateColumns, undefined);
}

function datePeriodHintFromOptions(options?: ProcessChartDataOptions): DatePeriod | null {
  if (!options?.chartQuestion?.trim()) return null;
  return detectPeriodFromQuery(options.chartQuestion);
}

export function processChartData(
  data: Record<string, any>[],
  chartSpec: ChartSpec,
  declaredDateColumns?: string[],
  options?: ProcessChartDataOptions
): Record<string, any>[] {
  const periodHint = datePeriodHintFromOptions(options);
  const {
    type,
    x,
    y,
    y2,
    aggregate = "none",
    z: zColSpec,
    seriesColumn: seriesColSpec,
    y2Series: y2SeriesSpec = [],
  } = chartSpec;
  
  console.log(`🔍 Processing chart: "${chartSpec.title}"`);
  console.log(`   Type: ${type}, X: "${x}", Y: "${y}", Aggregate: ${aggregate}`);
  
  // Check if data is empty
  if (!data || data.length === 0) {
    console.warn(`❌ No data provided for chart: ${chartSpec.title}`);
    return [];
  }
  
  console.log(`   Data rows available: ${data.length}`);

  const availForEarly = Object.keys(data[0] || {});
  const xIsDateEarly = xColumnIsDeclaredDate(x, availForEarly, declaredDateColumns);

  // For large datasets without aggregation, use streaming for line/area charts
  if (
    data.length > 10000 &&
    (type === "line" || type === "area") &&
    aggregate === "none" &&
    !seriesColSpec
  ) {
    console.log(`📊 Large dataset detected (${data.length} rows), processing in batches`);
    // Process synchronously in batches for line/area charts
    const batchSize = 10000;
    const result: Record<string, any>[] = [];
    for (let i = 0; i < data.length; i += batchSize) {
      const batch = data.slice(i, i + batchSize);
      const batchResult = processChartData(
        batch,
        { ...chartSpec },
        declaredDateColumns,
        options
      );
      result.push(...batchResult);
    }
    // Sort the merged result
    const availableColumns = Object.keys(data[0] || {});
    const matchedX = findMatchingColumn(x, availableColumns) || x;
    return result.sort((a, b) => compareValues(a[matchedX], b[matchedX], xIsDateEarly));
  }
  
  // Check if columns exist in data
  const firstRow = data[0];
  if (!firstRow) {
    console.warn(`❌ No rows in data for chart: ${chartSpec.title}`);
    return [];
  }
  
  const availableColumns = Object.keys(firstRow);
  console.log(`   Available columns: [${availableColumns.join(', ')}]`);
  
  // Use flexible column matching instead of exact hasOwnProperty checks
  // This handles whitespace differences, case variations, and other imperfections
  const matchedX = findMatchingColumn(x, availableColumns);
  const matchedY = findMatchingColumn(y, availableColumns);
  let matchedY2 = y2 ? findMatchingColumn(y2, availableColumns) : null;
  let matchedZ =
    type === "heatmap" && zColSpec
      ? findMatchingColumn(zColSpec, availableColumns)
      : null;

  if (!matchedX) {
    console.warn(`❌ Column "${x}" not found in data for chart: ${chartSpec.title}`);
    console.log(`   Available columns: [${availableColumns.join(', ')}]`);
    return [];
  }
  
  if (!matchedY) {
    console.warn(`❌ Column "${y}" not found in data for chart: ${chartSpec.title}`);
    console.log(`   Available columns: [${availableColumns.join(', ')}]`);
    return [];
  }

  if (type === "heatmap") {
    if (!zColSpec) {
      console.warn(`❌ Heatmap requires "z" value column for chart: ${chartSpec.title}`);
      return [];
    }
    if (!matchedZ) {
      matchedZ = findMatchingColumn(zColSpec, availableColumns);
    }
    if (!matchedZ) {
      console.warn(`❌ Column "${zColSpec}" (z) not found for heatmap: ${chartSpec.title}`);
      return [];
    }
  }
  
  // Optional secondary series existence check (for dual-axis line charts)
  if (y2 && !matchedY2) {
    console.warn(`❌ Column "${y2}" not found in data for secondary series of chart: ${chartSpec.title}`);
    console.log(`   Available columns: [${availableColumns.join(', ')}]`);
    console.log(`   Attempting fuzzy matching for y2 column...`);
    // Try more aggressive fuzzy matching
    const y2Lower = y2.toLowerCase().trim();
    const fuzzyMatch = availableColumns.find(col => {
      const colLower = col.toLowerCase().trim();
      return colLower.includes(y2Lower) || y2Lower.includes(colLower) || 
             colLower.replace(/\s+/g, '').includes(y2Lower.replace(/\s+/g, '')) ||
             y2Lower.replace(/\s+/g, '').includes(colLower.replace(/\s+/g, ''));
    });
    if (fuzzyMatch) {
      console.log(`   ✅ Found fuzzy match for y2: "${y2}" -> "${fuzzyMatch}"`);
      matchedY2 = fuzzyMatch;
    } else {
      console.error(`   ❌ No match found for y2 column "${y2}". Chart will only show primary Y series.`);
    }
  }
  
  // Update chart spec with matched column names to ensure consistency
  chartSpec.x = matchedX;
  chartSpec.y = matchedY;
  if (type === "heatmap" && matchedZ) {
    chartSpec.z = matchedZ;
  }
  if (y2 && matchedY2) {
    chartSpec.y2 = matchedY2;
  } else if (y2 && !matchedY2) {
    // Remove y2 from spec if column not found
    console.warn(`   ⚠️ Removing y2 from chart spec because column "${y2}" was not found`);
    delete (chartSpec as any).y2;
    delete (chartSpec as any).y2Label;
  }

  const matchedY2Series: string[] = [];
  for (const name of y2SeriesSpec) {
    const m = findMatchingColumn(name, availableColumns);
    if (m) matchedY2Series.push(m);
    else
      console.warn(
        `   ⚠️ y2Series column "${name}" not found for chart: ${chartSpec.title}`
      );
  }
  if (matchedY2Series.length) {
    (chartSpec as ChartSpec & { y2Series?: string[] }).y2Series = matchedY2Series;
  } else if (y2SeriesSpec.length) {
    delete (chartSpec as any).y2Series;
  }

  // Use matched column names for data access
  const xCol = matchedX;
  const yCol = matchedY;
  const y2Col = matchedY2;
  const zCol = matchedZ;
  const xIsDateCol = xColumnIsDeclaredDate(x, availableColumns, declaredDateColumns);

  // Check for valid data in the columns (using matched column names)
  // For bar charts, we'll validate after aggregation since we filter non-numeric values during aggregation
  const shouldValidateAfterAggregation = type === 'bar' && aggregate && aggregate !== 'none';
  
  if (!shouldValidateAfterAggregation) {
    const xValues = data.map(row => row[xCol]).filter(v => v !== null && v !== undefined && v !== '');
    const yValues = data.map(row => row[yCol]).filter(v => v !== null && v !== undefined && v !== '');
    const y2Values = y2Col ? data.map(row => row[y2Col]).filter(v => v !== null && v !== undefined && v !== '') : [];
    
    console.log(`   X column "${xCol}" (matched from "${x}"): ${xValues.length} valid values (sample: ${xValues.slice(0, 3).join(', ')})`);
    console.log(`   Y column "${yCol}" (matched from "${y}"): ${yValues.length} valid values (sample: ${yValues.slice(0, 3).join(', ')})`);
    if (y2Col) {
      console.log(`   Y2 column "${y2Col}" (matched from "${y2}"): ${y2Values.length} valid values (sample: ${y2Values.slice(0, 3).join(', ')})`);
    } else if (y2) {
      console.warn(`   ⚠️ Y2 column "${y2}" was requested but not found. Chart will only show primary Y series.`);
    }
    
    if (xValues.length === 0) {
      console.warn(`❌ No valid X values in column "${xCol}" for chart: ${chartSpec.title}`);
      return [];
    }
    
    if (type !== "heatmap" && yValues.length === 0) {
      console.warn(`❌ No valid Y values in column "${yCol}" for chart: ${chartSpec.title}`);
      return [];
    }
    if (type === "heatmap" && zCol) {
      const zVals = data
        .map((row) => row[zCol])
        .filter((v) => v !== null && v !== undefined && v !== "");
      if (zVals.length === 0) {
        console.warn(`❌ No valid Z values in column "${zCol}" for heatmap: ${chartSpec.title}`);
        return [];
      }
    }
  } else {
    // For bar charts with aggregation, just check that columns exist
    const hasXColumn = data.length > 0 && data[0].hasOwnProperty(xCol);
    const hasYColumn = data.length > 0 && data[0].hasOwnProperty(yCol);
    
    if (!hasXColumn) {
      console.warn(`❌ Column "${xCol}" not found in data for chart: ${chartSpec.title}`);
      return [];
    }
    
    if (!hasYColumn) {
      console.warn(`❌ Column "${yCol}" not found in data for chart: ${chartSpec.title}`);
      return [];
    }
    
    console.log(`   Bar chart with aggregation - will validate after aggregation`);
  }

  if (type === 'scatter') {
    // For scatter plots, filter numeric values and sample if needed
    let scatterData = data
      .map((row) => {
        const xValue = toNumber(row[xCol]);
        const yValue = toNumber(row[yCol]);
        const mappedRow: Record<string, any> = {
          [xCol]: isNaN(xValue) ? null : xValue,
          [yCol]: isNaN(yValue) ? null : yValue,
        };
        // Convert any Date objects in other columns to strings (in case they're included)
        for (const [key, value] of Object.entries(row)) {
          if (key !== xCol && key !== yCol && value instanceof Date) {
            mappedRow[key] = convertValueForSchema(value);
          }
        }
        return mappedRow;
      })
      .filter((row) => !isNaN(row[xCol]) && !isNaN(row[yCol]));

    console.log(`   Scatter plot: ${scatterData.length} valid numeric points`);

    // Apply optimization to ensure max points limit
    const optimized = optimizeChartData(
      scatterData,
      chartSpec,
      declaredDateColumns,
      periodHint
    );
    if (optimized.length < scatterData.length) {
      console.log(`   ✅ Optimized scatter plot from ${scatterData.length} to ${optimized.length} points`);
    }
    return optimized;
  }

  if (type === "heatmap" && zCol) {
    console.log(`   Processing heatmap: rows="${xCol}", cols="${yCol}", value="${zCol}"`);
    const cells = processHeatmapLongData(data, xCol, yCol, zCol);
    console.log(`   Heatmap cells: ${cells.length}`);
    return cells;
  }

  if (type === 'pie') {
    // Check if data is already aggregated (if number of unique x values equals number of rows)
    const uniqueXValues = new Set(data.map(row => String(row[xCol])));
    const isAlreadyAggregated = uniqueXValues.size === data.length;
    
    let allData: Record<string, any>[];
    
    const isDateCol = xIsDateCol;
    let detectedPeriod: DatePeriod | null = null;
    if (isDateCol && data.some((r) => r[xCol] instanceof Date && !isNaN(r[xCol].getTime()))) {
      detectedPeriod = 'month';
    }
    
    if (isAlreadyAggregated) {
      // Data is already aggregated, but we may still need to normalize dates
      console.log(`   Pie chart: Data is already aggregated (${data.length} unique groups)`);
      
      if (isDateCol && detectedPeriod) {
        // Normalize date values even in already-aggregated data
        console.log(`   Normalizing date values with period: ${detectedPeriod}`);
        const normalizedMap = new Map<string, { displayLabel: string; values: number[] }>();
        
        for (const row of data) {
          const dateValue = String(row[xCol]);
          const normalized = normalizeDateToPeriod(dateValue, detectedPeriod);
          const key = normalized ? normalized.normalizedKey : dateValue;
          const displayLabel = normalized ? normalized.displayLabel : dateValue;
          const yValue = toNumber(row[yCol]);
          
          if (!isNaN(yValue)) {
            if (!normalizedMap.has(key)) {
              normalizedMap.set(key, { displayLabel, values: [] });
            }
            normalizedMap.get(key)!.values.push(yValue);
          }
        }
        
        // Sum up values for each normalized period
        allData = Array.from(normalizedMap.entries()).map(([key, { displayLabel, values }]) => {
          const row: Record<string, any> = {
            [xCol]: displayLabel,
            [yCol]: values.reduce((sum, val) => sum + val, 0),
          };
          // Ensure no Date objects
          for (const [k, v] of Object.entries(row)) {
            row[k] = convertValueForSchema(v);
          }
          return row;
        }).sort((a, b) => toNumber(b[yCol]) - toNumber(a[yCol]));
        
        console.log(`   After normalization: ${allData.length} unique periods`);
      } else {
        // Not a date column or no period detected, use as-is
      allData = data
        .map(row => {
          const mappedRow: Record<string, any> = {
            [xCol]: convertValueForSchema(row[xCol]),
            [yCol]: toNumber(row[yCol]),
          };
          return mappedRow;
        })
        .filter(row => !isNaN(row[yCol]))
        .sort((a, b) => toNumber(b[yCol]) - toNumber(a[yCol]));
      }
    } else {
      // Need to aggregate
      const effectiveAggregate = aggregate === 'none' ? 'sum' : aggregate || 'sum';
      console.log(`   Processing pie chart with aggregation: ${effectiveAggregate}`);
      const aggregated = aggregateData(data, xCol, yCol, effectiveAggregate, detectedPeriod, isDateCol);
      console.log(`   Aggregated data points: ${aggregated.length}`);
      // Convert Date objects to strings for schema validation and sort
      allData = aggregated
        .map(row => {
          const sanitizedRow: Record<string, any> = {};
          for (const [key, value] of Object.entries(row)) {
            sanitizedRow[key] = convertValueForSchema(value);
          }
          return sanitizedRow;
        })
        .sort((a, b) => toNumber(b[yCol]) - toNumber(a[yCol]));
    }
    
    // For pie charts, do not hard-truncate segments.
    // The chart should reflect the complete distribution implied by the aggregated data.
    return allData;
  }

  if (type === 'bar') {
    // Check if this is a correlation bar chart (has 'variable' and 'correlation' columns)
    // Correlation bar charts already have processed data and shouldn't be aggregated
    const isCorrelationBarChart = (xCol === 'variable' && yCol === 'correlation') ||
                                   (data.length > 0 && data[0].hasOwnProperty('variable') && data[0].hasOwnProperty('correlation'));
    
    if (isCorrelationBarChart) {
      // Correlation bar chart - data is already processed, just return as-is
      // The sorting is already done in correlationAnalyzer.ts based on the requested order
      console.log(`   Processing correlation bar chart (data already processed and sorted)`);
      const result = data
        .map(row => ({
          variable: row.variable || row[xCol],
          correlation: toNumber(row.correlation || row[yCol]),
        }))
        .filter(row => !isNaN(row.correlation));
      
      console.log(`   Correlation bar chart result: ${result.length} bars`);
      return result;
    }

    const matchedSeriesCol = seriesColSpec
      ? findMatchingColumn(seriesColSpec, availableColumns)
      : null;
    if (seriesColSpec && matchedSeriesCol && matchedSeriesCol !== xCol) {
      const eff =
        aggregate === "none" || !aggregate ? "sum" : (aggregate as "sum" | "mean" | "count");
      console.log(
        `   Multi-series bar: x="${xCol}", series="${matchedSeriesCol}", measure="${yCol}", layout=${chartSpec.barLayout || "stacked"}`
      );
      chartSpec.seriesColumn = matchedSeriesCol;
      const { rows: wideRows } = pivotLongToWideBar(
        data,
        xCol,
        matchedSeriesCol,
        yCol,
        eff,
        chartSpec
      );
      let result = wideRows;
      if (xIsDateCol) {
        result = [...wideRows].sort((a, b) =>
          compareValues(a[xCol], b[xCol], true)
        );
        result = applyTemporalXAxisLabels(result, xCol, xIsDateCol);
      } else {
        const sk = chartSpec.seriesKeys || [];
        const sortKey = sk[0] || yCol;
        result = [...wideRows].sort(
          (a, b) => toNumber(b[sortKey]) - toNumber(a[sortKey])
        );
      }
      console.log(`   Multi-series bar result: ${result.length} groups`);
      return result;
    }
    
    // Regular bar chart - aggregate and sort appropriately
    console.log(`   Processing bar chart with aggregation: ${aggregate || 'sum'}`);
    const isDateCol = xIsDateCol;
    let detectedPeriod: DatePeriod | null = null;
    if (isDateCol && data.some((r) => r[xCol] instanceof Date && !isNaN(r[xCol].getTime()))) {
      detectedPeriod = 'month';
    }
    const effectiveAggregate = aggregate === 'none' ? 'sum' : aggregate || 'sum';
    console.log(`   Processing bar chart with aggregation: ${effectiveAggregate}`);
    const aggregated = aggregateData(data, xCol, yCol, effectiveAggregate, detectedPeriod, isDateCol);
    console.log(`   Aggregated data points: ${aggregated.length}`);
    
    // Validate aggregated results - ensure we have data after aggregation
    if (aggregated.length === 0) {
      console.warn(`❌ No valid aggregated data points for bar chart. Check that "${xCol}" and "${yCol}" columns exist and "${yCol}" contains numeric values.`);
      return [];
    }
    
    let result: Record<string, any>[];
    if (xIsDateCol) {
      console.log(`   X-axis is a profile date column; sorting chronologically (including string dates)`);
      result = aggregated.sort((a, b) => compareValues(a[xCol], b[xCol], true));
    } else {
      result = aggregated.sort((a, b) => toNumber(b[yCol]) - toNumber(a[yCol]));
    }

    // Convert Date objects to strings for schema validation
    result = result.map((row) => {
      const sanitizedRow: Record<string, any> = {};
      for (const [key, value] of Object.entries(row)) {
        sanitizedRow[key] = convertValueForSchema(value);
      }
      return sanitizedRow;
    });

    console.log(`   Bar chart result: ${result.length} bars`);
    return xIsDateCol ? applyTemporalXAxisLabels(result, xCol, xIsDateCol) : result;
  }

  if (type === 'line' || type === 'area') {
    console.log(`   Processing ${type} chart`);

    const matchedSeriesColForLine = seriesColSpec
      ? findMatchingColumn(seriesColSpec, availableColumns)
      : null;
    if (seriesColSpec && matchedSeriesColForLine && matchedSeriesColForLine !== xCol) {
      const eff =
        aggregate === "none" || !aggregate ? "sum" : (aggregate as "sum" | "mean" | "count");
      chartSpec.seriesColumn = matchedSeriesColForLine;
      console.log(
        `   Multi-series ${type}: x="${xCol}", series="${matchedSeriesColForLine}", measure="${yCol}", aggregate=${eff}`
      );
      const { rows: wideRows } = pivotLongToWideBar(
        data,
        xCol,
        matchedSeriesColForLine,
        yCol,
        eff,
        chartSpec
      );
      let result = wideRows;
      if (xIsDateCol) {
        result = [...wideRows].sort((a, b) => compareValues(a[xCol], b[xCol], true));
        result = applyTemporalXAxisLabels(result, xCol, xIsDateCol);
      } else {
        const sk = chartSpec.seriesKeys || [];
        const sortKey = sk[0] || yCol;
        result = [...wideRows].sort((a, b) => toNumber(b[sortKey]) - toNumber(a[sortKey]));
      }
      const optimized = optimizeChartData(
        result,
        chartSpec,
        declaredDateColumns,
        periodHint
      );
      console.log(`   Multi-series ${type} result: ${optimized.length} points`);
      return applyTemporalXAxisLabels(optimized, xCol, xIsDateCol);
    }

    const CHART_REPAIR_MIN_ROWS = 64;
    if (
      !seriesColSpec &&
      (!aggregate || aggregate === "none") &&
      data.length > CHART_REPAIR_MIN_ROWS &&
      periodHint &&
      periodHint !== "monthOnly" &&
      data
        .slice(0, Math.min(120, data.length))
        .some((r) => coerceChartDate(r[xCol]) !== null)
    ) {
      console.warn(
        `[chart_time_bucket_repair] ${type} "${chartSpec.title}": ${data.length} rows, questionPeriod=${periodHint} — applying sum bucket`
      );
      const aggregated = aggregateData(data, xCol, yCol, "sum", periodHint, true);
      let repaired = aggregated.sort((a, b) =>
        compareValues(a[xCol], b[xCol], xIsDateCol)
      );
      repaired = repaired.map((row) => {
        const sanitizedRow: Record<string, any> = {};
        for (const [key, value] of Object.entries(row)) {
          sanitizedRow[key] = convertValueForSchema(value);
        }
        return sanitizedRow;
      });
      const optimized = optimizeChartData(
        repaired,
        chartSpec,
        declaredDateColumns,
        periodHint
      );
      if (optimized.length < repaired.length) {
        console.log(
          `   ✅ Optimized from ${repaired.length} to ${optimized.length} points after repair aggregation`
        );
      }
      console.log(
        `   ${type} chart result (repaired): ${optimized.length} points (sorted chronologically)`
      );
      return applyTemporalXAxisLabels(optimized, xCol, xIsDateCol);
    }

    // Sort by x and optionally aggregate
    if (aggregate && aggregate !== 'none') {
      console.log(`   Using aggregation: ${aggregate}`);
      const isDateCol = xIsDateCol;
      let detectedPeriod: DatePeriod | null = periodHint;
      if (!detectedPeriod && isDateCol) {
        detectedPeriod = inferOptimalPeriodForChartColumn(data, xCol);
      }
      if (
        !detectedPeriod &&
        isDateCol &&
        data.some((r) => coerceChartDate(r[xCol]) !== null)
      ) {
        detectedPeriod = 'month';
      }
      const valueColsMulti = [
        yCol,
        ...(y2Col ? [y2Col] : []),
        ...matchedY2Series.filter((c) => c !== yCol && c !== y2Col),
      ];
      const uniqueValueCols = [...new Set(valueColsMulti)];
      const aggregated =
        uniqueValueCols.length > 1 ?
          aggregateDataMulti(
            data,
            xCol,
            uniqueValueCols,
            aggregate,
            detectedPeriod,
            isDateCol
          )
        : aggregateData(data, xCol, yCol, aggregate, detectedPeriod, isDateCol);
      console.log(`   Aggregated data points: ${aggregated.length}`);
      // Use date-aware sorting
      let result = aggregated.sort((a, b) => compareValues(a[xCol], b[xCol], xIsDateCol));
      // Convert Date objects to strings for schema validation
      result = result.map((row) => {
        const sanitizedRow: Record<string, any> = {};
        for (const [key, value] of Object.entries(row)) {
          sanitizedRow[key] = convertValueForSchema(value);
        }
        return sanitizedRow;
      });

      // Apply optimization to ensure max points limit
      const optimized = optimizeChartData(
        result,
        chartSpec,
        declaredDateColumns,
        periodHint
      );
      if (optimized.length < result.length) {
        console.log(
          `   ✅ Optimized from ${result.length} to ${optimized.length} points after aggregation`
        );
      }

      console.log(
        `   ${type} chart result: ${optimized.length} points (sorted chronologically)`
      );
      return applyTemporalXAxisLabels(optimized, xCol, xIsDateCol);
    }

    let result = data
      .map((row) => {
        const mappedRow: Record<string, any> = {
          [xCol]: convertValueForSchema(row[xCol]),
          [yCol]: toNumber(row[yCol]),
        };

        // Include y2 if it was requested, but only if it's a valid number
        // Convert NaN to null so schema validation passes (null is acceptable)
        if (y2Col) {
          const y2Value = toNumber(row[y2Col]);
          // Only include y2 field if it's a valid number, otherwise omit it
          // This prevents NaN from being sent to frontend and causing validation errors
          if (!isNaN(y2Value) && isFinite(y2Value)) {
            mappedRow[y2Col] = y2Value;
          }
          // If NaN, we simply don't include the y2 field - frontend will handle missing values
        }
        for (const scol of matchedY2Series) {
          if (scol === yCol || scol === y2Col) continue;
          const sv = toNumber(row[scol]);
          if (!isNaN(sv) && isFinite(sv)) {
            mappedRow[scol] = sv;
          }
        }

        return mappedRow;
      })
      .filter((row) => {
        // Keep row if primary Y is valid (required)
        const yValid = !isNaN(row[yCol]) && isFinite(row[yCol]);
        if (!yValid) return false;
        
        // For y2: if y2Col exists, we want to include rows even if y2 is missing/NaN
        // (so we can show primary Y series even if y2 has no data)
        // The y2 field will simply be omitted from the row if it's NaN
        return true;
      })
      .sort((a, b) => compareValues(a[xCol], b[xCol], xIsDateCol));
    
    // Log y2 data availability
    if (y2Col) {
      const y2ValidCount = result.filter(row => y2Col in row && !isNaN(row[y2Col]) && isFinite(row[y2Col])).length;
      const y2TotalCount = result.length;
      const y2MissingCount = y2TotalCount - y2ValidCount;
      console.log(`   Y2 column "${y2Col}": ${y2ValidCount}/${y2TotalCount} rows have valid numeric values`);
      if (y2ValidCount === 0) {
        console.warn(`   ⚠️ No valid Y2 values found! Chart will only show primary Y series.`);
        // Remove y2 from chart spec if no valid data
        delete (chartSpec as any).y2;
        delete (chartSpec as any).y2Label;
      } else if (y2MissingCount > 0) {
        console.log(`   ℹ️ Y2 has ${y2MissingCount} rows with missing/NaN values (field omitted for those rows)`);
      }
    }
    
    // Apply optimization to ensure max points limit
    const optimized = optimizeChartData(
      result,
      chartSpec,
      declaredDateColumns,
      periodHint
    );
    if (optimized.length < result.length) {
      console.log(`   ✅ Optimized from ${result.length} to ${optimized.length} points`);
    }
    
    console.log(`   ${type} chart result: ${optimized.length} points (sorted chronologically)`);
    return applyTemporalXAxisLabels(optimized, xCol, xIsDateCol);
  }

  console.warn(`❌ Unknown chart type: ${type} for chart: ${chartSpec.title}`);
  return [];
}

function aggregateData(
  data: Record<string, any>[],
  groupBy: string,
  valueColumn: string,
  aggregateType: string,
  datePeriod?: DatePeriod | null,
  isDateColumn?: boolean
): Record<string, any>[] {
  console.log(`     Aggregating by "${groupBy}" with "${aggregateType}" of "${valueColumn}"${datePeriod ? ` (period: ${datePeriod})` : ''}`);
  
  const grouped = new Map<string, { values: number[]; displayLabel?: string }>();
  let validValues = 0;
  let invalidValues = 0;

  for (const row of data) {
    let key: string;
    let displayLabel: string | undefined;
    
    if (isDateColumn && datePeriod) {
      const raw = row[groupBy];
      const d = coerceChartDate(raw);
      const normalized = d ? normalizeDateToPeriod(d, datePeriod) : null;
      if (normalized) {
        key = normalized.normalizedKey;
        displayLabel = normalized.displayLabel;
      } else {
        key = String(row[groupBy]);
      }
    } else {
      key = String(row[groupBy]);
    }
    
    const value = toNumber(row[valueColumn]);

    if (!isNaN(value)) {
      validValues++;
      if (!grouped.has(key)) {
        grouped.set(key, { values: [], displayLabel });
      }
      grouped.get(key)!.values.push(value);
    } else {
      invalidValues++;
    }
  }

  console.log(`     Valid values: ${validValues}, Invalid values: ${invalidValues}`);
  console.log(`     Unique groups: ${grouped.size}`);

  const result: Record<string, any>[] = [];

  for (const [key, { values, displayLabel }] of Array.from(grouped.entries())) {
    let aggregatedValue: number;

    switch (aggregateType) {
      case 'sum':
        aggregatedValue = values.reduce((a: number, b: number) => a + b, 0);
        break;
      case 'mean':
        aggregatedValue = values.reduce((a: number, b: number) => a + b, 0) / values.length;
        break;
      case 'count':
        aggregatedValue = values.length;
        break;
      default:
        aggregatedValue = values[0];
    }

    result.push({
      [groupBy]: displayLabel || key,  // Use display label if available
      [valueColumn]: aggregatedValue,
    });
  }

  console.log(`     Aggregation result: ${result.length} groups`);
  return result;
}

/** Group by the same key as {@link aggregateData}, aggregating multiple numeric columns per group. */
function aggregateDataMulti(
  data: Record<string, any>[],
  groupBy: string,
  valueColumns: string[],
  aggregateType: string,
  datePeriod?: DatePeriod | null,
  isDateColumn?: boolean
): Record<string, any>[] {
  type GroupState = { cols: Map<string, number[]>; displayLabel?: string };
  const grouped = new Map<string, GroupState>();

  for (const row of data) {
    let key: string;
    let displayLabel: string | undefined;

    if (isDateColumn && datePeriod) {
      const raw = row[groupBy];
      const d = coerceChartDate(raw);
      const normalized = d ? normalizeDateToPeriod(d, datePeriod) : null;
      if (normalized) {
        key = normalized.normalizedKey;
        displayLabel = normalized.displayLabel;
      } else {
        key = String(row[groupBy]);
      }
    } else {
      key = String(row[groupBy]);
    }

    if (!grouped.has(key)) {
      grouped.set(key, { cols: new Map(), displayLabel });
    }
    const g = grouped.get(key)!;
    if (displayLabel) g.displayLabel = displayLabel;

    for (const col of valueColumns) {
      const value = toNumber(row[col]);
      if (isNaN(value)) continue;
      if (!g.cols.has(col)) g.cols.set(col, []);
      g.cols.get(col)!.push(value);
    }
  }

  const result: Record<string, any>[] = [];

  for (const [key, { cols, displayLabel }] of grouped.entries()) {
    const out: Record<string, any> = { [groupBy]: displayLabel || key };
    let any = false;
    for (const col of valueColumns) {
      const vals = cols.get(col);
      if (!vals || vals.length === 0) continue;
      any = true;
      let aggregatedValue: number;
      switch (aggregateType) {
        case "sum":
          aggregatedValue = vals.reduce((a: number, b: number) => a + b, 0);
          break;
        case "mean":
          aggregatedValue = vals.reduce((a: number, b: number) => a + b, 0) / vals.length;
          break;
        case "count":
          aggregatedValue = vals.length;
          break;
        default:
          aggregatedValue = vals[0];
      }
      out[col] = aggregatedValue;
    }
    if (any) result.push(out);
  }

  return result;
}
