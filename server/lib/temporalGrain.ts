/**
 * Infer how “dense” a time series is from consecutive calendar points, then format axis labels.
 * Thresholds: median gap &lt; 14d → daily/weekly display; 14–120d → month/quarter; ≥120d → yearly.
 * Bi-weekly (~14d) falls on the month/quarter branch by using &lt; 14 for the first bucket.
 */

export type TemporalDisplayGrain = 'dayOrWeek' | 'monthOrQuarter' | 'year';

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

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
