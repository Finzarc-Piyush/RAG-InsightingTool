import type { DataSummary } from "../shared/schema.js";
import { parseFlexibleDate } from "./dateUtils.js";
import { inferTemporalGrainFromDates } from "./temporalGrain.js";
import { roundTo } from "./numberCoercion.js";

/**
 * Rich, type-aware per-column profiling for the Data Summary modal.
 *
 * Unlike the legacy flat summary (one mean/median/std table applied to every
 * column regardless of type), this builds a discriminated-union profile per
 * column whose statistics are meaningful for that column's *authoritative*
 * type — the classification the agent itself uses
 * (`DataSummary.numericColumns` / `dateColumns`), not an independent
 * re-detection that could disagree.
 *
 * Pure & dependency-light so it can be unit-tested and run on-demand in the
 * data-summary endpoint without the Python service.
 */

export type ColumnKind = "numeric" | "date" | "categorical" | "boolean";

export interface BaseColumnProfile {
  name: string;
  kind: ColumnKind;
  /** Human label e.g. "Integer", "Decimal", "Date", "Text", "Yes/No". */
  datatypeLabel: string;
  totalValues: number;
  /** Blank / missing cells (null, undefined, empty/whitespace-only string). */
  nullCount: number;
  /** 0..100 */
  nullPct: number;
  /** 0..100 — share of non-blank cells. */
  completeness: number;
  /** Distinct non-blank values (numeric: distinct numbers; date: distinct days). */
  distinctCount: number;
}

export interface NumericColumnProfile extends BaseColumnProfile {
  kind: "numeric";
  /** Non-blank cells that could not be parsed as a number. */
  nonNumericCount: number;
  mean: number | null;
  median: number | null;
  std: number | null;
  variance: number | null;
  min: number | null;
  max: number | null;
  range: number | null;
  q1: number | null;
  q3: number | null;
  iqr: number | null;
  p5: number | null;
  p95: number | null;
  sum: number | null;
  zeroCount: number;
  negativeCount: number;
  outlierCount: number;
  /** Sample skewness; null when undefined (n<3 or zero variance). */
  skewness: number | null;
  /** Coefficient of variation (std/|mean|); null when mean≈0. */
  cv: number | null;
  integerLike: boolean;
  currencySymbol: string | null;
  histogram: Array<{ x0: number; x1: number; count: number }>;
}

export interface DateColumnProfile extends BaseColumnProfile {
  kind: "date";
  minIso: string | null;
  maxIso: string | null;
  spanDays: number | null;
  distinctDayCount: number;
  /** Non-blank cells that did not parse as a date. */
  unparseableCount: number;
  grain: "dayOrWeek" | "monthOrQuarter" | "year" | null;
  timeline: Array<{ label: string; count: number }>;
}

export interface CategoricalColumnProfile extends BaseColumnProfile {
  kind: "categorical" | "boolean";
  mode: string | number | null;
  topValues: Array<{ value: string | number; count: number; pct: number }>;
  otherCount: number;
  otherPct: number;
  /** distinct / non-blank. */
  cardinalityRatio: number;
  isHighCardinality: boolean;
  isLikelyId: boolean;
  isConstant: boolean;
  minLength: number | null;
  maxLength: number | null;
  avgLength: number | null;
  /** Boolean partition (only when kind === "boolean"). */
  positiveValues?: string[];
  negativeValues?: string[];
}

export type RichColumnProfile =
  | NumericColumnProfile
  | DateColumnProfile
  | CategoricalColumnProfile;

export interface RichDataSummary {
  dataset: {
    rowCount: number;
    columnCount: number;
    typeBreakdown: {
      numeric: number;
      date: number;
      categorical: number;
      boolean: number;
    };
    totalCells: number;
    totalNulls: number;
    /** 0..100 */
    overallCompleteness: number;
    /** null when skipped on very large datasets. */
    duplicateRowCount: number | null;
  };
  /** 0..100 — overall completeness, rounded. */
  qualityScore: number;
  columns: RichColumnProfile[];
}

/** Heavy per-column stats (sorts) are sampled above this row count. */
const STATS_SAMPLE_CAP = 200_000;
/** Above this row count we skip the O(n) duplicate-row scan. */
const DUPLICATE_SCAN_CAP = 250_000;
const MAX_TOP_VALUES = 12;
const MAX_HISTOGRAM_BINS = 24;
const MAX_TIMELINE_BUCKETS = 24;

function isBlank(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  return false;
}

/** Currency-symbol / thousands-separator-aware numeric coercion. */
function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const cleaned = v.replace(/[%,\s]/g, "").replace(/[^0-9eE.+-]/g, "");
  if (cleaned === "" || cleaned === "+" || cleaned === "-" || cleaned === ".") {
    return null;
  }
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Linear-interpolation percentile over an ascending-sorted array. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

/** Evenly-spaced sample to cap heavy work; returns input unchanged if small. */
function sampleArray<T>(arr: T[], cap: number): T[] {
  if (arr.length <= cap) return arr;
  const step = arr.length / cap;
  const out: T[] = [];
  for (let i = 0; i < arr.length && out.length < cap; i += step) {
    out.push(arr[Math.floor(i)]);
  }
  return out;
}

/**
 * Format a Date as a calendar day using *local* components. `parseFlexibleDate`
 * builds dates via `new Date(y, m, d)` (local midnight), so `toISOString()`
 * would shift the day in non-UTC environments — this keeps the calendar day
 * stable everywhere.
 */
function toLocalIsoDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const ID_NAME_RE = /(^|[_\s-])(id|uuid|guid|code|sku|key|ref|reference)s?($|[_\s-])/i;

function buildNumericProfile(
  name: string,
  values: unknown[],
  currencySymbol: string | null,
): NumericColumnProfile {
  const total = values.length;
  const nonBlank = values.filter((v) => !isBlank(v));
  const nullCount = total - nonBlank.length;

  const nums: number[] = [];
  let nonNumericCount = 0;
  for (const v of nonBlank) {
    const n = toNumber(v);
    if (n === null) nonNumericCount += 1;
    else nums.push(n);
  }

  const base: BaseColumnProfile = {
    name,
    kind: "numeric",
    datatypeLabel: "Decimal",
    totalValues: total,
    nullCount,
    nullPct: total > 0 ? roundTo((nullCount / total) * 100, 2) : 0,
    completeness: total > 0 ? roundTo((nonBlank.length / total) * 100, 2) : 100,
    distinctCount: new Set(nums).size,
  };

  if (nums.length === 0) {
    return {
      ...(base as NumericColumnProfile),
      nonNumericCount,
      mean: null, median: null, std: null, variance: null,
      min: null, max: null, range: null,
      q1: null, q3: null, iqr: null, p5: null, p95: null,
      sum: null, zeroCount: 0, negativeCount: 0, outlierCount: 0,
      skewness: null, cv: null, integerLike: false,
      currencySymbol, histogram: [],
    };
  }

  const integerLike = nums.every((n) => Number.isInteger(n));
  const sum = nums.reduce((a, b) => a + b, 0);
  const mean = sum / nums.length;
  let zeroCount = 0;
  let negativeCount = 0;
  for (const n of nums) {
    if (n === 0) zeroCount += 1;
    if (n < 0) negativeCount += 1;
  }

  // Heavy stats (sort, moments) can be sampled on very large columns.
  const statNums = sampleArray(nums, STATS_SAMPLE_CAP);
  const sorted = [...statNums].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const median = percentile(sorted, 0.5);
  const q1 = percentile(sorted, 0.25);
  const q3 = percentile(sorted, 0.75);
  const p5 = percentile(sorted, 0.05);
  const p95 = percentile(sorted, 0.95);
  const iqr = q3 - q1;

  const n = statNums.length;
  const sampleMean = statNums.reduce((a, b) => a + b, 0) / n;
  const sumSq = statNums.reduce((a, b) => a + (b - sampleMean) ** 2, 0);
  const variance = n > 1 ? sumSq / (n - 1) : 0;
  const std = Math.sqrt(variance);

  let skewness: number | null = null;
  if (n > 2 && std > 0) {
    const m3 = statNums.reduce((a, b) => a + ((b - sampleMean) / std) ** 3, 0) / n;
    skewness = roundTo((Math.sqrt(n * (n - 1)) / (n - 2)) * m3, 4);
  }

  const lowFence = q1 - 1.5 * iqr;
  const highFence = q3 + 1.5 * iqr;
  let outlierCount = 0;
  for (const v of statNums) {
    if (v < lowFence || v > highFence) outlierCount += 1;
  }
  // Scale sampled outlier count back to full size for an honest figure.
  if (statNums.length < nums.length) {
    outlierCount = Math.round((outlierCount / statNums.length) * nums.length);
  }

  return {
    ...(base as NumericColumnProfile),
    datatypeLabel: integerLike ? "Integer" : "Decimal",
    nonNumericCount,
    mean: roundTo(mean),
    median: roundTo(median),
    std: roundTo(std),
    variance: roundTo(variance),
    min: roundTo(min),
    max: roundTo(max),
    range: roundTo(max - min),
    q1: roundTo(q1),
    q3: roundTo(q3),
    iqr: roundTo(iqr),
    p5: roundTo(p5),
    p95: roundTo(p95),
    sum: roundTo(sum),
    zeroCount,
    negativeCount,
    outlierCount,
    skewness,
    cv: Math.abs(mean) > 1e-12 ? roundTo(std / Math.abs(mean), 4) : null,
    integerLike,
    currencySymbol,
    histogram: buildHistogram(sorted, min, max, integerLike),
  };
}

function buildHistogram(
  sorted: number[],
  min: number,
  max: number,
  integerLike: boolean,
): Array<{ x0: number; x1: number; count: number }> {
  if (sorted.length === 0 || min === max) {
    return min === max ? [{ x0: min, x1: max, count: sorted.length }] : [];
  }
  const distinct = new Set(sorted).size;
  // One bin per value only for a *densely-packed* small integer enum (e.g. a
  // 1–10 rating or month 1–12) — gate on the range, not the distinct count, so
  // a few integers spanning thousands (e.g. currency amounts) don't explode the
  // bin count.
  const binCount =
    integerLike && max - min <= MAX_HISTOGRAM_BINS
      ? Math.max(1, Math.round(max - min) + 1)
      : Math.min(MAX_HISTOGRAM_BINS, Math.max(5, Math.ceil(Math.sqrt(distinct))));
  const width = (max - min) / binCount;
  const bins = Array.from({ length: binCount }, (_, i) => ({
    x0: roundTo(min + i * width),
    x1: roundTo(min + (i + 1) * width),
    count: 0,
  }));
  for (const v of sorted) {
    let idx = Math.floor((v - min) / width);
    if (idx < 0) idx = 0;
    if (idx >= binCount) idx = binCount - 1;
    bins[idx].count += 1;
  }
  return bins;
}

function buildDateProfile(name: string, values: unknown[]): DateColumnProfile {
  const total = values.length;
  const nonBlank = values.filter((v) => !isBlank(v));
  const nullCount = total - nonBlank.length;

  const parsed: Date[] = [];
  let unparseableCount = 0;
  for (const v of nonBlank) {
    const d =
      v instanceof Date && !Number.isNaN(v.getTime())
        ? v
        : parseFlexibleDate(String(v));
    if (d && !Number.isNaN(d.getTime())) parsed.push(d);
    else unparseableCount += 1;
  }

  const distinctDays = new Set<string>();
  let minMs = Number.POSITIVE_INFINITY;
  let maxMs = Number.NEGATIVE_INFINITY;
  for (const d of parsed) {
    const ms = d.getTime();
    if (ms < minMs) minMs = ms;
    if (ms > maxMs) maxMs = ms;
    distinctDays.add(toLocalIsoDay(d));
  }

  const hasRange = Number.isFinite(minMs) && Number.isFinite(maxMs);
  const grain = parsed.length > 0 ? inferTemporalGrainFromDates(parsed) : null;

  return {
    name,
    kind: "date",
    datatypeLabel: "Date",
    totalValues: total,
    nullCount,
    nullPct: total > 0 ? roundTo((nullCount / total) * 100, 2) : 0,
    completeness: total > 0 ? roundTo((nonBlank.length / total) * 100, 2) : 100,
    distinctCount: distinctDays.size,
    minIso: hasRange ? toLocalIsoDay(new Date(minMs)) : null,
    maxIso: hasRange ? toLocalIsoDay(new Date(maxMs)) : null,
    spanDays: hasRange
      ? Math.max(0, Math.floor((maxMs - minMs) / 86_400_000))
      : null,
    distinctDayCount: distinctDays.size,
    unparseableCount,
    grain,
    timeline: hasRange ? buildTimeline(parsed, minMs, maxMs) : [],
  };
}

function buildTimeline(
  parsed: Date[],
  minMs: number,
  maxMs: number,
): Array<{ label: string; count: number }> {
  if (minMs === maxMs) {
    return [{ label: toLocalIsoDay(new Date(minMs)), count: parsed.length }];
  }
  const span = maxMs - minMs;
  const buckets = MAX_TIMELINE_BUCKETS;
  const width = span / buckets;
  const counts = new Array(buckets).fill(0);
  for (const d of parsed) {
    let idx = Math.floor((d.getTime() - minMs) / width);
    if (idx < 0) idx = 0;
    if (idx >= buckets) idx = buckets - 1;
    counts[idx] += 1;
  }
  const labelMode =
    span > 730 * 86_400_000 ? "year" : span > 90 * 86_400_000 ? "month" : "day";
  return counts.map((count, i) => {
    const iso = toLocalIsoDay(new Date(minMs + i * width));
    const label =
      labelMode === "year"
        ? iso.slice(0, 4)
        : labelMode === "month"
          ? iso.slice(0, 7)
          : iso;
    return { label, count };
  });
}

function buildCategoricalProfile(
  name: string,
  values: unknown[],
  isBoolean: boolean,
  positiveValues?: string[],
  negativeValues?: string[],
): CategoricalColumnProfile {
  const total = values.length;
  const counts = new Map<string, { value: string | number; count: number }>();
  let nonBlank = 0;
  let lenSum = 0;
  let minLength: number | null = null;
  let maxLength: number | null = null;

  for (const v of values) {
    if (isBlank(v)) continue;
    nonBlank += 1;
    const key = String(v);
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, { value: typeof v === "number" ? v : key, count: 1 });
    const len = key.length;
    lenSum += len;
    minLength = minLength === null ? len : Math.min(minLength, len);
    maxLength = maxLength === null ? len : Math.max(maxLength, len);
  }

  const nullCount = total - nonBlank;
  const distinctCount = counts.size;
  const sortedEntries = [...counts.values()].sort((a, b) => b.count - a.count);
  const top = sortedEntries.slice(0, MAX_TOP_VALUES).map((e) => ({
    value: e.value,
    count: e.count,
    pct: nonBlank > 0 ? roundTo((e.count / nonBlank) * 100, 2) : 0,
  }));
  const otherCount = nonBlank - top.reduce((s, t) => s + t.count, 0);

  const cardinalityRatio = nonBlank > 0 ? roundTo(distinctCount / nonBlank, 4) : 0;

  return {
    name,
    kind: isBoolean ? "boolean" : "categorical",
    datatypeLabel: isBoolean ? "Yes/No" : "Text",
    totalValues: total,
    nullCount,
    nullPct: total > 0 ? roundTo((nullCount / total) * 100, 2) : 0,
    completeness: total > 0 ? roundTo((nonBlank / total) * 100, 2) : 100,
    distinctCount,
    mode: sortedEntries[0]?.value ?? null,
    topValues: top,
    otherCount,
    otherPct: nonBlank > 0 ? roundTo((otherCount / nonBlank) * 100, 2) : 0,
    cardinalityRatio,
    isHighCardinality: distinctCount > 50 && cardinalityRatio > 0.5,
    isLikelyId:
      (nonBlank > 1 && distinctCount === nonBlank) || ID_NAME_RE.test(name),
    isConstant: distinctCount <= 1,
    minLength,
    maxLength,
    avgLength: nonBlank > 0 ? roundTo(lenSum / nonBlank, 1) : null,
    ...(isBoolean ? { positiveValues, negativeValues } : {}),
  };
}

function countDuplicateRows(data: Record<string, unknown>[]): number | null {
  if (data.length === 0 || data.length > DUPLICATE_SCAN_CAP) return null;
  const seen = new Set<string>();
  let dupes = 0;
  for (const row of data) {
    const key = JSON.stringify(row);
    if (seen.has(key)) dupes += 1;
    else seen.add(key);
  }
  return dupes;
}

/**
 * Build the rich, type-aware data summary. Column kind is taken from the
 * dataset's *authoritative* classification (numericColumns / dateColumns /
 * indicator metadata) so the modal agrees with how the agent treats columns.
 */
export function buildRichDataSummary(
  data: Record<string, unknown>[],
  dataSummary: DataSummary,
): RichDataSummary {
  const numericSet = new Set(dataSummary.numericColumns ?? []);
  const dateSet = new Set(dataSummary.dateColumns ?? []);
  const metaByName = new Map(
    (dataSummary.columns ?? []).map((c) => [c.name, c]),
  );

  // Authoritative, user-facing columns only — skip hidden __tf_* facet helpers.
  const columnNames = (dataSummary.columns ?? [])
    .filter((c) => !c.name.startsWith("__") && !c.temporalFacetGrain)
    .map((c) => c.name);

  const rowCount = data.length;
  const columns: RichColumnProfile[] = [];
  const typeBreakdown = { numeric: 0, date: 0, categorical: 0, boolean: 0 };
  let totalNulls = 0;

  for (const name of columnNames) {
    const values = data.map((row) => row[name]);
    const meta = metaByName.get(name);
    let profile: RichColumnProfile;

    if (numericSet.has(name)) {
      profile = buildNumericProfile(
        name,
        values,
        meta?.currency?.symbol ?? null,
      );
      typeBreakdown.numeric += 1;
    } else if (dateSet.has(name)) {
      profile = buildDateProfile(name, values);
      typeBreakdown.date += 1;
    } else {
      const indicator = meta?.indicator;
      const isBoolean = indicator?.kind === "boolean";
      profile = buildCategoricalProfile(
        name,
        values,
        isBoolean,
        indicator?.positiveValues,
        indicator?.negativeValues,
      );
      if (isBoolean) typeBreakdown.boolean += 1;
      else typeBreakdown.categorical += 1;
    }

    totalNulls += profile.nullCount;
    columns.push(profile);
  }

  const columnCount = columns.length;
  const totalCells = rowCount * columnCount;
  const overallCompleteness =
    totalCells > 0 ? roundTo((1 - totalNulls / totalCells) * 100, 2) : 100;

  return {
    dataset: {
      rowCount,
      columnCount,
      typeBreakdown,
      totalCells,
      totalNulls,
      overallCompleteness,
      duplicateRowCount: countDuplicateRows(data),
    },
    qualityScore: Math.max(0, Math.round(overallCompleteness)),
    columns,
  };
}
