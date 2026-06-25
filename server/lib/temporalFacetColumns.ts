/**
 * Per-grain columns derived from approved date columns so coarse time group-bys
 * do not create one group per distinct day. Canonical row/summary keys match the
 * pivot UI: `Month · Order Date`. Legacy `__tf_grain__Slug` ids are still accepted
 * and remapped via buildLegacyToDisplayFacetMap / migrateLegacyTemporalFacetRowKeys.
 */
import { isLikelyIdentifierColumnName } from "./columnIdHeuristics.js";
import { findMatchingColumn } from "./agents/utils/columnMatcher.js";
import {
  normalizeDateToPeriod,
  parseFlexibleDate,
  type DatePeriod,
} from "./dateUtils.js";
import { isFlagOn } from "./featureFlags.js";
import type { DataSummary } from "../shared/schema.js";

export const TEMPORAL_FACET_PREFIX = "__tf_";

export type TemporalFacetGrain =
  | "date"
  | "week"
  | "month"
  | "quarter"
  | "half_year"
  | "year"
  // Sub-day grains (Wave H1–H5). Computed ON THE FLY via facetColumnInlineDuckDbExpr;
  // deliberately NOT in the `GRAINS` materialization array, so no "Hour · X" column
  // is ever written at ingest (the user's "dynamic, not pre-determined buckets").
  // `hour`/`minute` are absolute timeline buckets; `hour_of_day` is the cyclical
  // 0–23 bucket aggregated across days ("peak/typical hour"), like `monthOnly`.
  | "hour"
  | "hour_of_day"
  | "minute"
  // Cyclical weekday facet (Monday…Sunday). Unlike the sub-day grains this IS
  // materialized (in `GRAINS`) so "Day of week · X" is a real, filterable column
  // storing the pure-text weekday name. Ordering Mon→Sun is provided by the chart
  // /pivot sort authorities (weekdayRank), not a numeric sort-prefix.
  | "day_of_week";

export interface TemporalFacetColumnMeta {
  name: string;
  sourceColumn: string;
  grain: TemporalFacetGrain;
}

export type CoarseTimeIntent =
  | "year"
  | "quarter"
  | "half_year"
  | "month"
  | "week"
  | "day"
  // Sub-day intents (Wave H3). `hour` is the bare/absolute reading (the authority
  // downgrades it to `hour_of_day` on multi-day spans); `hour_of_day` is forced by
  // explicitly-cyclical phrasing ("peak hour", "time of day"); `minute` is explicit.
  | "hour"
  | "hour_of_day"
  | "minute";

const GRAINS: TemporalFacetGrain[] = [
  "date",
  "week",
  "month",
  "quarter",
  "half_year",
  "year",
  "day_of_week",
];

export const GRAIN_TO_PERIOD: Record<TemporalFacetGrain, DatePeriod> = {
  date: "day",
  week: "week",
  month: "month",
  quarter: "quarter",
  half_year: "half_year",
  year: "year",
  hour: "hour",
  hour_of_day: "hour_of_day",
  minute: "minute",
  day_of_week: "day_of_week",
};

/** Same grain labels as client `temporalFacetDisplay.ts`. */
const FACET_GRAIN_LABEL: Record<TemporalFacetGrain, string> = {
  date: "Day",
  week: "Week",
  month: "Month",
  quarter: "Quarter",
  half_year: "Half-year",
  year: "Year",
  hour: "Hour",
  hour_of_day: "Hour of day",
  minute: "Minute",
  // Distinct from `date` ("Day") — this is the cyclical weekday name column.
  day_of_week: "Day of week",
};

// "Day of week" MUST precede "Day" in every facet-header alternation below so the
// engine matches the longer label first (defensive — both require " · " after).
const DISPLAY_FACET_HEADER_RE = /^(Day of week|Day|Week|Month|Quarter|Half-year|Year|Hour of day|Hour|Minute) · /;

const LABEL_TO_GRAIN_TOKEN: Record<string, string> = {
  Day: "date",
  Week: "week",
  Month: "month",
  Quarter: "quarter",
  "Half-year": "half_year",
  Year: "year",
  Hour: "hour",
  "Hour of day": "hour_of_day",
  Minute: "minute",
  "Day of week": "day_of_week",
};

/**
 * Canonical column names produced by the wide→long melt
 * (`server/lib/wideFormat/meltDataset.ts` — kept in sync here so the hot facet
 * path does not import the melt module). A "period dimension" is the
 * `Period` / `PeriodIso` / `PeriodKind` triple: a melted period column whose
 * grain facets must derive from the already-canonical `PeriodIso` value, NOT
 * from parsing the human `Period` label as a calendar date.
 */
export const MELT_PERIOD_COL = "Period";
export const MELT_PERIOD_ISO_COL = "PeriodIso";
export const MELT_PERIOD_KIND_COL = "PeriodKind";

export interface PeriodDimensionBinding {
  /** The melted human-label period column (e.g. "Period"). */
  periodCol: string;
  /** The companion canonical ISO column (e.g. "PeriodIso"). */
  isoCol: string;
}

/**
 * Per-grain gate on the canonical `PeriodIso` SHAPE. We gate on shape rather
 * than `PeriodKind` because the half-year matcher reuses `kind:"quarter"` with
 * an `YYYY-HN` iso (periodVocabulary.ts). The `year` grain rolls up from any
 * calendar shape (captures the leading `YYYY`); every finer grain fills only
 * when its own shape matches. Relative isos (`L12M-2YA`, `YTD-TY`, `MAT-…`,
 * `XXXX-Q1`) match nothing → null in all grains (correct: no calendar grain).
 */
const NEVER_MATCH_RE = /(?!)/;
const PERIOD_ISO_GRAIN_RE: Record<TemporalFacetGrain, RegExp> = {
  year: /^(\d{4})(?:-(?:Q[1-4]|H[12]|\d{2}|W\d{2}|\d{2}-\d{2}))?$/,
  half_year: /^\d{4}-H[12]$/,
  quarter: /^\d{4}-Q[1-4]$/,
  month: /^\d{4}-\d{2}$/,
  week: /^\d{4}-W\d{2}$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
  // Melted wide-format periods have no sub-day / weekday shape — never match.
  hour: NEVER_MATCH_RE,
  hour_of_day: NEVER_MATCH_RE,
  minute: NEVER_MATCH_RE,
  day_of_week: NEVER_MATCH_RE,
};

/**
 * Grain value for one `PeriodIso` cell, or null when the iso has no such grain.
 * `year` extracts the leading `YYYY`; every other grain returns the iso verbatim.
 */
export function periodIsoFacetValue(
  iso: unknown,
  grain: TemporalFacetGrain
): string | null {
  if (typeof iso !== "string" || !iso) return null;
  const m = iso.match(PERIOD_ISO_GRAIN_RE[grain]);
  if (!m) return null;
  return grain === "year" ? m[1]! : iso;
}

/**
 * Fill the six grain facet columns for a melted period dimension directly from
 * the canonical `PeriodIso` value, bypassing `parseRowDate` (which cannot read
 * labels like "Q1 23" / "YTD 2YA"). Mutates rows; returns the column metadata.
 */
export function applyPeriodDimensionFacets(
  data: Record<string, any>[],
  binding: PeriodDimensionBinding
): TemporalFacetColumnMeta[] {
  if (data.length === 0) return [];
  const meta: TemporalFacetColumnMeta[] = GRAINS.map((grain) => ({
    name: facetColumnKey(binding.periodCol, grain),
    sourceColumn: binding.periodCol,
    grain,
  }));
  for (const row of data) {
    const iso = row[binding.isoCol];
    for (const grain of GRAINS) {
      row[facetColumnKey(binding.periodCol, grain)] = periodIsoFacetValue(iso, grain);
    }
  }
  return meta;
}

/**
 * Build a `PeriodDimensionBinding` from a data summary's wide-format transform.
 * Returns undefined for tidy (non-melted) datasets. Use at facet call sites that
 * have the summary in hand to gate the period path on the authoritative
 * `wf.detected` flag rather than relying on self-detection.
 */
export function periodDimensionFromSummary(
  summary: Pick<DataSummary, "wideFormatTransform"> | null | undefined
): PeriodDimensionBinding | undefined {
  const wf = summary?.wideFormatTransform;
  if (wf?.detected && wf.periodColumn && wf.periodIsoColumn) {
    return { periodCol: wf.periodColumn, isoCol: wf.periodIsoColumn };
  }
  return undefined;
}

/**
 * Resolve the period-dimension binding for a facet pass. Prefers the explicit
 * binding (threaded from `summary.wideFormatTransform`); falls back to
 * self-detection when the melt's canonical triple is present on the rows and
 * the period column is among the date columns being faceted.
 */
function resolvePeriodDimension(
  dateColumns: string[],
  rowKeys: Set<string>,
  explicit?: PeriodDimensionBinding
): PeriodDimensionBinding | undefined {
  if (explicit && dateColumns.includes(explicit.periodCol) && rowKeys.has(explicit.isoCol)) {
    return explicit;
  }
  if (
    dateColumns.includes(MELT_PERIOD_COL) &&
    rowKeys.has(MELT_PERIOD_ISO_COL)
  ) {
    return { periodCol: MELT_PERIOD_COL, isoCol: MELT_PERIOD_ISO_COL };
  }
  return undefined;
}

export function isTemporalFacetColumnKey(name: string): boolean {
  if (name.startsWith(TEMPORAL_FACET_PREFIX)) return true;
  return DISPLAY_FACET_HEADER_RE.test(name);
}

/**
 * Split a display facet key like `Month · Order Date` into its underlying source
 * column and grain. Returns null for legacy `__tf_*` keys and non-facet names.
 * Used by in-JS aggregation when the physical row lacks the facet column and the
 * bucket must be computed from the source date on the fly.
 */
export function parseTemporalFacetDisplayKey(
  key: string
): { sourceColumn: string; grain: TemporalFacetGrain } | null {
  const m = key.match(/^(Day of week|Day|Week|Month|Quarter|Half-year|Year|Hour of day|Hour|Minute) · (.+)$/);
  if (!m) return null;
  const grain = LABEL_TO_GRAIN_TOKEN[m[1]!] as TemporalFacetGrain | undefined;
  if (!grain) return null;
  return { sourceColumn: m[2]!, grain };
}

export function slugifyColumnKeyForFacet(sourceColumn: string): string {
  const s = sourceColumn
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
  return s || "col";
}

/** Legacy machine id (e.g. `__tf_month__Order_Date`) for remapping and old DuckDB columns. */
export function facetColumnLegacyMachineKey(
  sourceColumn: string,
  grain: TemporalFacetGrain
): string {
  return `${TEMPORAL_FACET_PREFIX}${grain}__${slugifyColumnKeyForFacet(sourceColumn)}`;
}

/**
 * Canonical facet column id — same string as pivot field labels (e.g. `Month · Order Date`).
 */
export function facetColumnKey(
  sourceColumn: string,
  grain: TemporalFacetGrain
): string {
  const label = FACET_GRAIN_LABEL[grain] ?? grain;
  return `${label} · ${sourceColumn}`;
}

/**
 * Grain segment for a facet column: legacy `__tf_month__...` or display `Month · ...`.
 */
export function temporalFacetGrainTokenFromFacetColumnName(name: string): string | null {
  if (name.startsWith(TEMPORAL_FACET_PREFIX)) {
    const without = name.slice(TEMPORAL_FACET_PREFIX.length);
    const i = without.indexOf("__");
    if (i <= 0) return null;
    return without.slice(0, i);
  }
  const m = name.match(/^(Day of week|Day|Week|Month|Quarter|Half-year|Year|Hour of day|Hour|Minute) · /);
  return m ? LABEL_TO_GRAIN_TOKEN[m[1]!] ?? null : null;
}

export function buildLegacyToDisplayFacetMap(
  summary: Pick<DataSummary, "temporalFacetColumns" | "dateColumns">
): Map<string, string> {
  const map = new Map<string, string>();
  const dateCols = summary.dateColumns ?? [];
  for (const m of temporalFacetMetadataForDateColumns(dateCols)) {
    const displayName = m.name;
    map.set(facetColumnLegacyMachineKey(m.sourceColumn, m.grain), displayName);
  }
  for (const m of summary.temporalFacetColumns ?? []) {
    const displayName = facetColumnKey(m.sourceColumn, m.grain);
    map.set(facetColumnLegacyMachineKey(m.sourceColumn, m.grain), displayName);
    if (m.name !== displayName) {
      map.set(m.name, displayName);
    }
  }
  return map;
}

/** For DuckDB/SQL: map canonical display facet id → legacy column name when the table was built with __tf_* keys. */
export function buildDisplayToLegacyFacetMap(
  summary: Pick<DataSummary, "temporalFacetColumns" | "dateColumns">
): Map<string, string> {
  const inv = new Map<string, string>();
  for (const [legacy, display] of buildLegacyToDisplayFacetMap(summary)) {
    if (!inv.has(display)) inv.set(display, legacy);
  }
  return inv;
}

export function duckPhysicalColumnName(
  logical: string,
  tableColumns: Set<string>,
  displayToLegacy: Map<string, string>
): string {
  if (tableColumns.has(logical)) return logical;
  const leg = displayToLegacy.get(logical);
  if (leg && tableColumns.has(leg)) return leg;
  return logical;
}

/**
 * W13: Return a DuckDB SQL expression that computes a temporal facet column's
 * value inline from its source date column. Callers should use this instead of
 * the materialized facet column when the source date column is present in the
 * table, because materialized values can be null when date parsing failed during
 * the upload/enrichment pipeline.
 *
 * The expressions produce the same format as `normalizeDateToPeriod`:
 *   year       → "2016"
 *   month      → "2016-01"
 *   quarter    → "2016-Q1"
 *   half_year  → "2016-H1"
 *   day        → "2016-01-15"
 *   week       → "2016-W03"  (ISO week)
 *
 * Returns null when `logical` is not a display facet column name, or when the
 * source date column is absent from `tableColumns`.
 */
export function facetColumnInlineDuckDbExpr(
  logical: string,
  tableColumns: Set<string>,
  periodDimension?: PeriodDimensionBinding
): string | null {
  const m = logical.match(/^(Day of week|Day|Week|Month|Quarter|Half-year|Year|Hour of day|Hour|Minute) · (.+)$/);
  if (!m) return null;
  const grainLabel = m[1]!;
  const sourceCol = m[2]!;
  if (!tableColumns.has(sourceCol)) return null;
  const grain = LABEL_TO_GRAIN_TOKEN[grainLabel] as TemporalFacetGrain | undefined;
  if (!grain) return null;

  // Melted period dimension: derive the grain from the canonical PeriodIso
  // value, never from casting the human Period label to a DATE (which yields
  // NULL for "Q1 23" / "YTD 2YA"). Prefer the explicit binding; self-detect
  // the canonical triple otherwise.
  const pd =
    periodDimension &&
    sourceCol === periodDimension.periodCol &&
    tableColumns.has(periodDimension.isoCol)
      ? periodDimension
      : sourceCol === MELT_PERIOD_COL && tableColumns.has(MELT_PERIOD_ISO_COL)
        ? { periodCol: MELT_PERIOD_COL, isoCol: MELT_PERIOD_ISO_COL }
        : undefined;
  if (pd) {
    const iso = `"${pd.isoCol.replace(/"/g, '""')}"`;
    // RE2 full-match patterns mirror PERIOD_ISO_GRAIN_RE. Plain single-quoted
    // DuckDB strings do not process backslash escapes, so '\\d' → \d reaches RE2.
    switch (grain) {
      case "year":
        return `CASE WHEN regexp_full_match(${iso}, '\\d{4}(-(Q[1-4]|H[12]|\\d{2}|W\\d{2}|\\d{2}-\\d{2}))?') THEN regexp_extract(${iso}, '^(\\d{4})', 1) END`;
      case "half_year":
        return `CASE WHEN regexp_full_match(${iso}, '\\d{4}-H[12]') THEN ${iso} END`;
      case "quarter":
        return `CASE WHEN regexp_full_match(${iso}, '\\d{4}-Q[1-4]') THEN ${iso} END`;
      case "month":
        return `CASE WHEN regexp_full_match(${iso}, '\\d{4}-\\d{2}') THEN ${iso} END`;
      case "week":
        return `CASE WHEN regexp_full_match(${iso}, '\\d{4}-W\\d{2}') THEN ${iso} END`;
      case "date":
        return `CASE WHEN regexp_full_match(${iso}, '\\d{4}-\\d{2}-\\d{2}') THEN ${iso} END`;
      default:
        return null;
    }
  }

  const q = `"${sourceCol.replace(/"/g, '""')}"`;
  // COALESCE: try direct DATE cast first (works for "YYYY-MM-DD"), then fall
  // back through TIMESTAMP for ISO datetime strings like "2018-01-03T00:00:00.000Z"
  // that DuckDB cannot auto-cast straight to DATE.
  const src = `COALESCE(TRY_CAST(${q} AS DATE), CAST(TRY_CAST(${q} AS TIMESTAMP) AS DATE))`;
  // Sub-day grains (Wave H5) need the TIMESTAMP (the DATE cast above is destructive
  // of the time). Pure time-of-day columns ("09:45:34", no date) cast to TIME and
  // can only bucket cyclically — so absolute hour/minute COALESCE down to the
  // clock-hour / clock-minute. Keys match normalizeDateToPeriod exactly so the
  // DuckDB path and the in-JS path agree.
  const ts = `TRY_CAST(${q} AS TIMESTAMP)`;
  const tm = `TRY_CAST(${q} AS TIME)`;
  switch (grain) {
    case "year":
      return `strftime('%Y', ${src})`;
    case "month":
      return `strftime('%Y-%m', ${src})`;
    case "quarter":
      return `printf('%d-Q%d', YEAR(${src}), QUARTER(${src}))`;
    case "half_year":
      return `printf('%d-H%d', YEAR(${src}), CASE WHEN MONTH(${src}) <= 6 THEN 1 ELSE 2 END)`;
    case "date":
      return `strftime('%Y-%m-%d', ${src})`;
    case "week":
      return `printf('%d-W%02d', date_part('isoyear', ${src}), date_part('week', ${src}))`;
    case "hour":
      return `COALESCE(strftime(date_trunc('hour', ${ts}), '%Y-%m-%d %H'), printf('%02d', EXTRACT(hour FROM ${tm})))`;
    case "minute":
      return `COALESCE(strftime(date_trunc('minute', ${ts}), '%Y-%m-%d %H:%M'), printf('%02d:%02d', EXTRACT(hour FROM ${tm}), EXTRACT(minute FROM ${tm})))`;
    case "hour_of_day":
      return `COALESCE(printf('%02d', EXTRACT(hour FROM ${ts})), printf('%02d', EXTRACT(hour FROM ${tm})))`;
    case "day_of_week":
      // Full weekday name ("Monday"…"Sunday"), byte-identical to the in-JS
      // normalizeDateToPeriod('day_of_week') key so DuckDB and JS paths agree.
      return `strftime(${src}, '%A')`;
    default:
      return null;
  }
}

/** Remap legacy `__tf_*` keys on rows to display facet keys (old DuckDB / sessions). */
export function migrateLegacyTemporalFacetRowKeys(
  data: Record<string, any>[],
  dateColumns: string[]
): void {
  if (data.length === 0 || !dateColumns.length) return;
  const metas = temporalFacetMetadataForDateColumns(dateColumns);
  for (const m of metas) {
    const legacy = facetColumnLegacyMachineKey(m.sourceColumn, m.grain);
    if (legacy === m.name) continue;
    for (const row of data) {
      if (!Object.prototype.hasOwnProperty.call(row, legacy)) continue;
      if (!Object.prototype.hasOwnProperty.call(row, m.name)) {
        row[m.name] = row[legacy];
      }
      delete row[legacy];
    }
  }
}

export function normalizeLegacyTemporalFacetColumnRef(
  col: string,
  map: Map<string, string>
): string {
  return map.get(col) ?? col;
}

export function temporalFacetMetadataForDateColumns(
  dateColumns: string[]
): TemporalFacetColumnMeta[] {
  const meta: TemporalFacetColumnMeta[] = [];
  for (const src of dateColumns) {
    if (isLikelyIdentifierColumnName(src)) continue;
    for (const grain of GRAINS) {
      meta.push({
        name: facetColumnKey(src, grain),
        sourceColumn: src,
        grain,
      });
    }
  }
  return meta;
}

export function temporalFacetColumnNamesForDateColumns(
  dateColumns: string[]
): string[] {
  return temporalFacetMetadataForDateColumns(dateColumns).map((m) => m.name);
}

export function stripTemporalFacetColumns(data: Record<string, any>[]): void {
  if (data.length === 0) return;
  for (const row of data) {
    for (const key of Object.keys(row)) {
      if (isTemporalFacetColumnKey(key)) delete row[key];
    }
  }
}

/**
 * Non-mutating sibling of `stripTemporalFacetColumns`: returns a new row array
 * with every temporal-facet column projected out, leaving the input untouched.
 * Returns the SAME array reference when there are no facet columns to drop.
 *
 * Use this for exports/downloads: the rows handed back by `loadLatestData` can
 * be shared/cached session state (e.g. the `sampleRows` fallback returns
 * `chatDocument.sampleRows` by reference), so deleting keys in place would
 * corrupt that state. Temporal facets are internal aggregation helpers that the
 * server re-derives from the source date columns on every load, so omitting
 * them from a downloaded file is lossless.
 */
export function withoutTemporalFacetColumns(
  data: Record<string, any>[]
): Record<string, any>[] {
  if (data.length === 0) return data;
  const facetKeys = Object.keys(data[0]!).filter(isTemporalFacetColumnKey);
  if (facetKeys.length === 0) return data;
  const drop = new Set(facetKeys);
  return data.map((row) => {
    const out: Record<string, any> = {};
    for (const k of Object.keys(row)) {
      if (!drop.has(k)) out[k] = row[k];
    }
    return out;
  });
}

const MS_PER_DAY = 86400000;

/** Excel serial days (approx. 1980–2035) vs epoch ms / unix seconds. */
function dateFromNumericCell(raw: number): Date | null {
  if (!Number.isFinite(raw)) return null;
  if (raw > 1e12 && raw < 4e12) return new Date(raw);
  if (raw > 1e9 && raw < 1e12) return new Date(raw * 1000);
  if (raw >= 20000 && raw <= 60000) {
    const d = new Date(Math.round((raw - 25569) * MS_PER_DAY));
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * Detect "duck-typed" date wrappers — driver-side value objects (e.g. DuckDB
 * `DATE` / `TIMESTAMP` returned through node bindings) that have no enumerable
 * own properties (so `JSON.stringify` renders them as `{}`) but expose dates
 * via methods or numeric internals. Returns null if `raw` doesn't look like
 * one of the recognised shapes.
 */
function dateFromObjectWrapper(raw: object): Date | null {
  const o = raw as Record<string, unknown>;

  if (typeof o.toISOString === "function") {
    try {
      const iso = (o.toISOString as () => unknown).call(o);
      if (typeof iso === "string") {
        const t = Date.parse(iso);
        if (!isNaN(t)) return new Date(t);
      }
    } catch {
      /* fall through */
    }
  }

  if (typeof o.epochMs === "number" && Number.isFinite(o.epochMs)) {
    return new Date(o.epochMs);
  }
  if (typeof o.epochSeconds === "number" && Number.isFinite(o.epochSeconds)) {
    return new Date(o.epochSeconds * 1000);
  }
  if (typeof o.micros === "bigint") {
    const ms = Number(o.micros / 1000n);
    if (Number.isFinite(ms)) return new Date(ms);
  }
  if (typeof o.micros === "number" && Number.isFinite(o.micros)) {
    return new Date(o.micros / 1000);
  }
  if (typeof o.days === "number" && Number.isFinite(o.days)) {
    return new Date(o.days * MS_PER_DAY);
  }
  if (typeof o.days === "bigint") {
    const ms = Number(o.days) * MS_PER_DAY;
    if (Number.isFinite(ms)) return new Date(ms);
  }

  if (typeof o.toString === "function" && o.toString !== Object.prototype.toString) {
    try {
      const s = String(o);
      if (s && s !== "[object Object]") {
        const flex = parseFlexibleDate(s);
        if (flex) return flex;
        const t = Date.parse(s);
        if (!isNaN(t)) return new Date(t);
      }
    } catch {
      /* fall through */
    }
  }

  return null;
}

/** Parse cell values the same way temporal facets do (incl. Date.parse fallback for M/D/YY). */
export function parseRowDate(raw: unknown): Date | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (raw instanceof Date && !isNaN(raw.getTime())) return raw;
  if (Array.isArray(raw)) return null;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const d = dateFromNumericCell(raw);
    if (d) return d;
  }
  if (typeof raw === "object") {
    const d = dateFromObjectWrapper(raw as object);
    if (d && !isNaN(d.getTime())) return d;
    return null;
  }
  const s = String(raw).trim();
  if (!s || s === "[object Object]") return null;
  const flex = parseFlexibleDate(s);
  if (flex) return flex;
  if (/^\d{4}$/.test(s)) {
    const y = Number(s);
    if (y >= 1900 && y <= 2100) return new Date(y, 0, 1);
  }
  const t = Date.parse(s);
  if (!isNaN(t)) return new Date(t);
  return null;
}

export type FacetSourceBinding = { logical: string; readFrom: string };

/**
 * For each logical date column in summary, choose where to read values from the row.
 * If "Order Date" is missing but "Cleaned_Order Date" exists (enrichment), read cleaned
 * but still emit facet keys for the logical name (e.g. `Year · Order Date`).
 */
export function resolveFacetSourceBindings(
  keys: Set<string>,
  dateColumns: string[]
): FacetSourceBinding[] {
  const bindings: FacetSourceBinding[] = [];
  for (const src of dateColumns) {
    if (isLikelyIdentifierColumnName(src)) continue;
    if (keys.has(src)) {
      bindings.push({ logical: src, readFrom: src });
      continue;
    }
    const cleaned = `Cleaned_${src}`;
    if (keys.has(cleaned)) {
      bindings.push({ logical: src, readFrom: cleaned });
      continue;
    }
    const keyList = [...keys];
    const fuzzy = findMatchingColumn(src, keyList);
    if (fuzzy && keys.has(fuzzy)) {
      bindings.push({ logical: src, readFrom: fuzzy });
    }
  }
  return bindings;
}

/**
 * Mutates rows: migrates legacy facet keys, removes prior facet keys, then adds
 * facet fields for each date column. Returns metadata for columns written.
 *
 * SU-FU1 · `excludeTimeOfDayColumns` (optional) — defense in depth against
 * the case where an upstream caller (e.g. the dataset-profile LLM) labelled
 * a time-only column ("Clock-In Time" with values "09:45:34") as a date.
 * `parseRowDate` returns null on every cell of such a column, so the facet
 * fields it generates would be entirely null and only pollute the schema +
 * the XLSX download. When the caller supplies this set, those columns are
 * skipped from facet generation entirely.
 *
 * `periodDimension` (optional) — when the dataset was melted from wide format,
 * the `Period` label column must NOT be parsed as a date (its values are
 * "Q1 23" / "YTD 2YA" which `parseRowDate` cannot read). Its grain facets are
 * derived from the canonical `PeriodIso` shape instead. Self-detected from the
 * melt's `Period`/`PeriodIso` triple when not supplied.
 */
export function applyTemporalFacetColumns(
  data: Record<string, any>[],
  dateColumns: string[],
  options?: {
    excludeTimeOfDayColumns?: ReadonlySet<string>;
    periodDimension?: PeriodDimensionBinding;
  }
): TemporalFacetColumnMeta[] {
  if (isFlagOn("DISABLE_TEMPORAL_FACETS")) {
    return [];
  }
  if (data.length === 0 || !dateColumns.length) return [];

  const excluded = options?.excludeTimeOfDayColumns;
  const effectiveDateColumns = excluded
    ? dateColumns.filter((c) => !excluded.has(c))
    : dateColumns;
  if (effectiveDateColumns.length === 0) return [];

  const keys = new Set(Object.keys(data[0]!));

  // A melted period dimension derives its grain facets from PeriodIso; it must
  // be removed from the generic (parseRowDate) date path so it is never faceted
  // by date-casting the label.
  const periodDim = resolvePeriodDimension(
    effectiveDateColumns,
    keys,
    options?.periodDimension
  );
  const genericDateColumns = periodDim
    ? effectiveDateColumns.filter((c) => c !== periodDim.periodCol)
    : effectiveDateColumns;

  migrateLegacyTemporalFacetRowKeys(data, genericDateColumns);

  const bindings = resolveFacetSourceBindings(keys, genericDateColumns);
  // Never strip facet keys unless we can re-derive them — from a bound source
  // date column or from the period dimension. Otherwise columnar rows that
  // already carry materialized facets would lose them.
  if (!bindings.length && !periodDim) return [];

  stripTemporalFacetColumns(data);

  const logicalSources = [...new Set(bindings.map((b) => b.logical))];
  const meta = temporalFacetMetadataForDateColumns(logicalSources);

  for (const row of data) {
    for (const { logical, readFrom } of bindings) {
      let rawVal = row[readFrom];
      if (
        (rawVal === null || rawVal === undefined || rawVal === "") &&
        readFrom !== logical &&
        keys.has(logical)
      ) {
        rawVal = row[logical];
      }
      const d = parseRowDate(rawVal);
      for (const grain of GRAINS) {
        const colKey = facetColumnKey(logical, grain);
        if (!d) {
          row[colKey] = null;
          continue;
        }
        const period = GRAIN_TO_PERIOD[grain];
        const norm = normalizeDateToPeriod(d, period);
        row[colKey] = norm ? norm.normalizedKey : null;
      }
    }
  }

  if (periodDim) {
    meta.push(...applyPeriodDimensionFacets(data, periodDim));
  }

  return meta;
}

export function detectCoarseTimeIntentFromMessage(
  message: string | undefined
): CoarseTimeIntent | null {
  if (!message?.trim()) return null;
  const q = message.toLowerCase();
  // Sub-day intents (Wave H3) — checked FIRST (most granular wins). Explicitly
  // cyclical phrasings force hour_of_day; a bare "hourly"/"by hour" returns "hour"
  // and the authority downgrades it to hour_of_day when the data spans many days.
  // Deliberately NOT triggered by "working hours" / "man-hours" (duration asks) —
  // those carry no "hourly" / "by-hour" / "hour-of-day" bucketing cue.
  if (
    /\b(peak|busiest|quietest|slowest)\s+hours?\b/.test(q) ||
    /\bhours?\s+of\s+(?:the\s+)?day\b/.test(q) ||
    /\btime\s+of\s+(?:the\s+)?day\b/.test(q) ||
    /\b(?:which|what)\s+hour\b/.test(q) ||
    /\bhourly\s+(pattern|profile|distribution|breakdown|seasonality|cycle)\b/.test(q)
  ) {
    return "hour_of_day";
  }
  if (
    /\bby\s+minute\b/.test(q) ||
    /\bper\s+minute\b/.test(q) ||
    /\bminute[-\s]by[-\s]minute\b/.test(q) ||
    /\bevery\s+\d+\s*min(?:ute)?s?\b/.test(q)
  ) {
    return "minute";
  }
  if (
    /\bhourly\b/.test(q) ||
    /\b(?:by|per|each)\s+hour\b/.test(q) ||
    /\bby\s+the\s+hour\b/.test(q) ||
    /\bhour[-\s]by[-\s]hour\b/.test(q) ||
    /\bintraday\b/.test(q)
  ) {
    return "hour";
  }
  if (
    /\b(half year|half-year|semiannual|semi-annual|semi annual)\b/.test(q) ||
    /\bh1\b/.test(q) ||
    /\bh2\b/.test(q)
  ) {
    return "half_year";
  }
  if (
    /\b(quarterly|by quarter|per quarter|each quarter)\b/.test(q) ||
    (q.includes("quarter") && !q.includes("half"))
  ) {
    return "quarter";
  }
  if (
    /\b(monthly|by month|per month|each month)\b/.test(q) ||
    (q.includes("month") &&
      !q.includes("6 month") &&
      !q.includes("six month") &&
      !q.includes("quarter"))
  ) {
    return "month";
  }
  if (/\b(weekly|by week|per week|each week)\b/.test(q) || /\bby\s+week\b/.test(q)) {
    return "week";
  }
  if (
    /\b(yearly|annual|annually|by year|per year|each year)\b/.test(q) ||
    /\bby\s+year\b/.test(q) ||
    /\baggregat\w*\s+(?:\w+\s+){0,4}by\s+year\b/.test(q)
  ) {
    return "year";
  }
  if (/\b(daily|by day|per day|each day)\b/.test(q) || /\bby\s+day\b/.test(q)) {
    return "day";
  }
  return null;
}

const INTENT_TO_GRAIN: Record<CoarseTimeIntent, TemporalFacetGrain> = {
  year: "year",
  quarter: "quarter",
  half_year: "half_year",
  month: "month",
  week: "week",
  day: "date",
  hour: "hour",
  hour_of_day: "hour_of_day",
  minute: "minute",
};

export function resolveDateColumnForGroupBy(
  groupByColumn: string,
  dateColumns: string[]
): string | null {
  const g = groupByColumn.trim();
  const direct = dateColumns.find((c) => c === g);
  if (direct) return direct;
  const lower = g.toLowerCase();
  return (
    dateColumns.find((c) => c.toLowerCase() === lower) ??
    dateColumns.find((c) => c.toLowerCase().replace(/\s+/g, " ") === lower) ??
    null
  );
}

/** Map execute_query_plan dateAggregationPeriod to the same coarse intents as the user message. */
export function coarseTimeIntentFromQueryPlanDatePeriod(
  period: string
): CoarseTimeIntent | null {
  switch (period) {
    case "day":
      return "day";
    case "week":
      return "week";
    case "month":
    case "monthOnly":
      return "month";
    case "quarter":
      return "quarter";
    case "half_year":
      return "half_year";
    case "year":
      return "year";
    case "hour":
      return "hour";
    case "hour_of_day":
      return "hour_of_day";
    case "minute":
      return "minute";
    default:
      return null;
  }
}

/**
 * When the user asks for coarse time aggregation but groupBy is still the raw date column,
 * rewrite to the matching UI facet column id.
 */
export function remapGroupByToTemporalFacet(params: {
  groupByColumn: string;
  dateColumns: string[];
  originalMessage: string | undefined;
  availableKeys: Set<string>;
  /** From execute_query_plan when the trend patch set period without "monthly" etc. in the message. */
  planDateAggregationPeriod?: string | null;
}): { groupBy: string; remapped: boolean } {
  const {
    groupByColumn,
    dateColumns,
    originalMessage,
    availableKeys,
    planDateAggregationPeriod,
  } = params;
  if (isTemporalFacetColumnKey(groupByColumn)) {
    return { groupBy: groupByColumn, remapped: false };
  }
  let intent = detectCoarseTimeIntentFromMessage(originalMessage);
  if (
    !intent &&
    planDateAggregationPeriod != null &&
    planDateAggregationPeriod !== undefined
  ) {
    intent = coarseTimeIntentFromQueryPlanDatePeriod(planDateAggregationPeriod);
  }
  if (!intent) return { groupBy: groupByColumn, remapped: false };

  const source = resolveDateColumnForGroupBy(groupByColumn, dateColumns);
  if (!source) return { groupBy: groupByColumn, remapped: false };

  const grain = INTENT_TO_GRAIN[intent];
  const facetKey = facetColumnKey(source, grain);
  const isSubDay = grain === "hour" || grain === "minute" || grain === "hour_of_day";
  // Calendar facets must be materialized (availableKeys has the facet key). Sub-day
  // facets are NEVER materialized — they're computed on the fly from the source — so
  // allow the rewrite whenever the source date column itself is present on the frame.
  const canRemap = isSubDay
    ? availableKeys.has(facetKey) || availableKeys.has(source)
    : availableKeys.has(facetKey);
  if (!canRemap) {
    return { groupBy: groupByColumn, remapped: false };
  }
  return { groupBy: facetKey, remapped: true };
}
