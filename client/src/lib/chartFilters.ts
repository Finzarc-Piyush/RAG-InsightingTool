import { format } from "date-fns";

export type ChartFilterType = "categorical" | "date" | "numeric";

export interface CategoricalFilterOption {
  value: string;
  label: string;
  count: number;
}

export interface CategoricalFilterDefinition {
  key: string;
  label: string;
  type: "categorical";
  options: CategoricalFilterOption[];
}

export interface DateFilterDefinition {
  key: string;
  label: string;
  type: "date";
  min?: string;
  max?: string;
}

export interface NumericFilterDefinition {
  key: string;
  label: string;
  type: "numeric";
  min: number;
  max: number;
}

export type ChartFilterDefinition = CategoricalFilterDefinition | DateFilterDefinition | NumericFilterDefinition;

export interface CategoricalFilterSelection {
  type: "categorical";
  values: string[];
}

export interface DateFilterSelection {
  type: "date";
  start?: string;
  end?: string;
}

export interface NumericFilterSelection {
  type: "numeric";
  min?: number;
  max?: number;
}

export type ChartFilterSelection = CategoricalFilterSelection | DateFilterSelection | NumericFilterSelection;

export type ActiveChartFilters = Record<string, ChartFilterSelection | undefined>;

/** Wide multi-series charts: row filters ignore this; ChartRenderer uses it to show/hide series. */
export const CHART_SERIES_VISIBILITY_FILTER_KEY = "__seriesKeys";

/** Millisecond timestamps plausible for real dates; below this, numbers are measures (sales, etc.). */
const MIN_MS_FOR_DATE_LIKE_NUMBER = 1e11;

/** Which wide-series columns to render; empty filter means all `specSeriesKeys`. */
export function visibleSeriesKeysFromFilters(
  specSeriesKeys: string[] | undefined,
  effectiveFilters: ActiveChartFilters
): string[] {
  if (!specSeriesKeys?.length) return [];
  const s = effectiveFilters[CHART_SERIES_VISIBILITY_FILTER_KEY];
  if (!s || s.type !== "categorical" || !s.values?.length) return [...specSeriesKeys];
  const allowed = new Set(s.values);
  const hit = specSeriesKeys.filter((k) => allowed.has(k));
  return hit.length ? hit : [...specSeriesKeys];
}

/**
 * For series visibility, no stored selection means "all on" in the UI.
 * Other categorical filters keep prior behavior (empty = nothing selected).
 */
export function effectiveCategoricalValuesForCheckbox(
  filterKey: string,
  selection: ChartFilterSelection | undefined,
  allOptionValues: string[]
): string[] {
  if (filterKey === CHART_SERIES_VISIBILITY_FILTER_KEY) {
    if (selection?.type === "categorical" && selection.values.length > 0) {
      return selection.values;
    }
    return allOptionValues;
  }
  return selection?.type === "categorical" ? selection.values : [];
}

interface FieldAccumulator {
  total: number;
  stringCount: number;
  dateCandidateCount: number;
  distinctValues: Map<string, number>;
  dateCounts: Map<number, number>;
  numericCount: number;
  numericMin?: number;
  numericMax?: number;
}

const MAX_DISTINCT_VALUES = 200;
const DATE_SAMPLE_THRESHOLD = 0.7;
const MIN_YEAR = 1950;
const MAX_YEAR = 2100;
const MIN_TIMESTAMP_MS = new Date(MIN_YEAR, 0, 1).getTime();
const MAX_TIMESTAMP_MS = new Date(MAX_YEAR, 11, 31).getTime();
const OUTLIER_TRIM_FRACTION = 0.02;
const MIN_DATE_VARIETY = 3;
const MIN_SAMPLES_FOR_TRIM = 5;
const OUTLIER_GAP_MS = 1000 * 60 * 60 * 24 * 365; // one year

const toLabel = (key: string) => {
  if (!key) return "";
  return key
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
};

const MONTH_NAMES: { [key: string]: number } = {
  'jan': 0, 'january': 0,
  'feb': 1, 'february': 1,
  'mar': 2, 'march': 2,
  'apr': 3, 'april': 3,
  'may': 4,
  'jun': 5, 'june': 5,
  'jul': 6, 'july': 6,
  'aug': 7, 'august': 7,
  'sep': 8, 'september': 8, 'sept': 8,
  'oct': 9, 'october': 9,
  'nov': 10, 'november': 10,
  'dec': 11, 'december': 11
};

const normalizeYear = (date: Date) => {
  const year = date.getFullYear();
  if (year < MIN_YEAR || year > MAX_YEAR) {
    return undefined;
  }
  return date;
};

const parseFlexibleDate = (dateStr: string): Date | null => {
  if (!dateStr) return null;
  
  const str = String(dateStr).trim();
  if (!str) return null;
  
  // Try month-year formats: "Jan-24", "January 2024", "Jan/24", "Jan 2024", "Jan24", "Apr-22"
  const monthYearMatch = str.match(/^([A-Za-z]{3,})[-\s/]?(\d{2,4})$/i);
  if (monthYearMatch) {
    const monthName = monthYearMatch[1].toLowerCase();
    const month = MONTH_NAMES[monthName];
    if (month !== undefined) {
      let year = parseInt(monthYearMatch[2], 10);
      if (year < 100) {
        // Common convention: 00-30 = 2000-2030, 31-99 = 1931-1999
        year = year <= 30 ? 2000 + year : 1900 + year;
      }
      if (year >= 1900 && year <= 2100) {
        return new Date(year, month, 1);
      }
    }
  }
  
  // Try standard date formats
  const parsed = new Date(str);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed;
  }
  
  return null;
};

const isValidDateString = (value: string) => {
  if (!value || typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length < 4) return false;
  const parsed = parseFlexibleDate(trimmed);
  if (!parsed) return false;
  const year = parsed.getFullYear();
  return year >= MIN_YEAR && year <= MAX_YEAR;
};

const normalizeDateValue = (value: unknown) => {
  if (!value) return undefined;

  if (value instanceof Date) {
    return normalizeYear(value);
  }

  if (typeof value === "number") {
    if (value === 0 || Math.abs(value) < 1000) return undefined;

    let timestamp = value;
    if (value >= MIN_TIMESTAMP_MS && value <= MAX_TIMESTAMP_MS) {
      timestamp = value;
    } else if (value >= MIN_TIMESTAMP_MS / 1000 && value <= MAX_TIMESTAMP_MS / 1000) {
      timestamp = value * 1000;
    } else {
      return undefined;
    }

    const fromNumber = new Date(timestamp);
    if (Number.isNaN(fromNumber.getTime())) return undefined;
    return normalizeYear(fromNumber);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length < 4) return undefined;
    const parsed = parseFlexibleDate(trimmed);
    if (!parsed) return undefined;
    return normalizeYear(parsed);
  }

  return undefined;
};

const formatDate = (value: Date) => format(value, "yyyy-MM-dd");

type DeriveOptions = {
  excludeKeys?: string[];
  chartX?: string;
  chartY?: string;
  forceCategoricalKeys?: string[];
  forceNumericKeys?: string[];
  forceDateKeys?: string[];
};

export const deriveChartFilterDefinitions = (
  data: Record<string, unknown>[],
  options: DeriveOptions = {}
): ChartFilterDefinition[] => {
  if (!data || data.length === 0) return [];

  const exclude = new Set(options.excludeKeys ?? []);
  if (options.chartX) exclude.add(options.chartX);
  if (options.chartY) exclude.add(options.chartY);
  const forceCategorical = new Set(options.forceCategoricalKeys ?? []);
  const forceNumeric = new Set(options.forceNumericKeys ?? []);
  const forceDate = new Set(options.forceDateKeys ?? []);

  const fieldKeys = new Set<string>();
  data.forEach((row) => {
    Object.keys(row ?? {}).forEach((key) => fieldKeys.add(key));
  });

  const accumulators = new Map<string, FieldAccumulator>();

  data.forEach((row) => {
    if (!row) return;
    fieldKeys.forEach((key) => {
      if (exclude.has(key)) return;
      const value = (row as Record<string, unknown>)[key];
      if (value === null || value === undefined || value === "") return;

      let acc = accumulators.get(key);
      if (!acc) {
        acc = {
          total: 0,
          stringCount: 0,
          dateCandidateCount: 0,
          distinctValues: new Map<string, number>(),
          dateCounts: new Map<number, number>(),
          numericCount: 0,
        };
        accumulators.set(key, acc);
      }

      acc.total += 1;

      if (typeof value === "string") {
        acc.stringCount += 1;
        const trimmed = value.trim();
        if (trimmed) {
          const count = acc.distinctValues.get(trimmed) ?? 0;
          acc.distinctValues.set(trimmed, count + 1);
          if (isValidDateString(trimmed) || forceDate.has(key)) {
            const parsed = normalizeDateValue(trimmed);
            if (parsed) {
              acc.dateCandidateCount += 1;
              const timestamp = parsed.getTime();
              acc.dateCounts.set(timestamp, (acc.dateCounts.get(timestamp) ?? 0) + 1);
            }
          }

          const numericCandidate = Number(trimmed);
          if (
            (!Number.isNaN(numericCandidate) && Number.isFinite(numericCandidate)) ||
            forceNumeric.has(key)
          ) {
            acc.numericCount += 1;
            acc.numericMin =
              acc.numericMin === undefined
                ? numericCandidate
                : Math.min(acc.numericMin, numericCandidate);
            acc.numericMax =
              acc.numericMax === undefined
                ? numericCandidate
                : Math.max(acc.numericMax, numericCandidate);
          }
        }
      } else if (value instanceof Date) {
        const parsed = normalizeDateValue(value);
        if (parsed) {
          acc.dateCandidateCount += 1;
          const timestamp = parsed.getTime();
          acc.dateCounts.set(timestamp, (acc.dateCounts.get(timestamp) ?? 0) + 1);
        }
      } else if (typeof value === "number") {
        const parsed =
          Math.abs(value) >= MIN_MS_FOR_DATE_LIKE_NUMBER
            ? normalizeDateValue(value)
            : undefined;
        if (Number.isFinite(value)) {
          acc.numericCount += 1;
          acc.numericMin = acc.numericMin === undefined ? value : Math.min(acc.numericMin, value);
          acc.numericMax = acc.numericMax === undefined ? value : Math.max(acc.numericMax, value);
        }
        if (parsed) {
          acc.dateCandidateCount += 1;
          const timestamp = parsed.getTime();
          acc.dateCounts.set(timestamp, (acc.dateCounts.get(timestamp) ?? 0) + 1);
        }
      }
    });
  });

  const definitions: ChartFilterDefinition[] = [];

  accumulators.forEach((acc, key) => {
    if (acc.total === 0) return;

    if (forceNumeric.has(key)) {
      if (
        acc.numericCount >= 1 &&
        acc.numericMin !== undefined &&
        acc.numericMax !== undefined
      ) {
        definitions.push({
          key,
          label: toLabel(key),
          type: "numeric",
          min: acc.numericMin,
          max: acc.numericMax,
        });
      }
      return;
    }

    const dateRatio = acc.dateCandidateCount / acc.total;
    
    // Get actual min/max dates from the dataset (not trimmed)
    const dateTimestamps = Array.from(acc.dateCounts.keys());
    const actualMinTimestamp = dateTimestamps.length > 0 ? Math.min(...dateTimestamps) : undefined;
    const actualMaxTimestamp = dateTimestamps.length > 0 ? Math.max(...dateTimestamps) : undefined;

    // If this is a forced date key, always create a date filter if we have valid dates
    if (forceDate.has(key)) {
      if (actualMinTimestamp !== undefined && actualMaxTimestamp !== undefined) {
        definitions.push({
          key,
          label: toLabel(key),
          type: "date",
          min: formatDate(new Date(actualMinTimestamp)),
          max: formatDate(new Date(actualMaxTimestamp)),
        });
        return;
      }
    }

    // Otherwise, use the normal date detection logic
    if (
      dateRatio >= DATE_SAMPLE_THRESHOLD &&
      actualMinTimestamp !== undefined &&
      actualMaxTimestamp !== undefined &&
      actualMinTimestamp !== actualMaxTimestamp &&
      acc.dateCounts.size >= MIN_DATE_VARIETY
    ) {
      definitions.push({
        key,
        label: toLabel(key),
        type: "date",
        min: formatDate(new Date(actualMinTimestamp)),
        max: formatDate(new Date(actualMaxTimestamp)),
      });
      return;
    }

    if (
      acc.numericCount >= 2 &&
      acc.numericMin !== undefined &&
      acc.numericMax !== undefined &&
      (forceNumeric.has(key) || acc.numericMin !== acc.numericMax)
    ) {
      definitions.push({
        key,
        label: toLabel(key),
        type: "numeric",
        min: acc.numericMin,
        max: acc.numericMax,
      });
    }

    if (acc.stringCount === 0) return;
    if (acc.distinctValues.size === 0 || acc.distinctValues.size > MAX_DISTINCT_VALUES) return;
    if (!forceCategorical.has(key) && dateRatio > 0.35 && dateRatio < DATE_SAMPLE_THRESHOLD) return;

    const optionsList = Array.from(acc.distinctValues.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([value, count]) => ({
        value,
        label: value,
        count,
      }));

    if (optionsList.length === 0) return;
    if (!forceCategorical.has(key)) {
      const allLookLikeDates = optionsList.every((opt) => isValidDateString(opt.value));
      if (allLookLikeDates && optionsList.length > 5) return;
    }

    definitions.push({
      key,
      label: toLabel(key),
      type: "categorical",
      options: optionsList,
    });
  });

  return definitions.sort((a, b) => a.label.localeCompare(b.label));
};

export const applyChartFilters = <T extends Record<string, unknown>>(
  data: T[],
  filters: ActiveChartFilters
): T[] => {
  if (!data || data.length === 0) return data;
  if (!filters || Object.keys(filters).length === 0) return data;

  return data.filter((row) => {
    return Object.entries(filters).every(([key, selection]) => {
      if (!selection) return true;
      if (key === CHART_SERIES_VISIBILITY_FILTER_KEY) return true;
      const value = row[key];

      if (selection.type === "categorical") {
        if (!selection.values || selection.values.length === 0) return true;
        const stringValue =
          typeof value === "string"
            ? value
            : value === null || value === undefined
              ? ""
              : String(value);
        return selection.values.includes(stringValue);
      }

      if (selection.type === "numeric") {
        if (selection.min === undefined && selection.max === undefined) return true;
        if (typeof value !== "number" || Number.isNaN(value)) return false;
        if (selection.min !== undefined && value < selection.min) return false;
        if (selection.max !== undefined && value > selection.max) return false;
        return true;
      }

      if (selection.type === "date") {
        if (!selection.start && !selection.end) return true;
        const parsed = normalizeDateValue(value);
        if (!parsed) return false;

        // Normalize dates to start of day for consistent comparison
        const normalizeToStartOfDay = (d: Date) => {
          const normalized = new Date(d);
          normalized.setHours(0, 0, 0, 0);
          return normalized;
        };

        const parsedNormalized = normalizeToStartOfDay(parsed);

        if (selection.start) {
          const startDate = normalizeDateValue(selection.start);
          if (!startDate) return false;
          const startNormalized = normalizeToStartOfDay(startDate);
          // Use <= to ensure inclusive lower bound (dates equal to start are included)
          if (parsedNormalized < startNormalized) return false;
        }

        if (selection.end) {
          const endDate = normalizeDateValue(selection.end);
          if (!endDate) return false;
          // For end date, set to end of day to ensure inclusive upper bound
          const endNormalized = new Date(endDate);
          endNormalized.setHours(23, 59, 59, 999);
          // Use <= to ensure inclusive upper bound (dates equal to or before end are included)
          if (parsedNormalized > endNormalized) return false;
        }

        return true;
      }

      return true;
    });
  });
};

export const hasActiveFilters = (filters: ActiveChartFilters | undefined) => {
  if (!filters) return false;
  return Object.values(filters).some((selection) => {
    if (!selection) return false;
    if (selection.type === "categorical") {
      return Array.isArray(selection.values) && selection.values.length > 0;
    }
    if (selection.type === "date") {
      return Boolean(selection.start || selection.end);
    }
    if (selection.type === "numeric") {
      return selection.min !== undefined || selection.max !== undefined;
    }
    return false;
  });
};

export const summarizeChartFilters = (
  filters: ActiveChartFilters,
  definitions?: ChartFilterDefinition[]
): string[] => {
  if (!filters) return [];
  const summary: string[] = [];

  Object.entries(filters).forEach(([key, selection]) => {
    if (!selection) return;

    const def = definitions?.find((candidate) => candidate.key === key);
    const label = def ? def.label : toLabel(key);

    if (selection.type === "categorical") {
      if (!selection.values || selection.values.length === 0) return;
      const values = selection.values.join(", ");
      summary.push(`${label}: ${values}`);
      return;
    }

    if (selection.type === "date") {
      const parts: string[] = [];
      if (selection.start) {
        parts.push(`from ${selection.start}`);
      }
      if (selection.end) {
        parts.push(`to ${selection.end}`);
      }
      if (parts.length > 0) {
        summary.push(`${label}: ${parts.join(" ")}`);
      }
    }

    if (selection.type === "numeric") {
      const parts: string[] = [];
      if (selection.min !== undefined) {
        parts.push(`≥ ${selection.min}`);
      }
      if (selection.max !== undefined) {
        parts.push(`≤ ${selection.max}`);
      }
      if (parts.length > 0) {
        summary.push(`${label}: ${parts.join(" & ")}`);
      }
    }
  });

  return summary;
};

