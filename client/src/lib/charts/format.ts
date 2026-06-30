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
import {
  formatTemporalPeriodKeyForDisplay,
  isCanonicalPeriodKey,
} from "@/lib/temporalPeriodDisplay";
import { formatHoursAsDuration } from "@/lib/duration";

const CURRENCY_RE =
  /\b(revenue|sales|price|cost|margin|profit|spend|amount|cash|usd|inr|gbp|eur)\b/i;
const PERCENT_RE = /\b(rate|percent|pct|share|ratio|conversion|growth)\b/i;
// DUR1 · elapsed-time measures (e.g. "Working Hrs") are stored as decimal
// hours; format axis/tooltip values as durations ("3h 32m"). Name-based,
// symmetric with the currency/percent heuristics above.
const DURATION_RE =
  /\b(hrs|hours|duration|elapsed|worked|working|tat|turnaround)\b/i;
// NOTE: the standalone token `day` is deliberately EXCLUDED. A column literally
// named "Day" in these datasets is an ordinal counter (1..N), not a calendar
// date — inferring "date" sent its numeric value through `new Date(15)` →
// "1 Jan 1970". Real date columns are named "Date"/"…_at"/"…Date…" and still
// match. ("monday"/"weekday" never matched anyway — no `\bday\b` boundary.)
const DATE_RE = /\b(date|month|quarter|year|week|time|timestamp|period)\b/i;
/** SQL audit-column convention: `created_at`, `updated_on`, etc. */
const DATE_SUFFIX_RE = /(_at|_on)$/i;
/**
 * Smallest numeric value treated as a real epoch-millis timestamp on a
 * date-named axis (1e8 ms ≈ 1970-01-02 — i.e. essentially the epoch). Anything
 * smaller is an ordinal/counter (day-of-month, week #, month #, year) that must
 * render as a plain number, never a 1-Jan-1970 date. Deliberately conservative:
 * real business dates are ≥ ~1e12 ms and ordinals are well below 1e8, so the
 * wide gap between never traps a legitimate value.
 */
const DATE_EPOCH_MS_MIN = 1e8;

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

/**
 * True when a column name looks like a calendar date/time column.
 *
 * Single source of truth for date-by-name detection — `inferFormatHint` (this
 * file) and the v1→v2 x-axis type inference (`v1ToV2.ts`) both call this so the
 * two can never drift. Note the standalone token `day` is excluded on purpose
 * (see `DATE_RE`): a "Day" ordinal counter must format/scale as a number, never
 * a date.
 */
export function isDateFieldName(name: string | undefined): boolean {
  if (!name) return false;
  const normalized = normalizeFieldName(name);
  return DATE_SUFFIX_RE.test(name) || DATE_RE.test(normalized);
}

/** Detect the implicit format from a column name. */
export function inferFormatHint(
  fieldName: string | undefined,
): "currency" | "percent" | "date" | "duration" | "kmb" | "raw" {
  if (!fieldName) return "raw";
  if (isDateFieldName(fieldName)) return "date";
  const normalized = normalizeFieldName(fieldName);
  if (CURRENCY_RE.test(normalized)) return "currency";
  if (PERCENT_RE.test(normalized)) return "percent";
  if (DURATION_RE.test(normalized)) return "duration";
  return "kmb";
}

/**
 * Format a number in the INDIAN numbering system (Cr / Lac / K).
 *   1234          → "1.23 K"
 *   1_234_000     → "12.3 Lac"
 *   1_049_389_992 → "104.9 Cr"
 *   123           → "123"
 *
 * INDIAN TIER LADDER — keep in sync with the three mirrored ladders:
 *   server/lib/formatCompactNumber.ts, client/src/lib/chartNumberFormat.ts,
 *   client/src/lib/charts/chartFilterHelpers.ts (formatAxisLabelFieldBlind).
 * See docs/conventions/indian-number-format.md.
 *
 * Magnitude decimals follow the scaled value (1 dp for ≥10, 2 dp below), so
 * 104.94 → "104.9 Cr" and 4.81 → "4.81 Lac". A SPACE precedes the suffix.
 * `precision` controls decimals only on the sub-1000 plain path. Negatives
 * keep their sign.
 */
export function formatKMB(value: number, precision = 1): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs < 1_000) {
    return sign + abs.toFixed(abs % 1 === 0 ? 0 : precision);
  }
  const tiers: Array<[number, string]> = [
    [1e7, "Cr"],
    [1e5, "Lac"],
    [1e3, "K"],
  ];
  for (const [factor, suffix] of tiers) {
    if (abs >= factor) {
      const v = abs / factor;
      // 1 dp for scaled ≥ 10, 2 dp below; then drop trailing zeros.
      const fixed = v.toFixed(v >= 10 ? 1 : 2);
      const trimmed = fixed
        .replace(/\.0+$/, "")
        .replace(/(\.\d*?)0+$/, "$1");
      return `${sign}${trimmed} ${suffix}`;
    }
  }
  return sign + abs.toFixed(precision);
}

/** Currency formatter: prepends the symbol (₹ by default — data is INR), then
 *  Indian-formats the magnitude. */
export function formatCurrency(
  value: number,
  symbol = "₹",
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
  // Canonical period keys ("2023-Q1", "2023-01", …) are categorical x-axis values
  // — render the human label (quarters stay quarters) and never run them through
  // numeric / smart-date formatting. Numeric measures never match this shape.
  if (isCanonicalPeriodKey(value)) return formatTemporalPeriodKeyForDisplay(value);
  const hint = opts.format ?? inferFormatHint(field);
  const num = typeof value === "number" ? value : Number(value);

  if (hint === "currency") {
    if (Number.isFinite(num)) {
      const sym =
        opts.currencySymbol ??
        (field
          ? CURRENCY_SYMBOLS_BY_FIELD[field.toLowerCase().match(/\b\w+\b/g)?.[0] ?? ""] ??
            "₹"
          : "₹");
      return formatCurrency(num, sym, opts.precision ?? 1);
    }
    return String(value);
  }
  if (hint === "percent") {
    return Number.isFinite(num)
      ? formatPercent(num, opts.precision ?? 1)
      : String(value);
  }
  if (hint === "duration") {
    return Number.isFinite(num) ? formatHoursAsDuration(num) : String(value);
  }
  if (hint === "date") {
    // Magnitude guard. A date-NAMED axis ("Week", "Month", "Year", a leftover
    // "Day") whose VALUE is a small number is an ordinal/counter (week 12,
    // month 3, year 2025, avg-day 15), NOT a calendar instant — running it
    // through `new Date(n)` yields "1 Jan 1970". Real calendar values arrive as
    // ISO strings (num is NaN here) or full epoch-millis (≥ DATE_EPOCH_MS_MIN),
    // both of which still format as dates. Render the ordinal as a plain number.
    if (typeof value === "number" && Number.isFinite(value) && Math.abs(value) < DATE_EPOCH_MS_MIN) {
      return Number.isInteger(value) ? String(value) : formatKMB(value, opts.precision ?? 1);
    }
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
