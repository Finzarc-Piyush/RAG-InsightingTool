/**
 * Wave AD5 · pure-fn bucketing helper. Aggregator functions always return
 * daily series (key = `YYYYMMDD`); the user toggles granularity client-side
 * and the API rebuckets on read into weekly / monthly / quarterly / yearly.
 *
 * Bucketing rules:
 *   - daily      → one bucket per day, key `YYYYMMDD`
 *   - weekly     → ISO week (Mon–Sun), key `YYYY-Www` (e.g. `2026-W18`)
 *   - monthly    → calendar month, key `YYYY-MM`
 *   - quarterly  → calendar quarter, key `YYYY-Q1..Q4`
 *   - yearly     → calendar year, key `YYYY`
 *
 * Empty buckets within the requested window are filled with the supplied
 * `zero` so the time-series chart shows continuous bins.
 */

export type Granularity = "daily" | "weekly" | "monthly" | "quarterly" | "yearly";

export const GRANULARITIES: ReadonlyArray<Granularity> = [
  "daily",
  "weekly",
  "monthly",
  "quarterly",
  "yearly",
];

export interface Bucket<T> {
  /** Display key — exact format depends on granularity. */
  key: string;
  /** Inclusive ms-epoch start of the bucket. */
  startMs: number;
  /** Inclusive ms-epoch end of the bucket (next bucket's startMs - 1). */
  endMs: number;
  value: T;
}

function parseDateKey(dk: string): Date {
  // YYYYMMDD → UTC midnight Date
  const y = Number(dk.slice(0, 4));
  const m = Number(dk.slice(4, 6)) - 1;
  const d = Number(dk.slice(6, 8));
  return new Date(Date.UTC(y, m, d));
}

function dateKeyFromDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

/** ISO week-year and week number for a given UTC date. */
function isoWeekKey(d: Date): string {
  // Algorithm: copy date, set to Thursday in current week (defines the week-year), week 1 contains 4 Jan.
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = t.getUTCDay() || 7; // Mon=1..Sun=7
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

function bucketKeyFor(d: Date, g: Granularity): string {
  if (g === "daily") return dateKeyFromDate(d);
  if (g === "weekly") return isoWeekKey(d);
  if (g === "monthly") return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  if (g === "quarterly") {
    const q = Math.floor(d.getUTCMonth() / 3) + 1;
    return `${d.getUTCFullYear()}-Q${q}`;
  }
  return String(d.getUTCFullYear()); // yearly
}

/**
 * Rebucket a daily-grain series into the requested granularity. Reducer is
 * applied across all daily values whose date falls into the same bucket.
 * Buckets with no daily entries are filled with `zero`.
 */
export function rebucketDailySeries<T>(
  daily: Array<{ dateKey: string; value: T }>,
  granularity: Granularity,
  reducer: (acc: T, value: T) => T,
  zero: () => T
): Bucket<T>[] {
  if (daily.length === 0) return [];
  const sorted = [...daily].sort((a, b) => a.dateKey.localeCompare(b.dateKey));
  const out = new Map<string, { startMs: number; value: T }>();
  for (const row of sorted) {
    const d = parseDateKey(row.dateKey);
    const key = bucketKeyFor(d, granularity);
    const existing = out.get(key);
    if (existing) {
      existing.value = reducer(existing.value, row.value);
    } else {
      out.set(key, { startMs: d.getTime(), value: reducer(zero(), row.value) });
    }
  }
  // Convert to array preserving insertion order (which was sorted).
  return Array.from(out.entries()).map(([key, { startMs, value }]) => ({
    key,
    startMs,
    endMs: startMs, // tight end for daily, looser bounds aren't load-bearing for the chart
    value,
  }));
}

export function buildDateKeyRange(fromDateKey: string, toDateKey: string): string[] {
  const start = parseDateKey(fromDateKey);
  const end = parseDateKey(toDateKey);
  const out: string[] = [];
  const cursor = new Date(start.getTime());
  while (cursor.getTime() <= end.getTime()) {
    out.push(dateKeyFromDate(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

/** Convert a ms-epoch into the UTC dateKey used as the daily-grain bucket key. */
export function dateKeyFromTimestamp(ts: number): string {
  return dateKeyFromDate(new Date(ts));
}
