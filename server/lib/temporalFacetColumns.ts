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
import type { DataSummary } from "../shared/schema.js";

export const TEMPORAL_FACET_PREFIX = "__tf_";

export type TemporalFacetGrain =
  | "date"
  | "week"
  | "month"
  | "quarter"
  | "half_year"
  | "year";

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
  | "day";

const GRAINS: TemporalFacetGrain[] = [
  "date",
  "week",
  "month",
  "quarter",
  "half_year",
  "year",
];

export const GRAIN_TO_PERIOD: Record<TemporalFacetGrain, DatePeriod> = {
  date: "day",
  week: "week",
  month: "month",
  quarter: "quarter",
  half_year: "half_year",
  year: "year",
};

/** Same grain labels as client `temporalFacetDisplay.ts`. */
const FACET_GRAIN_LABEL: Record<TemporalFacetGrain, string> = {
  date: "Day",
  week: "Week",
  month: "Month",
  quarter: "Quarter",
  half_year: "Half-year",
  year: "Year",
};

const DISPLAY_FACET_HEADER_RE = /^(Day|Week|Month|Quarter|Half-year|Year) · /;

const LABEL_TO_GRAIN_TOKEN: Record<string, string> = {
  Day: "date",
  Week: "week",
  Month: "month",
  Quarter: "quarter",
  "Half-year": "half_year",
  Year: "year",
};

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
  const m = key.match(/^(Day|Week|Month|Quarter|Half-year|Year) · (.+)$/);
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
  const m = name.match(/^(Day|Week|Month|Quarter|Half-year|Year) · /);
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
  tableColumns: Set<string>
): string | null {
  const m = logical.match(/^(Day|Week|Month|Quarter|Half-year|Year) · (.+)$/);
  if (!m) return null;
  const grainLabel = m[1]!;
  const sourceCol = m[2]!;
  if (!tableColumns.has(sourceCol)) return null;
  const grain = LABEL_TO_GRAIN_TOKEN[grainLabel] as TemporalFacetGrain | undefined;
  if (!grain) return null;
  const q = `"${sourceCol.replace(/"/g, '""')}"`;
  // COALESCE: try direct DATE cast first (works for "YYYY-MM-DD"), then fall
  // back through TIMESTAMP for ISO datetime strings like "2018-01-03T00:00:00.000Z"
  // that DuckDB cannot auto-cast straight to DATE.
  const src = `COALESCE(TRY_CAST(${q} AS DATE), CAST(TRY_CAST(${q} AS TIMESTAMP) AS DATE))`;
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
 */
export function applyTemporalFacetColumns(
  data: Record<string, any>[],
  dateColumns: string[]
): TemporalFacetColumnMeta[] {
  if (
    process.env.DISABLE_TEMPORAL_FACETS === "1" ||
    process.env.DISABLE_TEMPORAL_FACETS === "true"
  ) {
    return [];
  }
  if (data.length === 0 || !dateColumns.length) return [];

  migrateLegacyTemporalFacetRowKeys(data, dateColumns);

  const keys = new Set(Object.keys(data[0]));
  const bindings = resolveFacetSourceBindings(keys, dateColumns);
  // Never strip facet keys unless we can re-derive them from a bound source date column.
  // Otherwise columnar rows that already carry materialized facets would lose them.
  if (!bindings.length) return [];

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

  return meta;
}

export function detectCoarseTimeIntentFromMessage(
  message: string | undefined
): CoarseTimeIntent | null {
  if (!message?.trim()) return null;
  const q = message.toLowerCase();
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
  if (!availableKeys.has(facetKey)) {
    return { groupBy: groupByColumn, remapped: false };
  }
  return { groupBy: facetKey, remapped: true };
}
