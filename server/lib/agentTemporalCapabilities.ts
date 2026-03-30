/**
 * Single source of truth: what temporal bucketing the analytical stack supports today.
 * Use this for docs, planner hints, and tests — not for user-facing product copy.
 */

/** Periods accepted by execute_query_plan / ParsedQuery / applyAggregations date bucketing. */
export const SUPPORTED_DATE_AGGREGATION_PERIODS = [
  "day",
  "week",
  "half_year",
  "month",
  "monthOnly",
  "quarter",
  "year",
] as const;

export type SupportedDateAggregationPeriod =
  (typeof SUPPORTED_DATE_AGGREGATION_PERIODS)[number];

/**
 * Gaps vs common user language (not yet in SUPPORTED_DATE_AGGREGATION_PERIODS):
 * - fiscal year / FY (needs anchor month + optional week rules)
 * - rolling N-day / N-week windows
 * - arbitrary multi-year bins (e.g. "every 3 years") — use derive_dimension_bucket or readonly SQL on a year column
 * - hour / minute grain
 *
 * Priority extensions if product asks: fiscal_year, rolling_week, custom_month_step (N-month buckets).
 */
export const TEMPORAL_CAPABILITY_GAPS = [
  "fiscal_year_with_anchor",
  "rolling_windows",
  "arbitrary_year_stride",
  "sub_day_grain",
] as const;
