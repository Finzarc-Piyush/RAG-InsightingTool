/**
 * Hidden per-grain columns (__tf_*) derived from approved date columns so
 * group-by-year/month/etc. does not create one group per distinct day.
 */
import { isLikelyIdentifierColumnName } from "./columnIdHeuristics.js";
import {
  normalizeDateToPeriod,
  parseFlexibleDate,
  type DatePeriod,
} from "./dateUtils.js";

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

export function isTemporalFacetColumnKey(name: string): boolean {
  return name.startsWith(TEMPORAL_FACET_PREFIX);
}

export function slugifyColumnKeyForFacet(sourceColumn: string): string {
  const s = sourceColumn
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
  return s || "col";
}

export function facetColumnKey(
  sourceColumn: string,
  grain: TemporalFacetGrain
): string {
  return `${TEMPORAL_FACET_PREFIX}${grain}__${slugifyColumnKeyForFacet(sourceColumn)}`;
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

function parseRowDate(raw: unknown): Date | null {
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
 * but still emit __tf_* keys for the logical name (e.g. __tf_year__Order_Date).
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
    }
  }
  return bindings;
}

/**
 * Mutates rows: removes prior __tf_* keys, then adds facet fields for each date column.
 * Returns metadata for columns written (for summaries).
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

  stripTemporalFacetColumns(data);

  const keys = new Set(Object.keys(data[0]));
  const bindings = resolveFacetSourceBindings(keys, dateColumns);
  if (!bindings.length) return [];

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

/**
 * When the user asks for coarse time aggregation but groupBy is still the raw date column,
 * rewrite to the matching __tf_* column.
 */
export function remapGroupByToTemporalFacet(params: {
  groupByColumn: string;
  dateColumns: string[];
  originalMessage: string | undefined;
  availableKeys: Set<string>;
}): { groupBy: string; remapped: boolean } {
  const { groupByColumn, dateColumns, originalMessage, availableKeys } = params;
  if (isTemporalFacetColumnKey(groupByColumn)) {
    return { groupBy: groupByColumn, remapped: false };
  }
  const intent = detectCoarseTimeIntentFromMessage(originalMessage);
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
