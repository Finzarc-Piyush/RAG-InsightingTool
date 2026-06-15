// WGR4 · Shared, pure temporal-coverage scanner for growth/trend routing.
//
// Buckets the distinct calendar periods present in a date / PeriodIso column
// so callers can decide:
//   • whether calendar period-over-period growth is even possible
//     (hasMultiPeriodCalendarCoverage) — false for a single contiguous span
//     such as one month of daily rows, which must route to the sequential
//     "trend" mode instead of YoY/QoQ/MoM/WoW; and
//   • whether there is enough history for seasonality
//     (hasSeasonalityCoverage) — the threshold the growth_analysis skill used
//     to gate its detect_seasonality step.
//
// Pure and cycle-safe: lives in server/lib/growth/ alongside periodShift.ts
// (no tool-layer imports), so both the growth_analysis skill and the
// compute_growth tool can import it without an import cycle. Recognises the
// same label shapes as the scanners it replaces: YYYY, YYYY-MM, YYYY-Q[1-4],
// YYYY-Wnn, and raw date strings parsed down to YYYY-MM.

export interface CalendarCoverage {
  distinctYears: number;
  maxMonthsInOneYear: number;
  maxQuartersInOneYear: number;
  maxWeeksInOneYear: number;
}

/**
 * Scan a period/date column and bucket distinct calendar periods. Capped at
 * `scanCap` rows so it never dominates plan time on large in-memory frames.
 */
export function scanCalendarCoverage(
  rows: ReadonlyArray<Record<string, unknown>>,
  periodCol: string,
  scanCap = 5000
): CalendarCoverage {
  const years = new Set<string>();
  const monthsByYear: Record<string, Set<string>> = {};
  const quartersByYear: Record<string, Set<string>> = {};
  const weeksByYear: Record<string, Set<string>> = {};

  const limit = Math.min(rows.length, scanCap);
  for (let i = 0; i < limit; i++) {
    const v = rows[i]?.[periodCol];
    if (v === null || v === undefined || v === "") continue;
    const s = String(v);
    const yearMatch = s.match(/^(\d{4})/);
    if (yearMatch) years.add(yearMatch[1]!);

    if (/^\d{4}-Q[1-4]$/.test(s)) {
      const y = s.slice(0, 4);
      (quartersByYear[y] ??= new Set()).add(s);
    } else if (/^\d{4}-W\d{2}$/.test(s)) {
      const y = s.slice(0, 4);
      (weeksByYear[y] ??= new Set()).add(s);
    } else if (/^\d{4}-\d{2}$/.test(s)) {
      const y = s.slice(0, 4);
      (monthsByYear[y] ??= new Set()).add(s);
    } else {
      // Raw date (e.g. "2026-04-15", "2026-04-15T00:00:00") → bucket to YYYY-MM.
      const ymMatch = s.match(/^(\d{4})-(\d{1,2})/);
      if (ymMatch) {
        const y = ymMatch[1]!;
        (monthsByYear[y] ??= new Set()).add(`${y}-${ymMatch[2]!.padStart(2, "0")}`);
      }
    }
  }

  const maxOf = (byYear: Record<string, Set<string>>): number =>
    Math.max(0, ...Object.values(byYear).map((s) => s.size));

  return {
    distinctYears: years.size,
    maxMonthsInOneYear: maxOf(monthsByYear),
    maxQuartersInOneYear: maxOf(quartersByYear),
    maxWeeksInOneYear: maxOf(weeksByYear),
  };
}

/**
 * True iff calendar period-over-period growth is even possible — i.e. there
 * are ≥2 distinct CALENDAR periods at some coarse grain (≥2 years, OR ≥2
 * months / ≥2 quarters / ≥2 weeks within a single year). When false, the data
 * is a single contiguous span and calendar pairing yields zero pairs, so the
 * caller should use the sequential "trend" path.
 */
export function hasMultiPeriodCalendarCoverage(cov: CalendarCoverage): boolean {
  return (
    cov.distinctYears >= 2 ||
    cov.maxMonthsInOneYear >= 2 ||
    cov.maxQuartersInOneYear >= 2 ||
    cov.maxWeeksInOneYear >= 2
  );
}

/**
 * True iff there is enough history for seasonality: ≥2 distinct years AND
 * either ≥6 months or ≥4 quarters within a single year. Preserves the
 * threshold the growth_analysis skill used to gate detect_seasonality.
 */
export function hasSeasonalityCoverage(cov: CalendarCoverage): boolean {
  return (
    cov.distinctYears >= 2 &&
    (cov.maxMonthsInOneYear >= 6 || cov.maxQuartersInOneYear >= 4)
  );
}
