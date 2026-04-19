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

const GRAIN_TO_PERIOD: Record<TemporalFacetGrain, DatePeriod> = {
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

/** Parse cell values the same way temporal facets do (incl. Date.parse fallback for M/D/YY). */
export function parseRowDate(raw: unknown): Date | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (raw instanceof Date && !isNaN(raw.getTime())) return raw;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const d = dateFromNumericCell(raw);
    if (d) return d;
  }
  const s = String(raw).trim();
  if (!s) return null;
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
