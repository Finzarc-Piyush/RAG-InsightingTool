/**
 * Infer how “dense” a time series is from consecutive calendar points, then format axis labels.
 * Thresholds: median gap &lt; 14d → daily/weekly display; 14–120d → month/quarter; ≥120d → yearly.
 * Bi-weekly (~14d) falls on the month/quarter branch by using &lt; 14 for the first bucket.
 */

import { MONTH_SHORT_NAMES as MONTH_SHORT } from './dateUtils.js';

export type TemporalDisplayGrain = 'dayOrWeek' | 'monthOrQuarter' | 'year';

/** Median of positive finite numbers; returns undefined if empty. */
function medianPositive(values: number[]): number | undefined {
  const v = values.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (v.length === 0) return undefined;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 === 1 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}

/**
 * Unique dates sorted ascending; uses calendar day in local time for dedup key.
 */
function uniqueSortedDates(dates: Date[]): Date[] {
  const byDay = new Map<string, Date>();
  for (const d of dates) {
    if (!d || isNaN(d.getTime())) continue;
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (!byDay.has(key)) byDay.set(key, d);
  }
  return [...byDay.values()].sort((a, b) => a.getTime() - b.getTime());
}

/**
 * Infer display grain from an array of parsed dates (e.g. one chart’s X values).
 */
export function inferTemporalGrainFromDates(dates: Date[]): TemporalDisplayGrain {
  const unique = uniqueSortedDates(dates);
  if (unique.length < 2) return 'dayOrWeek';

  const deltas: number[] = [];
  for (let i = 1; i < unique.length; i++) {
    const days = (unique[i]!.getTime() - unique[i - 1]!.getTime()) / 86_400_000;
    if (days > 0) deltas.push(days);
  }

  const med = medianPositive(deltas);
  if (med === undefined) return 'dayOrWeek';
  if (med < 14) return 'dayOrWeek';
  if (med < 120) return 'monthOrQuarter';
  return 'year';
}

/**
 * DISPLAY grain for a single column — name + semantic type FIRST, values only as
 * a last resort. This is what the Data Summary "Granularity" tile shows; it is a
 * display concern and deliberately NOT the chart-axis authority
 * (`temporalGrainAuthority.resolveTrendGrain`, invariant #11), which is span /
 * materialized-bucket driven and refuses to key off names.
 *
 * Precedence:
 *   1. an explicit temporal semantic type (temporal_year/month/quarter),
 *   2. the column NAME (a column literally named "Month"/"Year"/"Quarter"),
 *   3. the value-derived median-gap heuristic — ONLY with ≥2 distinct days,
 *   4. otherwise `null` — a single-point / unknown column renders "—" instead of
 *      the misleading `dayOrWeek` default that made a one-date "Month" read
 *      "Daily / weekly".
 */
export function displayGrainForColumn(
  name: string,
  semanticType?: string | null,
  dates?: Date[],
): TemporalDisplayGrain | null {
  if (semanticType === 'temporal_year') return 'year';
  if (semanticType === 'temporal_month' || semanticType === 'temporal_quarter') {
    return 'monthOrQuarter';
  }

  const n = name.trim().toLowerCase().replace(/[_-]+/g, ' ');
  if (/(^| )(year|yr)( |$)/.test(n) || n === 'fy') return 'year';
  if (/(^| )(quarter|qtr|q[1-4])( |$)/.test(n)) return 'monthOrQuarter';
  if (/(^| )(month|mth|mon)( |$)/.test(n)) return 'monthOrQuarter';
  if (/(^| )(week|wk)( |$)/.test(n)) return 'dayOrWeek';

  if (dates && dates.length > 0) {
    const distinct = uniqueSortedDates(dates);
    if (distinct.length >= 2) return inferTemporalGrainFromDates(dates);
  }
  return null;
}

/** dd/MM/yy, MMM-yy, or yyyy for charts and tables. */
export function formatDateForChartAxis(date: Date, grain: TemporalDisplayGrain): string {
  const y = date.getFullYear();
  const m = date.getMonth();
  const d = date.getDate();

  if (grain === 'year') {
    return String(y);
  }
  if (grain === 'monthOrQuarter') {
    const yy = y % 100;
    return `${MONTH_SHORT[m]}-${String(yy).padStart(2, '0')}`;
  }
  return `${String(d).padStart(2, '0')}/${String(m + 1).padStart(2, '0')}/${String(y).slice(-2)}`;
}
