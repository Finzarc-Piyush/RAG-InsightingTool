/**
 * Smart formatters for chart axes, tooltips, and legends. WC1.2.
 *
 * Centralized so every renderer (visx + echarts) and every chrome
 * component (<ChartTooltip>, <ChartLegend>) renders numbers and dates
 * the same way. Replicates the behaviors documented in the W0 contract:
 *   - K / M / B / T suffixes on large magnitudes
 *   - Currency detection by column name
 *   - Percent detection by column name
 *   - Smart date formats based on time range
 */

import { format as formatDate } from "date-fns";

const CURRENCY_RE =
  /\b(revenue|sales|price|cost|margin|profit|spend|amount|cash|usd|inr|gbp|eur)\b/i;
const PERCENT_RE = /\b(rate|percent|pct|share|ratio|conversion|growth)\b/i;
const DATE_RE = /\b(date|day|month|quarter|year|week|time|timestamp|period)\b/i;
/** SQL audit-column convention: `created_at`, `updated_on`, etc. */
const DATE_SUFFIX_RE = /(_at|_on)$/i;

const CURRENCY_SYMBOLS_BY_FIELD: Record<string, string> = {
  usd: "$",
  inr: "₹",
  gbp: "£",
  eur: "€",
  jpy: "¥",
};

/**
 * Normalize a field name so word-boundary regexes catch tokens regardless
 * of casing convention: camelCase → camel case, snake_case → snake case,
 * kebab-case → kebab case.
 */
function normalizeFieldName(s: string): string {
  return s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]/g, " ")
    .toLowerCase();
}

/** Detect the implicit format from a column name. */
export function inferFormatHint(
  fieldName: string | undefined,
): "currency" | "percent" | "date" | "kmb" | "raw" {
  if (!fieldName) return "raw";
  const normalized = normalizeFieldName(fieldName);
  if (DATE_SUFFIX_RE.test(fieldName) || DATE_RE.test(normalized)) return "date";
  if (CURRENCY_RE.test(normalized)) return "currency";
  if (PERCENT_RE.test(normalized)) return "percent";
  return "kmb";
}

/**
 * Format a number with K/M/B/T suffixes.
 *   1234         → "1.2K"
 *   1_234_000    → "1.2M"
 *   1_234_000_000 → "1.2B"
 *   123          → "123"
 *
 * `precision` controls decimals after the suffix (default 1).
 * Negatives keep their sign.
 */
export function formatKMB(value: number, precision = 1): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs < 1_000) {
    return sign + abs.toFixed(abs % 1 === 0 ? 0 : precision);
  }
  const tiers: Array<[number, string]> = [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [factor, suffix] of tiers) {
    if (abs >= factor) {
      const v = abs / factor;
      // Drop trailing .0 for integers.
      const fixed = v.toFixed(precision);
      const trimmed = fixed.endsWith(".0")
        ? fixed.slice(0, -2)
        : fixed.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
      return `${sign}${trimmed}${suffix}`;
    }
  }
  return sign + abs.toFixed(precision);
}

/** Currency formatter: prepends the symbol, then K/M/B-formats the magnitude. */
export function formatCurrency(
  value: number,
  symbol = "$",
  precision = 1,
): string {
  if (!Number.isFinite(value)) return "—";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  return `${sign}${symbol}${formatKMB(abs, precision).replace(/^-/, "")}`;
}

/** Percent: 0.123 → "12.3%". Detects whether the value is already
 *  in percentage units (>1) and skips the ×100 in that case. */
export function formatPercent(value: number, precision = 1): string {
  if (!Number.isFinite(value)) return "—";
  // Heuristic: if abs > 1 and looks like a whole percent (>= 1%),
  // assume the data is already in percent units.
  const inPercent = Math.abs(value) > 1 && Math.abs(value) <= 100;
  const v = inPercent ? value : value * 100;
  return `${v.toFixed(precision)}%`;
}

/** Compact date formatter; chooses format based on time range. */
export function formatDateSmart(
  value: number | string | Date,
  rangeMs?: number,
): string {
  const d =
    value instanceof Date ? value : new Date(value as string | number);
  if (Number.isNaN(d.getTime())) return String(value);
  // < 1 day → time of day
  if (rangeMs !== undefined && rangeMs < 24 * 60 * 60 * 1000) {
    return formatDate(d, "HH:mm");
  }
  // < 60 days → day + month
  if (rangeMs !== undefined && rangeMs < 60 * 24 * 60 * 60 * 1000) {
    return formatDate(d, "d MMM");
  }
  // < 5 years → month + year
  if (rangeMs !== undefined && rangeMs < 5 * 365 * 24 * 60 * 60 * 1000) {
    return formatDate(d, "MMM ''yy");
  }
  // long ranges → year only
  if (rangeMs !== undefined) {
    return formatDate(d, "yyyy");
  }
  // fallback when no range provided
  return formatDate(d, "d MMM yyyy");
}

export interface FormatterOptions {
  /** Override the inferred format. */
  format?:
    | "currency"
    | "percent"
    | "date"
    | "kmb"
    | "raw"
    | "compact"
    | string;
  /** Currency symbol when format='currency'. */
  currencySymbol?: string;
  /** Decimal precision. */
  precision?: number;
  /** Date range hint (ms) for smart date format. */
  dateRangeMs?: number;
}

/** Universal formatter — renderers call this with a value + options. */
export function formatChartValue(
  value: unknown,
  field: string | undefined,
  opts: FormatterOptions = {},
): string {
  if (value === null || value === undefined || value === "") return "—";
  const hint = opts.format ?? inferFormatHint(field);
  const num = typeof value === "number" ? value : Number(value);

  if (hint === "currency") {
    if (Number.isFinite(num)) {
      const sym =
        opts.currencySymbol ??
        (field
          ? CURRENCY_SYMBOLS_BY_FIELD[field.toLowerCase().match(/\b\w+\b/g)?.[0] ?? ""] ??
            "$"
          : "$");
      return formatCurrency(num, sym, opts.precision ?? 1);
    }
    return String(value);
  }
  if (hint === "percent") {
    return Number.isFinite(num)
      ? formatPercent(num, opts.precision ?? 1)
      : String(value);
  }
  if (hint === "date") {
    return formatDateSmart(value as string | number | Date, opts.dateRangeMs);
  }
  if (hint === "kmb" || hint === "compact") {
    return Number.isFinite(num)
      ? formatKMB(num, opts.precision ?? 1)
      : String(value);
  }
  // raw / unknown
  if (Number.isFinite(num)) return String(num);
  return String(value);
}

/** Convenience: build an axis tick formatter bound to a column. */
export function makeAxisTickFormatter(
  field: string | undefined,
  opts: FormatterOptions = {},
): (v: unknown) => string {
  return (v) => formatChartValue(v, field, opts);
}
