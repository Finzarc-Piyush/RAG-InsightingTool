/**
 * W1 · Single source of truth for pivot-driven chart recommendation.
 *
 * Lives under `server/shared/` (mirrored to the client via the same
 * cross-package re-export pattern as `schema.ts`) so the agent's
 * `build_chart` server-side path and the pivot-panel client-side path
 * call the SAME function. Editing this file propagates to chat answer
 * charts, dashboard tiles, and the pivot section uniformly.
 *
 * Pure: no client-only imports. The only previous external dependency
 * (`isTemporalFacetFieldId` from `client/src/lib/temporalFacetDisplay`)
 * is inlined below as a single regex predicate.
 */

/**
 * Structural pivot-config shape consumed by the recommender. Only the
 * three fields the recommender actually reads. The client's
 * `PivotUiConfig` is structurally compatible (it has these fields plus
 * more), so existing client callers continue to work without changes.
 */
export type PivotConfigForRecommendation = {
  rows: string[];
  columns: string[];
  values: ReadonlyArray<{ field: string }>;
};

export type PivotChartKind =
  | 'line'
  | 'bar'
  | 'scatter'
  | 'pie'
  | 'area'
  | 'heatmap'
  | 'donut'
  | 'radar'
  | 'bubble'
  | 'waterfall';

/**
 * v1 marks supported by the legacy ChartRenderer + server `chartTypeSchema`.
 * v2 marks (donut/radar/bubble/waterfall) are rendered client-side via
 * ChartShim → ChartSpecV2 and never reach the v1 chart-preview endpoint.
 */
export const V1_PIVOT_CHART_KINDS = ['line', 'bar', 'scatter', 'pie', 'area', 'heatmap'] as const;
export type V1PivotChartKind = (typeof V1_PIVOT_CHART_KINDS)[number];
export function isV1PivotChartKind(kind: PivotChartKind): kind is V1PivotChartKind {
  return (V1_PIVOT_CHART_KINDS as readonly string[]).includes(kind);
}

export interface PivotChartRecommendationInput {
  pivotConfig: PivotConfigForRecommendation;
  numericColumns: string[];
  dateColumns: string[];
  rowCount?: number;
  colKeyCount?: number;
  /**
   * When provided, the recommender will only emit `x`/`y` field names that
   * appear in `actualResultColumns`. Use this when the rendered data is the
   * agent's aggregated result and may use aliased column names (e.g. the
   * trace plan used "Shipping Time (Days)" but the result column is the alias
   * "Average Shipping Time"). Without this guard the chart can pick a base-
   * table column that doesn't exist in the rendered rows and silently fail.
   */
  actualResultColumns?: string[];
  /**
   * PV7 · Optional sample values keyed by column name (incl. row dims +
   * actualResultColumns). The recommender inspects these as a third-line
   * temporal-detection signal when the column name's regex check and
   * dateColumns membership both fail — catches exotic period strings like
   * "Q1 23", "FY24-25", ISO dates, "Tháng 5", "Latest 12 Mths".
   */
  sampleValuesByField?: Record<string, ReadonlyArray<unknown>>;
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
const RADAR_MAX_SPOKES = 8;
const BUBBLE_MIN_MEASURES = 3;
const PIE_DONUT_THRESHOLD = 4;

const AGG_SUFFIX_CAPTURE = /^(.*)_(sum|avg|mean|min|max|count)$/i;
const WATERFALL_MEASURE_RE = /(_delta|_change|_diff|_var(iance)?|_contribution)$/i;
const WATERFALL_ROW_RE = /^(driver|component|bridge|step|stage|movement)/i;

/** Inlined from `client/src/lib/temporalFacetDisplay.ts` to keep this file leaf-pure. */
const DISPLAY_FACET_HEADER_RE = /^(Day|Week|Month|Quarter|Half-year|Year) · /;
function isTemporalFacetFieldId(name: string): boolean {
  if (name.startsWith('__tf_')) return true;
  return DISPLAY_FACET_HEADER_RE.test(name);
}

/**
 * Align pivot value field with base table measure names (e.g. `Sales_sum` → `Sales`) for chart Y
 * and numeric checks; mirrors server {@link normalizePivotValueFieldForBaseTable} suffix rules.
 */
export function normalizePivotMeasureFieldForChart(
  field: string | null,
  numericColumns: string[]
): string | null {
  if (!field) return null;
  const numericSet = new Set(numericColumns);
  if (numericSet.has(field)) return field;
  const m = field.match(AGG_SUFFIX_CAPTURE);
  if (m?.[1] && numericSet.has(m[1])) return m[1];
  return field;
}

/**
 * Column pivot field wins over a second row field. For bar/line/area only, when there is no
 * column field but two+ row fields, use the inner row (rows[1]) as series so chart preview
 * matches nested pivot tables (server: pivotModelRowsForChartSpec long-format branch).
 */
export function resolveSeriesColumnForPivotChart(
  pivotConfig: Pick<PivotConfigForRecommendation, 'rows' | 'columns'>,
  chartKind: PivotChartKind
): string | null {
  const col = pivotConfig.columns[0] ?? null;
  if (col) return col;
  if (chartKind === 'bar' || chartKind === 'line' || chartKind === 'area') {
    if (pivotConfig.rows.length >= 2) return pivotConfig.rows[1] ?? null;
  }
  // PV1 · v2 marks: don't auto-promote inner row to series (radar/bubble/etc.
  // encode multi-measure shapes directly from `values`, not from a series dim).
  return null;
}

/** PV1 · True iff every pivot value field resolves to a numeric base column. */
function pivotValuesAllNumeric(
  values: ReadonlyArray<{ field: string }>,
  numericSet: Set<string>
): boolean {
  if (values.length === 0) return false;
  for (const v of values) {
    const direct = numericSet.has(v.field);
    if (direct) continue;
    const m = v.field.match(AGG_SUFFIX_CAPTURE);
    const stem = m?.[1];
    if (stem && numericSet.has(stem)) continue;
    return false;
  }
  return true;
}

/** PV1 · Cumulative-bridge shape — measure is a delta or row dim is driver-like. */
function isWaterfallShape(measureField: string, rowField: string): boolean {
  return WATERFALL_MEASURE_RE.test(measureField) || WATERFALL_ROW_RE.test(rowField);
}

/** Stacked default whenever a second dimension becomes series (column field or inner row); matches server chart compiler. */
function barLayoutForPivotSeries(
  pivotConfig: Pick<PivotConfigForRecommendation, 'rows' | 'columns'>,
  chartKind: 'bar' | 'line' | 'area'
): 'stacked' | 'grouped' {
  const sc = resolveSeriesColumnForPivotChart(pivotConfig, chartKind);
  return sc ? 'stacked' : 'grouped';
}

function isInnerRowSeries(
  pivotConfig: Pick<PivotConfigForRecommendation, 'rows' | 'columns'>,
  seriesColumn: string | null
): boolean {
  const r1 = pivotConfig.rows[1];
  return Boolean(r1 && seriesColumn === r1 && !pivotConfig.columns[0]);
}

/**
 * PV7 · Broad lexicon — matches the column NAME side of temporal detection.
 * Covers English + common multilingual stems (Vietnamese, Spanish, Portuguese,
 * Indonesian) so Marico-VN / FMCG datasets don't fall back to bar just because
 * the column happens to be named "Tháng" or "Periode".
 */
const TEMPORAL_NAME_RE =
  /\b(date|datetime|timestamp|day|daily|week|weekly|month|monthly|quarter|qtr|year|yearly|annual|annum|fiscal|fy|cy|calendar|time|period|periodic|reporting|posting|ymd|ym|tháng|quý|ngày|năm|mes|trimestre|año|periodo|periode|bulan|tahun|kuartal)\b/i;

/**
 * PV7 · Compact catalogue of date-shaped value patterns. The recommender uses
 * these as the third tier of temporal detection (after column name + the
 * caller's `dateColumns` hint), inspected from sample values supplied via
 * `input.sampleValuesByField`. Permissive on purpose — false positives are
 * cheaper than a wrong default chart type for time-series data.
 */
const DATE_VALUE_PATTERNS: ReadonlyArray<RegExp> = [
  /^\d{4}-\d{1,2}(-\d{1,2})?(T|\s|$)/, // ISO YYYY-MM[-DD]
  /^\d{4}\/\d{1,2}(\/\d{1,2})?$/, // YYYY/M[/D]
  /^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/, // D/M/YY[YY] or M/D/YY[YY]
  /^[A-Z][a-zà-ỹ]{2,}\s\d{2,4}$/i, // "Apr 24", "Tháng 5 2024", etc.
  /^[A-Z][a-z]{2,}-\d{2,4}$/i, // "Apr-24", "Mar-2024"
  /^Q[1-4][\s\-]?\d{2,4}$/i, // Q1 23
  /^H[12][\s\-]?\d{2,4}$/i, // H1 23
  /^(FY|CY)[\s\-]?\d{2,4}([\s\-]\d{2,4})?$/i, // FY24-25 / CY2024
  /^\d{4}$/, // Plain year
  /^\d{4}\s?(M|Q|W|H)\d{1,2}$/i, // 2023M01, 2023Q1, 2023W12
  /^Latest\s+\d+\s+(Mths|Months|Yrs|Years|Wks|Weeks)/i, // "Latest 12 Mths"
  /^YTD/i, // YTD TY / YTD YA / YTD-2YA
  /^L\d+M(-?(YA|2YA))?$/i, // L12M, L12M-YA, L12M-2YA
  /^MAT[\s\-]?TY/i, // MAT-TY (moving annual total)
  /^w\/e\s\d{1,2}\/\d{1,2}\/\d{2,4}$/i, // w/e DD/MM/YY (Marico-VN week-ending)
  /^\d{1,2}-[A-Z][a-z]{2}-\d{2,4}$/i, // 23-Mar-24
];

function looksLikeDateString(s: string): boolean {
  const trimmed = s.trim();
  if (!trimmed || trimmed.length > 80) return false;
  for (const re of DATE_VALUE_PATTERNS) {
    if (re.test(trimmed)) return true;
  }
  // Native Date parser as a last resort (catches localized RFC-2822-ish strings).
  // Reject pure numbers (e.g. "12345") which Date.parse returns 12345 for; the
  // year-only branch above already covers 4-digit plausible years.
  if (/^\d+(\.\d+)?$/.test(trimmed)) return false;
  const ms = Date.parse(trimmed);
  return !Number.isNaN(ms);
}

function inferDateLikenessFromValues(
  field: string,
  sampleValuesByField: Record<string, ReadonlyArray<unknown>> | undefined
): boolean {
  if (!sampleValuesByField) return false;
  const samples = sampleValuesByField[field];
  if (!samples || samples.length === 0) return false;
  let total = 0;
  let matches = 0;
  for (let i = 0; i < Math.min(samples.length, 30); i++) {
    const v = samples[i];
    if (v == null || typeof v === 'boolean') continue;
    if (v instanceof Date && !Number.isNaN(v.getTime())) {
      total++;
      matches++;
      continue;
    }
    total++;
    if (looksLikeDateString(String(v))) matches++;
  }
  return total >= 3 && matches / total >= 0.6;
}

function isDateLike(
  field: string | null,
  dateColumns: Set<string>,
  sampleValuesByField?: Record<string, ReadonlyArray<unknown>>
): boolean {
  if (!field) return false;
  if (isTemporalFacetFieldId(field)) return true;
  if (dateColumns.has(field)) return true;
  if (TEMPORAL_NAME_RE.test(field)) return true;
  if (inferDateLikenessFromValues(field, sampleValuesByField)) return true;
  return false;
}

/**
 * Drop or remap a recommended field name when the rendered data uses an alias
 * that doesn't match the field id. Without this, charts silently bind to a
 * non-existent column (e.g. "Shipping Time (Days)") and render empty.
 *
 * Returns null when the field cannot be reconciled with `actualResultColumns`,
 * so the caller emits a "Choose X / Y" empty state instead of a broken chart.
 */
function reconcileFieldWithResultColumns(
  field: string | null,
  actualResultColumns: string[] | undefined,
  isMeasure: boolean,
  numericSet: Set<string>,
  rowDimensions: string[]
): string | null {
  if (!field) return null;
  if (!actualResultColumns?.length) return field;
  if (actualResultColumns.includes(field)) return field;

  // Try the measure-suffix shape (e.g. "Sales_sum" matches "Sales").
  const m = field.match(AGG_SUFFIX_CAPTURE);
  if (m?.[1] && actualResultColumns.includes(m[1])) return m[1];
  for (const c of actualResultColumns) {
    const cm = c.match(AGG_SUFFIX_CAPTURE);
    if (cm?.[1] === field) return c;
  }

  if (isMeasure) {
    // Schema-numeric column on the result rows.
    for (const c of actualResultColumns) {
      if (numericSet.has(c)) return c;
    }
    for (const c of actualResultColumns) {
      const cm = c.match(AGG_SUFFIX_CAPTURE);
      if (cm?.[1] && numericSet.has(cm[1])) return c;
    }
    // Last resort: in an aggregated result the non-dimension columns are the
    // measures. Pick the first column that isn't being used as a row dim.
    // Catches free-form aliases like "Average Shipping Time" that the schema
    // doesn't know about.
    const rowSet = new Set(rowDimensions);
    for (const c of actualResultColumns) {
      if (!rowSet.has(c)) return c;
    }
    return null;
  }

  // PV7 · Row-dim fallback. When the configured row field doesn't appear in
  // `actualResultColumns` (the agent often aliases dimensions, e.g. config
  // "Order Date" → result "Order Period"), fall back to the first column
  // that isn't a numeric measure or aggregation alias. Without this the
  // recommender returns null → bar default, even when the result has a
  // perfectly good dimension column to chart against.
  for (const c of actualResultColumns) {
    if (numericSet.has(c)) continue;
    const cm = c.match(AGG_SUFFIX_CAPTURE);
    if (cm?.[1] && numericSet.has(cm[1])) continue;
    return c;
  }
  return null;
}

export function recommendPivotChart({
  pivotConfig,
  numericColumns,
  dateColumns,
  rowCount = 0,
  colKeyCount = 0,
  actualResultColumns,
  sampleValuesByField,
}: PivotChartRecommendationInput): PivotChartRecommendation {
  const dateSet = new Set(dateColumns);
  const numericSet = new Set(numericColumns);
  const rawFirstRow = pivotConfig.rows[0] ?? null;
  const firstCol = pivotConfig.columns[0] ?? null;
  const rawFirstValue = pivotConfig.values[0]?.field ?? null;
  const firstRow = reconcileFieldWithResultColumns(
    rawFirstRow,
    actualResultColumns,
    false,
    numericSet,
    pivotConfig.rows
  );
  const firstValueReconciled = reconcileFieldWithResultColumns(
    rawFirstValue,
    actualResultColumns,
    true,
    numericSet,
    pivotConfig.rows
  );
  // When `actualResultColumns` is provided and the reconciled field is one of
  // those columns, keep it as-is — the rendered data uses that alias. Without
  // this guard, `normalizePivotMeasureFieldForChart` would rewrite "Sales_sum"
  // back to base "Sales", which doesn't exist on the rendered rows.
  const reconciledIsResultColumn =
    !!firstValueReconciled &&
    !!actualResultColumns?.length &&
    actualResultColumns.includes(firstValueReconciled);
  const firstValue = reconciledIsResultColumn
    ? firstValueReconciled
    : normalizePivotMeasureFieldForChart(firstValueReconciled, numericColumns) ??
      firstValueReconciled;
  const yNumeric = firstValue ? numericSet.has(firstValue) : false;
  const xDateLike = isDateLike(firstRow, dateSet, sampleValuesByField);
  const valueFields = pivotConfig.values.map((v) => v.field);
  const allValuesNumeric = pivotValuesAllNumeric(pivotConfig.values, numericSet);

  // PV1 · Radar: ≥3 numeric measures profiled across one entity dimension.
  if (
    pivotConfig.rows.length === 1 &&
    pivotConfig.values.length >= BUBBLE_MIN_MEASURES &&
    allValuesNumeric &&
    firstRow &&
    rowCount > 0 &&
    rowCount <= RADAR_MAX_SPOKES
  ) {
    return {
      chartType: 'radar',
      x: firstRow,
      y: firstValue,
      z: null,
      seriesColumn: null,
      barLayout: 'stacked',
      reason: 'Multi-measure profile across one entity dimension; radar shows the spread.',
    };
  }

  // PV1 · Bubble: ≥3 numeric measures with at most one row dim. The third
  // measure becomes the size encoding; the optional row dim becomes color.
  if (
    pivotConfig.rows.length <= 1 &&
    pivotConfig.values.length >= BUBBLE_MIN_MEASURES &&
    allValuesNumeric
  ) {
    return {
      chartType: 'bubble',
      x: valueFields[0] ?? firstValue,
      y: valueFields[1] ?? firstValue,
      z: valueFields[2] ?? null,
      seriesColumn: pivotConfig.rows[0] ?? null,
      barLayout: 'stacked',
      reason: 'Three+ numeric measures; bubble plots X vs Y sized by a third measure.',
    };
  }

  // PV1 · Scatter: two numeric measures, no row dim — relationship view.
  if (
    pivotConfig.rows.length === 0 &&
    pivotConfig.values.length >= 2 &&
    allValuesNumeric
  ) {
    return {
      chartType: 'scatter',
      x: valueFields[0] ?? firstValue,
      y: valueFields[1] ?? firstValue,
      z: null,
      seriesColumn: null,
      barLayout: 'stacked',
      reason: 'Two numeric measures with no breakdown; scatter shows the relationship.',
    };
  }

  // PV1 · Waterfall: cumulative-bridge measure (delta-suffix) or driver-like row.
  if (
    firstRow &&
    firstValue &&
    yNumeric &&
    isWaterfallShape(firstValue, firstRow)
  ) {
    return {
      chartType: 'waterfall',
      x: firstRow,
      y: firstValue,
      z: null,
      seriesColumn: null,
      barLayout: 'stacked',
      reason: 'Cumulative-bridge shape detected; waterfall makes the contributions readable.',
    };
  }

  if (xDateLike && yNumeric && rowCount >= 1) {
    const seriesColumn = resolveSeriesColumnForPivotChart(pivotConfig, 'line');
    const innerRow = isInnerRowSeries(pivotConfig, seriesColumn);
    return {
      chartType: 'line',
      x: firstRow,
      y: firstValue,
      z: null,
      seriesColumn,
      barLayout: barLayoutForPivotSeries(pivotConfig, 'line'),
      reason: innerRow
        ? 'Temporal dimension on X with inner row field as series.'
        : 'Temporal dimension detected, line chart selected by default.',
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
    // PV1 · pie for very small splits, donut for mid-cardinality (4..PIE_MAX).
    const useDonut = rowCount >= PIE_DONUT_THRESHOLD;
    return {
      chartType: useDonut ? 'donut' : 'pie',
      x: firstRow,
      y: firstValue,
      z: null,
      seriesColumn: null,
      barLayout: 'stacked',
      reason: useDonut
        ? 'Mid-cardinality category split; donut keeps the center clear.'
        : 'Low-cardinality category split; pie is readable here.',
    };
  }

  const seriesColumn = resolveSeriesColumnForPivotChart(pivotConfig, 'bar');
  const innerRow = isInnerRowSeries(pivotConfig, seriesColumn);
  return {
    chartType: 'bar',
    x: firstRow,
    y: firstValue,
    z: null,
    seriesColumn,
    barLayout: barLayoutForPivotSeries(pivotConfig, 'bar'),
    reason: innerRow
      ? 'Bar chart: outer row on X, inner row as series, first measure on Y.'
      : 'Categorical comparison baseline; bar is the safest default.',
  };
}

function barLikeReason(
  kind: string,
  pivotConfig: Pick<PivotConfigForRecommendation, 'rows' | 'columns'>,
  chartKind: 'bar' | 'line' | 'area'
): string {
  const sc = resolveSeriesColumnForPivotChart(pivotConfig, chartKind);
  if (isInnerRowSeries(pivotConfig, sc)) {
    return `${kind} chart: outer row on X, inner row as series, first value measure on Y.`;
  }
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
  const {
    pivotConfig,
    numericColumns,
    dateColumns,
    rowCount = 0,
    colKeyCount = 0,
    actualResultColumns,
    sampleValuesByField,
  } = input;
  const dateSet = new Set(dateColumns);
  const numericSet = new Set(numericColumns);
  const rawFirstRow = pivotConfig.rows[0] ?? null;
  const firstCol = pivotConfig.columns[0] ?? null;
  const rawFirstValue = pivotConfig.values[0]?.field ?? null;
  const firstRow = reconcileFieldWithResultColumns(
    rawFirstRow,
    actualResultColumns,
    false,
    numericSet,
    pivotConfig.rows
  );
  const firstValueReconciled = reconcileFieldWithResultColumns(
    rawFirstValue,
    actualResultColumns,
    true,
    numericSet,
    pivotConfig.rows
  );
  // When `actualResultColumns` is provided and the reconciled field is one of
  // those columns, keep it as-is — the rendered data uses that alias. Without
  // this guard, `normalizePivotMeasureFieldForChart` would rewrite "Sales_sum"
  // back to base "Sales", which doesn't exist on the rendered rows.
  const reconciledIsResultColumn =
    !!firstValueReconciled &&
    !!actualResultColumns?.length &&
    actualResultColumns.includes(firstValueReconciled);
  const firstValue = reconciledIsResultColumn
    ? firstValueReconciled
    : normalizePivotMeasureFieldForChart(firstValueReconciled, numericColumns) ??
      firstValueReconciled;
  const yNumeric = firstValue ? numericSet.has(firstValue) : false;
  const xDateLike = isDateLike(firstRow, dateSet, sampleValuesByField);
  const meas = numericColumns.filter((c) => numericSet.has(c));
  const secondMeas = meas.find((m) => m !== firstValue) ?? meas[1] ?? firstValue;
  const valueFields = pivotConfig.values.map((v) => v.field);
  const allValuesNumeric = pivotValuesAllNumeric(pivotConfig.values, numericSet);

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

  if (forcedType === 'pie' || forcedType === 'donut') {
    const label = forcedType === 'donut' ? 'Donut' : 'Pie';
    if (firstRow && firstValue && yNumeric && rowCount > 0 && rowCount <= PIE_MAX_CATEGORIES) {
      return {
        chartType: forcedType,
        x: firstRow,
        y: firstValue,
        z: null,
        seriesColumn: null,
        barLayout: 'stacked',
        reason: `${label}: low-cardinality split on the row dimension.`,
      };
    }
    return {
      chartType: forcedType,
      x: firstRow,
      y: firstValue,
      z: null,
      seriesColumn: null,
      barLayout: 'stacked',
      reason: `${label} is clearest with few categories. (${auto.reason})`,
    };
  }

  // PV1 · Radar — ≥3 numeric measures across one entity dim, low cardinality.
  if (forcedType === 'radar') {
    const radarOk =
      pivotConfig.rows.length >= 1 &&
      pivotConfig.values.length >= BUBBLE_MIN_MEASURES &&
      allValuesNumeric &&
      Boolean(firstRow) &&
      rowCount > 0 &&
      rowCount <= RADAR_MAX_SPOKES;
    if (radarOk) {
      return {
        chartType: 'radar',
        x: firstRow,
        y: firstValue,
        z: null,
        seriesColumn: null,
        barLayout: 'stacked',
        reason: 'Radar: multi-measure profile across one entity dimension.',
      };
    }
    return {
      chartType: 'radar',
      x: firstRow ?? auto.x,
      y: firstValue ?? auto.y,
      z: null,
      seriesColumn: null,
      barLayout: 'stacked',
      reason: `Radar needs ≥3 numeric measures over one low-cardinality dimension. (${auto.reason})`,
    };
  }

  // PV1 · Bubble — three numeric measures (X, Y, size).
  if (forcedType === 'bubble') {
    const bubbleOk =
      pivotConfig.values.length >= BUBBLE_MIN_MEASURES && allValuesNumeric;
    if (bubbleOk) {
      return {
        chartType: 'bubble',
        x: valueFields[0] ?? firstValue,
        y: valueFields[1] ?? firstValue,
        z: valueFields[2] ?? null,
        seriesColumn: pivotConfig.rows[0] ?? null,
        barLayout: 'stacked',
        reason: 'Bubble: X vs Y sized by a third numeric measure.',
      };
    }
    // Fallback to whatever measures we have, plus a warning reason.
    return {
      chartType: 'bubble',
      x: meas[0] ?? firstValue,
      y: meas[1] ?? meas[0] ?? firstValue,
      z: meas[2] ?? null,
      seriesColumn: pivotConfig.rows[0] ?? null,
      barLayout: 'stacked',
      reason: `Bubble needs three numeric measures. (${auto.reason})`,
    };
  }

  // PV1 · Waterfall — driver/delta breakdown with a numeric measure.
  if (forcedType === 'waterfall') {
    if (firstRow && firstValue && yNumeric) {
      return {
        chartType: 'waterfall',
        x: firstRow,
        y: firstValue,
        z: null,
        seriesColumn: null,
        barLayout: 'stacked',
        reason: 'Waterfall: cumulative-bridge breakdown of a numeric measure.',
      };
    }
    return {
      chartType: 'waterfall',
      x: firstRow ?? auto.x,
      y: firstValue ?? auto.y,
      z: null,
      seriesColumn: null,
      barLayout: 'stacked',
      reason: `Waterfall needs a row dimension and a numeric measure. (${auto.reason})`,
    };
  }

  if (forcedType === 'line' || forcedType === 'area') {
    const lineAreaKind = forcedType === 'line' ? 'line' : 'area';
    const seriesLA = resolveSeriesColumnForPivotChart(pivotConfig, lineAreaKind);
    if (xDateLike && yNumeric && firstRow && firstValue && rowCount >= 2) {
      const innerRow = isInnerRowSeries(pivotConfig, seriesLA);
      return {
        chartType: forcedType,
        x: firstRow,
        y: firstValue,
        z: null,
        seriesColumn: seriesLA,
        barLayout: barLayoutForPivotSeries(pivotConfig, lineAreaKind),
        reason: innerRow
          ? `${forcedType === 'line' ? 'Line' : 'Area'}: time on X with inner row as series.`
          : `${forcedType === 'line' ? 'Line' : 'Area'}: time-like row dimension with a measure.`,
      };
    }
    if (firstRow && firstValue && yNumeric) {
      return {
        chartType: forcedType,
        x: firstRow,
        y: firstValue,
        z: null,
        seriesColumn: seriesLA,
        barLayout: barLayoutForPivotSeries(pivotConfig, lineAreaKind),
        reason: barLikeReason(
          forcedType === 'line' ? 'Line' : 'Area',
          pivotConfig,
          lineAreaKind
        ),
      };
    }
    return {
      chartType: forcedType,
      x: firstRow ?? auto.x,
      y: firstValue ?? auto.y,
      z: null,
      seriesColumn: resolveSeriesColumnForPivotChart(pivotConfig, lineAreaKind),
      barLayout: barLayoutForPivotSeries(pivotConfig, lineAreaKind),
      reason: `Add a row dimension and value measure. (${auto.reason})`,
    };
  }

  if (forcedType === 'bar') {
    const seriesBar = resolveSeriesColumnForPivotChart(pivotConfig, 'bar');
    if (firstRow && firstValue && yNumeric) {
      return {
        chartType: 'bar',
        x: firstRow,
        y: firstValue,
        z: null,
        seriesColumn: seriesBar,
        barLayout: barLayoutForPivotSeries(pivotConfig, 'bar'),
        reason: barLikeReason('Bar', pivotConfig, 'bar'),
      };
    }
    return {
      chartType: 'bar',
      x: firstRow ?? auto.x,
      y: firstValue ?? auto.y,
      z: null,
      seriesColumn: seriesBar ?? auto.seriesColumn,
      barLayout: barLayoutForPivotSeries(pivotConfig, 'bar'),
      reason: auto.reason,
    };
  }

  return auto;
}
