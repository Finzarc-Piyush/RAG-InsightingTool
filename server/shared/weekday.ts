/**
 * weekday.ts — single source of truth for weekday naming + ordering.
 *
 * Monday-first (FMCG working-week convention): Monday … Sunday. Used by:
 *   - the `day_of_week` temporal facet (dateUtils.normalizeDateToPeriod), which
 *     stores the PURE TEXT name ("Monday") — not a numeric/prefixed key — per the
 *     "categorical text, not numeric" requirement;
 *   - the chart + pivot sort authorities (chartSort.ts, pivotQueryService.ts),
 *     which order this ordered-categorical Mon→Sun via `weekdayRank` instead of
 *     alphabetically;
 *   - the off-day detector (insightGenerator/weekdayPattern.ts).
 *
 * Pure / browser-safe (the client re-exports server/shared modules), no I/O.
 */

/** Full weekday names indexed by JS `Date.getDay()` (0 = Sunday … 6 = Saturday). */
export const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** Display / sort order: Monday-first, Sunday last. */
export const WEEKDAY_ORDER = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

const WEEKDAY_RANK: Record<string, number> = {
  Monday: 1,
  Tuesday: 2,
  Wednesday: 3,
  Thursday: 4,
  Friday: 5,
  Saturday: 6,
  Sunday: 7,
};

/**
 * 1..7 (Mon..Sun) for a full weekday name, or null when the value is not one of
 * the seven names. Trimmed + exact-case match (the facet stores canonical names).
 */
export function weekdayRank(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const r = WEEKDAY_RANK[value.trim()];
  return r ?? null;
}

/** True when the value is one of the seven full weekday names. */
export function isWeekdayName(value: unknown): boolean {
  return weekdayRank(value) !== null;
}
