import { ChartSpec } from '../shared/schema.js';
import { isTemporalFacetColumnKey } from './temporalFacetColumns.js';
import { findMatchingColumn } from './agents/utils/columnMatcher.js';
import {
  normalizeDateToPeriod,
  DatePeriod,
  parseFlexibleDate,
  detectPeriodFromQuery,
} from './dateUtils.js';
import { inferTemporalGrainFromDates } from './temporalGrain.js';
import {
  optimizeChartData,
  inferOptimalPeriodForChartColumn,
} from './chartDownsampling.js';
import { logger } from "./logger.js";
import { KEY_SEP } from "./compositeKey.js";
import { toNumber } from "./numberCoercion.js";

export type ProcessChartDataOptions = {
  /** Used to pick date bucket (year/month/...) for aggregated line charts and downsampling. */
  chartQuestion?: string;
  /** Explicit grain override (from build_chart `grain`); wins over chartQuestion. */
  grain?: DatePeriod | null;
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
    const key = `${xv}${KEY_SEP}${sv}`;
    const n = toNumber(row[valueCol]);
    if (isNaN(n)) continue;
    if (!pairMap.has(key)) pairMap.set(key, []);
    pairMap.get(key)!.push(n);
  }

  // G2-P1.c / P6.b — series cap: replace the legacy "Others" rollup with a
  // Top-N drop-rest pattern. Rolling tail series into a single "Others" bucket
  // produced the famous failure mode where "Others" stacked higher than every
  // named product (the aggregate of N tail items naturally exceeds any
  // individual head item), giving the user a chart where the meaningless
  // rollup dominated the legend. The drop-rest behaviour shows only the
  // genuine top contributors, and a `_chartTruncationNote` is left on
  // chartSpec so the renderer can subtitle "showing top N of M".
  //
  // The cap defaults to MAX_CHART_SERIES_DEFAULT (matching the planner's
  // documented "≤15 series" guidance, lowered to 10 to surface fewer, more
  // legible series). Callers can override via chartSpec._maxSeries (clamped
  // to [3, 20]).
  const MAX_CHART_SERIES_DEFAULT = 10;
  const userMax = (chartSpec as { _maxSeries?: number })._maxSeries;
  const seriesCap =
    typeof userMax === "number" && Number.isFinite(userMax) && userMax > 0
      ? Math.min(20, Math.max(3, Math.floor(userMax)))
      : MAX_CHART_SERIES_DEFAULT;
  const totalSeriesBeforeCap = rawSeriesOrder.length;

  if (rawSeriesOrder.length > seriesCap) {
    const seriesTotals = new Map<string, number>();
    for (const sv of rawSeriesOrder) {
      let total = 0;
      for (const xv of xOrder) {
        const vals = pairMap.get(`${xv}${KEY_SEP}${sv}`);
        if (vals) total += vals.reduce((a, b) => a + b, 0);
      }
      seriesTotals.set(sv, total);
    }
    const sorted = rawSeriesOrder
      .slice()
      .sort((a, b) => (seriesTotals.get(b) ?? 0) - (seriesTotals.get(a) ?? 0));
    const topSet = new Set(sorted.slice(0, seriesCap));

    // Drop the tail series entirely — do NOT roll them into "Others". This
    // is the central fix for P1.c: the chart shows only the genuine top
    // contributors, and a truncation note tells the user the rest were
    // omitted (so they're not surprised by a missing tail).
    for (const sv of rawSeriesOrder) {
      if (topSet.has(sv)) continue;
      for (const xv of xOrder) {
        pairMap.delete(`${xv}${KEY_SEP}${sv}`);
      }
    }
    rawSeriesOrder.length = 0;
    for (const sv of sorted.slice(0, seriesCap)) rawSeriesOrder.push(sv);

    (chartSpec as { _chartTruncationNote?: string })._chartTruncationNote =
      `Showing top ${seriesCap} of ${totalSeriesBeforeCap} ${seriesCol} by total ${valueCol}; ${
        totalSeriesBeforeCap - seriesCap
      } smaller ${seriesCol}${totalSeriesBeforeCap - seriesCap === 1 ? "" : "s"} not displayed.`;
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

  // G2-P6.a — sort x-axis categories descending by total y for non-temporal
  // charts so the visual hierarchy (left → right == biggest → smallest) is
  // meaningful. Temporal charts (line / area) keep chronological order; bar
  // charts on a date-like column also keep their natural order — we detect
  // this conservatively: any xOrder value that parses as a date AND looks
  // date-shaped (yyyy-mm, yyyy, Qn) skips the sort.
  const looksTemporalChart = chartSpec.type === "line" || chartSpec.type === "area";
  const xValuesLookTemporal = xOrder.some((xv) => {
    const parsed = Date.parse(xv);
    return Number.isFinite(parsed) && /\d{4}-\d{2}|^\d{4}$|Q[1-4]/.test(xv);
  });
  if (!looksTemporalChart && !xValuesLookTemporal) {
    const xTotals = new Map<string, number>();
    for (const xv of xOrder) {
      let total = 0;
      for (const rawS of rawSeriesOrder) {
        const vals = pairMap.get(`${xv}${KEY_SEP}${rawS}`);
        if (vals && vals.length > 0) {
          total += vals.reduce((a, b) => a + b, 0);
        }
      }
      xTotals.set(xv, total);
    }
    xOrder.sort((a, b) => (xTotals.get(b) ?? 0) - (xTotals.get(a) ?? 0));
  }

  const rows: Record<string, any>[] = [];
  for (const xv of xOrder) {
    const out: Record<string, any> = { [xCol]: xv };
    for (const rawS of rawSeriesOrder) {
      const san = displayToSanitized.get(rawS)!;
      const key = `${xv}${KEY_SEP}${rawS}`;
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
    const key = `${rk}${KEY_SEP}${ck}`;
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


// Helper function to convert Date objects to strings for schema validation
function convertValueForSchema(value: any): string | number | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') return isNaN(value) || !isFinite(value) ? null : value;
  if (typeof value === 'string') return value;
  // For other types, convert to string
  return String(value);
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

/** Canonical period-key shapes — YYYY, YYYY-MM, YYYY-Qn, YYYY-Hn, YYYY-Www, YYYY-MM-DD.
 * Mirrors `parseTemporalLabelSortKey` / `PERIOD_ISO_GRAIN_RE`. */
const CANONICAL_PERIOD_KEY_RE =
  /^\d{4}(-(Q[1-4]|H[12]|W\d{2}|\d{2}|\d{2}-\d{2}))?$/;

function looksLikeCanonicalPeriodKey(value: unknown): boolean {
  return typeof value === "string" && CANONICAL_PERIOD_KEY_RE.test(value.trim());
}

/** Date → canonical period key for the inferred display grain (never a human label).
 * monthOrQuarter resolves to a quarter key when every date is a quarter-start, so
 * quarterly data is never fabricated into months. */
function canonicalPeriodKeyFromDate(
  d: Date,
  grain: ReturnType<typeof inferTemporalGrainFromDates>,
  quarterAligned: boolean
): string {
  const period =
    grain === "year"
      ? "year"
      : grain === "monthOrQuarter"
        ? quarterAligned
          ? "quarter"
          : "month"
        : "day";
  return normalizeDateToPeriod(d, period)?.normalizedKey ?? String(d.getFullYear());
}

/**
 * Normalize a temporal X column to CANONICAL period keys (e.g. "2023-Q1", "2023-01",
 * "2023") so the client can sort chronologically and format for display. We never bake
 * a human label (e.g. "Jan-23") into the data: that destroys the sortable key and, for
 * quarterly data, fabricates a non-existent month grain. Temporal facet columns already
 * carry canonical keys, so they pass through untouched.
 */
function applyTemporalXAxisLabels(
  rows: Record<string, any>[],
  xCol: string,
  profileSaysDate: boolean
): Record<string, any>[] {
  if (rows.length === 0) return rows;
  if (isTemporalFacetColumnKey(xCol)) return rows;
  if (!chartXLooksTemporal(xCol, rows, profileSaysDate)) return rows;
  const dates: Date[] = [];
  for (const row of rows) {
    const p = coerceChartDate(row[xCol]);
    if (p) dates.push(p);
  }
  if (dates.length === 0) return rows;
  const grain = inferTemporalGrainFromDates(dates);
  const quarterAligned =
    grain === "monthOrQuarter" &&
    dates.every((d) => d.getMonth() % 3 === 0 && d.getDate() === 1);
  return rows.map((row) => {
    const raw = row[xCol];
    if (looksLikeCanonicalPeriodKey(raw)) return row;
    const p = coerceChartDate(raw);
    if (!p) return row;
    return { ...row, [xCol]: canonicalPeriodKeyFromDate(p, grain, quarterAligned) };
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

function datePeriodHintFromOptions(options?: ProcessChartDataOptions): DatePeriod | null {
  if (options?.grain) return options.grain; // explicit grain wins over question inference
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
  
  logger.log(`🔍 Processing chart: "${chartSpec.title}"`);
  logger.log(`   Type: ${type}, X: "${x}", Y: "${y}", Aggregate: ${aggregate}`);
  
  // Check if data is empty
  if (!data || data.length === 0) {
    logger.warn(`❌ No data provided for chart: ${chartSpec.title}`);
    return [];
  }
  
  logger.log(`   Data rows available: ${data.length}`);

  const availForEarly = Object.keys(data[0] || {});
  const xIsDateEarly = xColumnIsDeclaredDate(x, availForEarly, declaredDateColumns);

  // For large datasets without aggregation, use streaming for line/area charts
  if (
    data.length > 10000 &&
    (type === "line" || type === "area") &&
    aggregate === "none" &&
    !seriesColSpec
  ) {
    logger.log(`📊 Large dataset detected (${data.length} rows), processing in batches`);
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
    logger.warn(`❌ No rows in data for chart: ${chartSpec.title}`);
    return [];
  }
  
  const availableColumns = Object.keys(firstRow);
  logger.log(`   Available columns: [${availableColumns.join(', ')}]`);
  
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
    logger.warn(`❌ Column "${x}" not found in data for chart: ${chartSpec.title}`);
    logger.log(`   Available columns: [${availableColumns.join(', ')}]`);
    return [];
  }
  
  if (!matchedY) {
    logger.warn(`❌ Column "${y}" not found in data for chart: ${chartSpec.title}`);
    logger.log(`   Available columns: [${availableColumns.join(', ')}]`);
    return [];
  }

  if (type === "heatmap") {
    if (!zColSpec) {
      logger.warn(`❌ Heatmap requires "z" value column for chart: ${chartSpec.title}`);
      return [];
    }
    if (!matchedZ) {
      matchedZ = findMatchingColumn(zColSpec, availableColumns);
    }
    if (!matchedZ) {
      logger.warn(`❌ Column "${zColSpec}" (z) not found for heatmap: ${chartSpec.title}`);
      return [];
    }
  }
  
  // Optional secondary series existence check (for dual-axis line charts)
  if (y2 && !matchedY2) {
    logger.warn(`❌ Column "${y2}" not found in data for secondary series of chart: ${chartSpec.title}`);
    logger.log(`   Available columns: [${availableColumns.join(', ')}]`);
    logger.log(`   Attempting fuzzy matching for y2 column...`);
    // Try more aggressive fuzzy matching
    const y2Lower = y2.toLowerCase().trim();
    const fuzzyMatch = availableColumns.find(col => {
      const colLower = col.toLowerCase().trim();
      return colLower.includes(y2Lower) || y2Lower.includes(colLower) || 
             colLower.replace(/\s+/g, '').includes(y2Lower.replace(/\s+/g, '')) ||
             y2Lower.replace(/\s+/g, '').includes(colLower.replace(/\s+/g, ''));
    });
    if (fuzzyMatch) {
      logger.log(`   ✅ Found fuzzy match for y2: "${y2}" -> "${fuzzyMatch}"`);
      matchedY2 = fuzzyMatch;
    } else {
      logger.error(`   ❌ No match found for y2 column "${y2}". Chart will only show primary Y series.`);
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
    logger.warn(`   ⚠️ Removing y2 from chart spec because column "${y2}" was not found`);
    delete (chartSpec as any).y2;
    delete (chartSpec as any).y2Label;
  }

  const matchedY2Series: string[] = [];
  for (const name of y2SeriesSpec) {
    const m = findMatchingColumn(name, availableColumns);
    if (m) matchedY2Series.push(m);
    else
      logger.warn(
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
    
    logger.log(`   X column "${xCol}" (matched from "${x}"): ${xValues.length} valid values (sample: ${xValues.slice(0, 3).join(', ')})`);
    logger.log(`   Y column "${yCol}" (matched from "${y}"): ${yValues.length} valid values (sample: ${yValues.slice(0, 3).join(', ')})`);
    if (y2Col) {
      logger.log(`   Y2 column "${y2Col}" (matched from "${y2}"): ${y2Values.length} valid values (sample: ${y2Values.slice(0, 3).join(', ')})`);
    } else if (y2) {
      logger.warn(`   ⚠️ Y2 column "${y2}" was requested but not found. Chart will only show primary Y series.`);
    }
    
    if (xValues.length === 0) {
      logger.warn(`❌ No valid X values in column "${xCol}" for chart: ${chartSpec.title}`);
      return [];
    }
    
    if (type !== "heatmap" && yValues.length === 0) {
      logger.warn(`❌ No valid Y values in column "${yCol}" for chart: ${chartSpec.title}`);
      return [];
    }
    if (type === "heatmap" && zCol) {
      const zVals = data
        .map((row) => row[zCol])
        .filter((v) => v !== null && v !== undefined && v !== "");
      if (zVals.length === 0) {
        logger.warn(`❌ No valid Z values in column "${zCol}" for heatmap: ${chartSpec.title}`);
        return [];
      }
    }
  } else {
    // For bar charts with aggregation, just check that columns exist
    const hasXColumn = data.length > 0 && Object.prototype.hasOwnProperty.call(data[0], xCol);
    const hasYColumn = data.length > 0 && Object.prototype.hasOwnProperty.call(data[0], yCol);
    
    if (!hasXColumn) {
      logger.warn(`❌ Column "${xCol}" not found in data for chart: ${chartSpec.title}`);
      return [];
    }
    
    if (!hasYColumn) {
      logger.warn(`❌ Column "${yCol}" not found in data for chart: ${chartSpec.title}`);
      return [];
    }
    
    logger.log(`   Bar chart with aggregation - will validate after aggregation`);
  }

  if (type === 'scatter') {
    // For scatter plots, filter numeric values and sample if needed
    const scatterData = data
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

    logger.log(`   Scatter plot: ${scatterData.length} valid numeric points`);

    // Apply optimization to ensure max points limit
    const optimized = optimizeChartData(
      scatterData,
      chartSpec,
      declaredDateColumns,
      periodHint
    );
    if (optimized.length < scatterData.length) {
      logger.log(`   ✅ Optimized scatter plot from ${scatterData.length} to ${optimized.length} points`);
    }
    return optimized;
  }

  if (type === "heatmap" && zCol) {
    logger.log(`   Processing heatmap: rows="${xCol}", cols="${yCol}", value="${zCol}"`);
    const cells = processHeatmapLongData(data, xCol, yCol, zCol);
    logger.log(`   Heatmap cells: ${cells.length}`);
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
      logger.log(`   Pie chart: Data is already aggregated (${data.length} unique groups)`);
      
      if (isDateCol && detectedPeriod) {
        // Normalize date values even in already-aggregated data
        logger.log(`   Normalizing date values with period: ${detectedPeriod}`);
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
        
        logger.log(`   After normalization: ${allData.length} unique periods`);
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
      logger.log(`   Processing pie chart with aggregation: ${effectiveAggregate}`);
      const aggregated = aggregateData(data, xCol, yCol, effectiveAggregate, detectedPeriod, isDateCol);
      logger.log(`   Aggregated data points: ${aggregated.length}`);
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
                                   (data.length > 0 && Object.prototype.hasOwnProperty.call(data[0], 'variable') && Object.prototype.hasOwnProperty.call(data[0], 'correlation'));
    
    if (isCorrelationBarChart) {
      // Correlation bar chart - data is already processed, just return as-is
      // The sorting is already done in correlationAnalyzer.ts based on the requested order
      logger.log(`   Processing correlation bar chart (data already processed and sorted)`);
      const result = data
        .map(row => ({
          variable: row.variable || row[xCol],
          correlation: toNumber(row.correlation || row[yCol]),
        }))
        .filter(row => !isNaN(row.correlation));
      
      logger.log(`   Correlation bar chart result: ${result.length} bars`);
      return result;
    }

    const matchedSeriesCol = seriesColSpec
      ? findMatchingColumn(seriesColSpec, availableColumns)
      : null;
    if (seriesColSpec && matchedSeriesCol && matchedSeriesCol !== xCol) {
      const eff =
        aggregate === "none" || !aggregate ? "sum" : (aggregate as "sum" | "mean" | "count");
      logger.log(
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
      logger.log(`   Multi-series bar result: ${result.length} groups`);
      return result;
    }
    
    // Regular bar chart - aggregate and sort appropriately
    logger.log(`   Processing bar chart with aggregation: ${aggregate || 'sum'}`);
    const isDateCol = xIsDateCol;
    let detectedPeriod: DatePeriod | null = null;
    if (isDateCol && data.some((r) => r[xCol] instanceof Date && !isNaN(r[xCol].getTime()))) {
      detectedPeriod = 'month';
    }
    const effectiveAggregate = aggregate === 'none' ? 'sum' : aggregate || 'sum';
    logger.log(`   Processing bar chart with aggregation: ${effectiveAggregate}`);
    const aggregated = aggregateData(data, xCol, yCol, effectiveAggregate, detectedPeriod, isDateCol);
    logger.log(`   Aggregated data points: ${aggregated.length}`);
    
    // Validate aggregated results - ensure we have data after aggregation
    if (aggregated.length === 0) {
      logger.warn(`❌ No valid aggregated data points for bar chart. Check that "${xCol}" and "${yCol}" columns exist and "${yCol}" contains numeric values.`);
      return [];
    }
    
    let result: Record<string, any>[];
    if (xIsDateCol) {
      logger.log(`   X-axis is a profile date column; sorting chronologically (including string dates)`);
      result = aggregated.sort((a, b) => compareValues(a[xCol], b[xCol], true));
    } else {
      // MW3 · sortDirection "asc" surfaces the WORST performers first (bottom-N
      // for management-by-exception); "desc" (default) is best-first.
      const dir = chartSpec.sortDirection === "asc" ? 1 : -1;
      result = aggregated.sort((a, b) => (toNumber(a[yCol]) - toNumber(b[yCol])) * dir);
      // MW3 · optional cap (e.g. a "Worst 10" view). Omitted = ALL categories —
      // the primary breakdowns must never silently truncate a manager's data.
      const maxRows = chartSpec.maxRows;
      if (typeof maxRows === "number" && maxRows > 0 && result.length > maxRows) {
        result = result.slice(0, maxRows);
      }
    }

    // Convert Date objects to strings for schema validation
    result = result.map((row) => {
      const sanitizedRow: Record<string, any> = {};
      for (const [key, value] of Object.entries(row)) {
        sanitizedRow[key] = convertValueForSchema(value);
      }
      return sanitizedRow;
    });

    logger.log(`   Bar chart result: ${result.length} bars`);
    return xIsDateCol ? applyTemporalXAxisLabels(result, xCol, xIsDateCol) : result;
  }

  if (type === 'line' || type === 'area') {
    logger.log(`   Processing ${type} chart`);

    const matchedSeriesColForLine = seriesColSpec
      ? findMatchingColumn(seriesColSpec, availableColumns)
      : null;
    if (seriesColSpec && matchedSeriesColForLine && matchedSeriesColForLine !== xCol) {
      const eff =
        aggregate === "none" || !aggregate ? "sum" : (aggregate as "sum" | "mean" | "count");
      chartSpec.seriesColumn = matchedSeriesColForLine;
      logger.log(
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
      logger.log(`   Multi-series ${type} result: ${optimized.length} points`);
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
      logger.warn(
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
        logger.log(
          `   ✅ Optimized from ${repaired.length} to ${optimized.length} points after repair aggregation`
        );
      }
      logger.log(
        `   ${type} chart result (repaired): ${optimized.length} points (sorted chronologically)`
      );
      return applyTemporalXAxisLabels(optimized, xCol, xIsDateCol);
    }

    // Sort by x and optionally aggregate
    if (aggregate && aggregate !== 'none') {
      logger.log(`   Using aggregation: ${aggregate}`);
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
      logger.log(`   Aggregated data points: ${aggregated.length}`);
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
        logger.log(
          `   ✅ Optimized from ${result.length} to ${optimized.length} points after aggregation`
        );
      }

      logger.log(
        `   ${type} chart result: ${optimized.length} points (sorted chronologically)`
      );
      return applyTemporalXAxisLabels(optimized, xCol, xIsDateCol);
    }

    const result = data
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
      logger.log(`   Y2 column "${y2Col}": ${y2ValidCount}/${y2TotalCount} rows have valid numeric values`);
      if (y2ValidCount === 0) {
        logger.warn(`   ⚠️ No valid Y2 values found! Chart will only show primary Y series.`);
        // Remove y2 from chart spec if no valid data
        delete (chartSpec as any).y2;
        delete (chartSpec as any).y2Label;
      } else if (y2MissingCount > 0) {
        logger.log(`   ℹ️ Y2 has ${y2MissingCount} rows with missing/NaN values (field omitted for those rows)`);
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
      logger.log(`   ✅ Optimized from ${result.length} to ${optimized.length} points`);
    }
    
    logger.log(`   ${type} chart result: ${optimized.length} points (sorted chronologically)`);
    return applyTemporalXAxisLabels(optimized, xCol, xIsDateCol);
  }

  logger.warn(`❌ Unknown chart type: ${type} for chart: ${chartSpec.title}`);
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
  logger.log(`     Aggregating by "${groupBy}" with "${aggregateType}" of "${valueColumn}"${datePeriod ? ` (period: ${datePeriod})` : ''}`);
  
  const grouped = new Map<string, { values: number[] }>();
  let validValues = 0;
  let invalidValues = 0;

  // Temporal facet columns (e.g. "Quarter · Period") already hold canonical period
  // keys ("2023-Q1") — never re-bucket them to a different grain.
  const bucketByDate =
    isDateColumn && !!datePeriod && !isTemporalFacetColumnKey(groupBy);

  for (const row of data) {
    let key: string;

    if (bucketByDate) {
      const d = coerceChartDate(row[groupBy]);
      const normalized = d ? normalizeDateToPeriod(d, datePeriod!) : null;
      key = normalized ? normalized.normalizedKey : String(row[groupBy]);
    } else {
      key = String(row[groupBy]);
    }

    const value = toNumber(row[valueColumn]);

    if (!isNaN(value)) {
      validValues++;
      if (!grouped.has(key)) {
        grouped.set(key, { values: [] });
      }
      grouped.get(key)!.values.push(value);
    } else {
      invalidValues++;
    }
  }

  logger.log(`     Valid values: ${validValues}, Invalid values: ${invalidValues}`);
  logger.log(`     Unique groups: ${grouped.size}`);

  const result: Record<string, any>[] = [];

  for (const [key, { values }] of Array.from(grouped.entries())) {
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
      [groupBy]: key,  // canonical period key — client formats for display
      [valueColumn]: aggregatedValue,
    });
  }

  logger.log(`     Aggregation result: ${result.length} groups`);
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
  type GroupState = { cols: Map<string, number[]> };
  const grouped = new Map<string, GroupState>();

  // Facet columns already carry canonical period keys — never re-bucket them.
  const bucketByDate =
    isDateColumn && !!datePeriod && !isTemporalFacetColumnKey(groupBy);

  for (const row of data) {
    let key: string;

    if (bucketByDate) {
      const d = coerceChartDate(row[groupBy]);
      const normalized = d ? normalizeDateToPeriod(d, datePeriod!) : null;
      key = normalized ? normalized.normalizedKey : String(row[groupBy]);
    } else {
      key = String(row[groupBy]);
    }

    if (!grouped.has(key)) {
      grouped.set(key, { cols: new Map() });
    }
    const g = grouped.get(key)!;

    for (const col of valueColumns) {
      const value = toNumber(row[col]);
      if (isNaN(value)) continue;
      if (!g.cols.has(col)) g.cols.set(col, []);
      g.cols.get(col)!.push(value);
    }
  }

  const result: Record<string, any>[] = [];

  for (const [key, { cols }] of grouped.entries()) {
    const out: Record<string, any> = { [groupBy]: key };
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
