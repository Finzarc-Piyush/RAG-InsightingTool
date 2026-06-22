/**
 * Date utilities with flexible parsing and light heuristics.
 */

export type DatePeriod =
  | 'day'
  | 'week'
  | 'half_year'
  | 'month'
  | 'quarter'
  | 'year'
  | 'monthOnly'
  // Sub-day (Wave H2). `hour`/`minute` are absolute timeline buckets; `hour_of_day`
  // is the cyclical 0–23 bucket (zero-padded key so lexicographic sort = clock order).
  // Snake_case to stay string-identical to the facet-grain + executor period tokens.
  | 'hour'
  | 'minute'
  | 'hour_of_day';

/**
 * Per-column intraday detection (Wave H1). A date column carries sub-day detail
 * only when it has ≥2 DISTINCT non-midnight times — a constant time (e.g. every
 * row at 00:00 or a placeholder 09:00) is treated as day-grain so pure-daily data
 * is never promoted to an hour axis. Accumulated identically on every ingest path
 * (`createDataSummary`, `deriveDateRangeFromRows`) so the grain authority's input
 * is uniform (invariant L-019). Hours are read from LOCAL components to match the
 * wall-clock storage form and DuckDB `EXTRACT(hour …)`.
 */
export interface IntradayStats {
  nonMidnightDistinctHm: Set<string>;
  distinctHours: Set<number>;
}

export function newIntradayStats(): IntradayStats {
  return { nonMidnightDistinctHm: new Set(), distinctHours: new Set() };
}

export function accumulateIntraday(stats: IntradayStats, d: Date): void {
  const h = d.getHours();
  const mi = d.getMinutes();
  const s = d.getSeconds();
  stats.distinctHours.add(h);
  if (h !== 0 || mi !== 0 || s !== 0) {
    stats.nonMidnightDistinctHm.add(`${h}:${mi}`);
  }
}

export function intradayResolution(
  stats: IntradayStats
): { temporalResolution: 'day' | 'sub_day'; distinctHourCount: number } {
  return {
    temporalResolution: stats.nonMidnightDistinctHm.size >= 2 ? 'sub_day' : 'day',
    distinctHourCount: stats.distinctHours.size,
  };
}

/** ISO week: key YYYY-Www, label Www YYYY (week-year may differ from calendar year at boundaries). */
export function isoWeekKeyAndLabel(d: Date): { normalizedKey: string; displayLabel: string } {
  const t = new Date(d.getTime());
  t.setHours(0, 0, 0, 0);
  t.setDate(t.getDate() + 3 - ((t.getDay() + 6) % 7));
  const isoYear = t.getFullYear();
  const week1 = new Date(isoYear, 0, 4);
  const w =
    1 +
    Math.round(
      ((t.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7
    );
  const normalizedKey = `${isoYear}-W${String(w).padStart(2, '0')}`;
  const displayLabel = `W${w} ${isoYear}`;
  return { normalizedKey, displayLabel };
}

export interface NormalizedDate {
  original: string;
  date: Date;
  period: DatePeriod;
  normalizedKey: string;
  displayLabel: string;
}

export const MONTH_SHORT_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** First three letters of English month name → 0-based month index (MMM-YY / Month YYYY). */
const MONTH_ABBREV_TO_INDEX: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

export function sanitizeDateStringForParse(input: string): string {
  return input.trim();
}

/**
 * Build a Date from explicit Y/M/D/H/M/S components.
 *  - No tz  → LOCAL-component Date (its local clock == the typed wall clock).
 *  - tz set → absolute instant from the explicit Z/offset (deterministic).
 * Returns null when any component is out of range.
 */
function dateTimeFromComponents(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  tz: string | undefined
): Date | null {
  if (
    year < 1900 || year > 2100 ||
    month < 1 || month > 12 ||
    day < 1 || day > 31 ||
    hour > 23 || minute > 59 || second > 59
  ) {
    return null;
  }
  if (tz) {
    const iso =
      `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` +
      `T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}${tz}`;
    const d = new Date(iso);
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(year, month - 1, day, hour, minute, second);
  return d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day ? d : null;
}

/**
 * Flexible date parser for Date objects and common date strings.
 */
export function parseFlexibleDate(dateStr: string | Date): Date | null {
  if (dateStr instanceof Date && !isNaN(dateStr.getTime())) {
    return dateStr;
  }
  if (typeof dateStr !== 'string') return null;

  const str = sanitizeDateStringForParse(dateStr);
  if (!str) return null;

  if (/^\d{8}$/.test(str)) {
    const year = Number(str.slice(0, 4));
    const month = Number(str.slice(4, 6));
    const day = Number(str.slice(6, 8));
    if (
      year >= 1900 &&
      year <= 2100 &&
      month >= 1 &&
      month <= 12 &&
      day >= 1 &&
      day <= 31
    ) {
      const d = new Date(year, month - 1, day);
      if (
        d.getFullYear() === year &&
        d.getMonth() === month - 1 &&
        d.getDate() === day
      ) {
        return d;
      }
    }
    return null;
  }

  if (/^\d+$/.test(str)) return null;

  // Reject ambiguous month-prefix values (e.g., "1 something", "12abc")
  // unless they match explicit date formats we intentionally accept.
  const startsWithMonthPrefix = /^(?:[1-9]|1[0-2])(?:\D|$)/.test(str);

  // Datetime with an explicit time component (space- OR T-separated):
  //   "2026-06-22 14:30", "2026-06-22 14:30:00", "2026-06-22T14:30:00.5Z",
  //   "06/22/2026 14:30". The date-only branches below are $-anchored and would
  //   reject these, silently dropping the time. Build from LOCAL components so the
  //   stored wall-clock hour matches what the user typed (no host-TZ shift); honor
  //   an explicit Z/offset as an absolute instant when one is literally present.
  const ymdTime = str.match(
    /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?$/
  );
  if (ymdTime) {
    return dateTimeFromComponents(
      Number(ymdTime[1]), Number(ymdTime[2]), Number(ymdTime[3]),
      Number(ymdTime[4]), Number(ymdTime[5]), ymdTime[6] ? Number(ymdTime[6]) : 0,
      ymdTime[7]
    );
  }
  const mdyTime = str.match(
    /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?$/
  );
  if (mdyTime) {
    return dateTimeFromComponents(
      Number(mdyTime[3]), Number(mdyTime[1]), Number(mdyTime[2]),
      Number(mdyTime[4]), Number(mdyTime[5]), mdyTime[6] ? Number(mdyTime[6]) : 0,
      mdyTime[7]
    );
  }

  const ymd = str.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (ymd) {
    const year = Number(ymd[1]);
    const month = Number(ymd[2]);
    const day = Number(ymd[3]);
    if (year >= 1900 && year <= 2100 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const d = new Date(year, month - 1, day);
      if (d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day) {
        return d;
      }
    }
    return null;
  }

  const mdy = str.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (mdy) {
    const month = Number(mdy[1]);
    const day = Number(mdy[2]);
    const year = Number(mdy[3]);
    if (year >= 1900 && year <= 2100 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const d = new Date(year, month - 1, day);
      if (d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day) {
        return d;
      }
    }
    return null;
  }

  // US-style M/D/YY or D/M/YY with two-digit year (pivot: 00–30 → 2000+, else 1900+), aligned with temporal facet Date.parse fallback.
  const mdyy = str.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2})$/);
  if (mdyy) {
    const month = Number(mdyy[1]);
    const day = Number(mdyy[2]);
    let year = Number(mdyy[3]);
    if (Number.isFinite(month) && Number.isFinite(day) && Number.isFinite(year)) {
      if (year < 100) {
        year = year <= 30 ? 2000 + year : 1900 + year;
      }
      if (year >= 1900 && year <= 2100 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        const d = new Date(year, month - 1, day);
        if (d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day) {
          return d;
        }
      }
    }
    return null;
  }

  // Month name + year: "Sep-24", "Mar 23", "January 2025", "Dec/99" (aligns with client chartFilters / DataPreview pivot).
  const mmmYy = str.match(/^([A-Za-z]{3,})[-\s/]?(\d{2,4})$/i);
  if (mmmYy) {
    const prefix = mmmYy[1]!.toLowerCase().slice(0, 3);
    const monthIndex = MONTH_ABBREV_TO_INDEX[prefix];
    if (monthIndex !== undefined) {
      let year = Number(mmmYy[2]);
      if (Number.isFinite(year)) {
        if (year < 100) {
          year = year <= 30 ? 2000 + year : 1900 + year;
        }
        if (year >= 1900 && year <= 2100) {
          const d = new Date(year, monthIndex, 1);
          if (d.getFullYear() === year && d.getMonth() === monthIndex && d.getDate() === 1) {
            return d;
          }
        }
      }
    }
  }

  // Allow explicit ISO-like datetimes.
  if (/^\d{4}-\d{2}-\d{2}T/.test(str)) {
    const parsed = new Date(str);
    return isNaN(parsed.getTime()) ? null : parsed;
  }

  // Wide-format PeriodIso labels with a fixed calendar anchor — emitted by
  // the upload-time melt (see `wideFormat/periodVocabulary.ts`). Each shape
  // resolves to a representative anchor date so `applyTemporalFacetColumns`
  // can derive Year/Quarter/Month buckets. Comparative-only / rolling shapes
  // (`L12M`, `L12M-YA`, `MAT-YA`, `YTD-TY`, `XXXX-Q1`) intentionally remain
  // unparseable: they are anchored to "now", not a fixed calendar date.
  const isoPeriod = matchIsoPeriodAnchor(str);
  if (isoPeriod) return isoPeriod;

  if (startsWithMonthPrefix) return null;
  return null;
}

/**
 * Map a wide-format PeriodIso label to a representative calendar anchor.
 * Returns null for shapes without a fixed anchor (rolling windows, bare
 * comparatives, X-prefixed unknown years).
 */
function matchIsoPeriodAnchor(str: string): Date | null {
  // Strip trailing comparative qualifier (-TY, -YA, -2YA, -3YA) if any —
  // the anchor is encoded in the year component, not the qualifier.
  const stripped = str.replace(/-(?:TY|YA|2YA|3YA)$/i, "");

  // YYYY-Qn (calendar quarter) → first day of quarter
  const qMatch = stripped.match(/^(\d{4})-Q([1-4])$/i);
  if (qMatch) {
    const year = Number(qMatch[1]);
    const q = Number(qMatch[2]);
    if (year >= 1900 && year <= 2100) {
      return new Date(year, (q - 1) * 3, 1);
    }
    return null;
  }

  // YYYY-Hn (half year) → first day of half
  const hMatch = stripped.match(/^(\d{4})-H([12])$/i);
  if (hMatch) {
    const year = Number(hMatch[1]);
    const h = Number(hMatch[2]);
    if (year >= 1900 && year <= 2100) {
      return new Date(year, h === 1 ? 0 : 6, 1);
    }
    return null;
  }

  // YYYY-Wnn (ISO week) → Monday of that ISO week
  const wMatch = stripped.match(/^(\d{4})-W(\d{2})$/i);
  if (wMatch) {
    const year = Number(wMatch[1]);
    const week = Number(wMatch[2]);
    if (year >= 1900 && year <= 2100 && week >= 1 && week <= 53) {
      // ISO 8601 week date: Monday of the week containing Jan 4.
      const jan4 = new Date(year, 0, 4);
      const jan4Day = (jan4.getDay() + 6) % 7; // Mon=0..Sun=6
      const week1Monday = new Date(year, 0, 4 - jan4Day);
      const result = new Date(week1Monday);
      result.setDate(week1Monday.getDate() + (week - 1) * 7);
      return result;
    }
    return null;
  }

  // FYYYYY (fiscal year) and CYYYYY (calendar year) → Jan 1 of that year
  const fyMatch = stripped.match(/^(?:FY|CY)?(\d{4})$/i);
  if (fyMatch && /^(?:FY|CY)\d{4}$/i.test(stripped)) {
    const year = Number(fyMatch[1]);
    if (year >= 1900 && year <= 2100) return new Date(year, 0, 1);
    return null;
  }

  // WE-YYYY-MM-DD (week-ending date) → exact date
  const weMatch = stripped.match(/^WE-(\d{4})-(\d{2})-(\d{2})$/i);
  if (weMatch) {
    const year = Number(weMatch[1]);
    const month = Number(weMatch[2]);
    const day = Number(weMatch[3]);
    if (year >= 1900 && year <= 2100 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const d = new Date(year, month - 1, day);
      if (d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day) {
        return d;
      }
    }
    return null;
  }

  // MAT-YYYY-MM (Moving Annual Total ending YYYY-MM) → first day of that month
  const matMatch = stripped.match(/^MAT-(\d{4})-(\d{2})$/i);
  if (matMatch) {
    const year = Number(matMatch[1]);
    const month = Number(matMatch[2]);
    if (year >= 1900 && year <= 2100 && month >= 1 && month <= 12) {
      return new Date(year, month - 1, 1);
    }
    return null;
  }

  // YTD-YYYY-MM (year-to-date through YYYY-MM) → first day of that month
  const ytdMonthMatch = stripped.match(/^YTD-(\d{4})-(\d{2})$/i);
  if (ytdMonthMatch) {
    const year = Number(ytdMonthMatch[1]);
    const month = Number(ytdMonthMatch[2]);
    if (year >= 1900 && year <= 2100 && month >= 1 && month <= 12) {
      return new Date(year, month - 1, 1);
    }
    return null;
  }

  // YTD-YYYY (year-to-date YYYY) → Jan 1 of that year
  const ytdYearMatch = stripped.match(/^YTD-(\d{4})$/i);
  if (ytdYearMatch) {
    const year = Number(ytdYearMatch[1]);
    if (year >= 1900 && year <= 2100) return new Date(year, 0, 1);
    return null;
  }

  return null;
}

export function normalizeDateToPeriod(
  dateInput: string | Date,
  period: DatePeriod
): NormalizedDate | null {
  const date =
    dateInput instanceof Date && !isNaN(dateInput.getTime()) ? dateInput : null;
  if (!date) return null;

  const originalStr = date.toISOString();
  const year = date.getFullYear();
  const month = date.getMonth();
  const quarter = Math.floor(month / 3) + 1;
  const day = date.getDate();

  let normalizedKey: string;
  let displayLabel: string;

  switch (period) {
    case 'year':
      normalizedKey = `${year}`;
      displayLabel = `${year}`;
      break;
    case 'quarter':
      normalizedKey = `${year}-Q${quarter}`;
      displayLabel = `Q${quarter} ${year}`;
      break;
    case 'month':
      normalizedKey = `${year}-${String(month + 1).padStart(2, '0')}`;
      displayLabel = `${MONTH_SHORT_NAMES[month]} ${year}`;
      break;
    case 'monthOnly':
      normalizedKey = `${String(month + 1).padStart(2, '0')}`;
      displayLabel = MONTH_SHORT_NAMES[month]!;
      break;
    case 'day':
      normalizedKey = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      displayLabel = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      break;
    case 'week': {
      const wk = isoWeekKeyAndLabel(date);
      normalizedKey = wk.normalizedKey;
      displayLabel = wk.displayLabel;
      break;
    }
    case 'half_year':
      normalizedKey = `${year}-H${month < 6 ? 1 : 2}`;
      displayLabel = month < 6 ? `H1 ${year}` : `H2 ${year}`;
      break;
    case 'hour': {
      const ymd = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const hh = String(date.getHours()).padStart(2, '0');
      normalizedKey = `${ymd} ${hh}`;
      displayLabel = `${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${hh}:00`;
      break;
    }
    case 'minute': {
      const ymd = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const hh = String(date.getHours()).padStart(2, '0');
      const mm = String(date.getMinutes()).padStart(2, '0');
      normalizedKey = `${ymd} ${hh}:${mm}`;
      displayLabel = `${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${hh}:${mm}`;
      break;
    }
    case 'hour_of_day': {
      // Cyclical 0–23, aggregated across days. Zero-padded so "08" < "14" lexically.
      const hh = String(date.getHours()).padStart(2, '0');
      normalizedKey = hh;
      displayLabel = `${hh}:00`;
      break;
    }
    default:
      return null;
  }

  return {
    original: originalStr,
    date,
    period,
    normalizedKey,
    displayLabel,
  };
}

/**
 * Human label for a CANONICAL period key (the inverse of `normalizeDateToPeriod`'s
 * `normalizedKey`). Shape-detects the grain so quarters stay quarters:
 *   "2023"        → "2023"
 *   "2023-Q1"     → "Q1 2023"
 *   "2023-H1"     → "H1 2023"
 *   "2023-01"     → "Jan 2023"
 *   "2023-W12"    → "W12 2023"
 *   "2023-01-15"  → "15 Jan 2023"
 * Relative / unknown keys (e.g. "L12M", "YTD-TY") are returned verbatim.
 * Mirrored on the client by `formatTemporalPeriodKeyForDisplay`.
 */
export function formatPeriodKeyForDisplay(key: unknown): string {
  if (key === null || key === undefined) return '';
  const s = String(key).trim();
  if (!s) return '';
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d{4})-Q([1-4])$/))) return `Q${m[2]} ${m[1]}`;
  if ((m = s.match(/^(\d{4})-H([12])$/))) return `H${m[2]} ${m[1]}`;
  if ((m = s.match(/^(\d{4})-W(\d{1,2})$/))) return `W${Number(m[2])} ${m[1]}`;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/))) {
    const mi = Number(m[2]) - 1;
    if (mi >= 0 && mi < 12) return `${Number(m[3])} ${MONTH_SHORT_NAMES[mi]} ${m[1]}`;
  }
  if ((m = s.match(/^(\d{4})-(\d{2})$/))) {
    const mi = Number(m[2]) - 1;
    if (mi >= 0 && mi < 12) return `${MONTH_SHORT_NAMES[mi]} ${m[1]}`;
  }
  return s;
}

/** Simple period hints from natural language. Order: finer / explicit phrases before broad "date". */
export function detectPeriodFromQuery(query: string): DatePeriod | null {
  const q = query.toLowerCase();
  if (q.includes('quarter') || /\bq[1-4]\b/.test(q)) return 'quarter';
  if (
    q.includes('half year') ||
    q.includes('half-year') ||
    q.includes('semiannual') ||
    q.includes('semi-annual') ||
    /\bh1\b/.test(q) ||
    /\bh2\b/.test(q)
  ) {
    return 'half_year';
  }
  if (q.includes('month') || q.includes('monthly')) return 'month';
  if (
    q.includes('weekly') ||
    q.includes('by week') ||
    q.includes('per week') ||
    q.includes('iso week') ||
    (q.includes('week') && !q.includes('day of week'))
  ) {
    return 'week';
  }
  if (
    /\byoy\b/.test(q) ||
    q.includes('year over year') ||
    q.includes('per year') ||
    q.includes('each year') ||
    q.includes('by year') ||
    q.includes('yearly') ||
    q.includes('annual') ||
    q.includes('year')
  ) {
    return 'year';
  }
  if (q.includes('day') || q.includes('daily')) return 'day';
  if (q.includes('date')) return 'day';
  return null;
}

// ─── TOD1 · Time-of-day detection ────────────────────────────────────────────
//
// "Clock-In Time" style columns whose values are HH:MM:SS / HH:MM strings
// (no calendar date). The existing parseFlexibleDate has no time-only path,
// so without this helper such columns trip isDateColumnName ("\btime\b") and
// get tagged as `date`, causing two failures: (a) DuckDB stores VARCHAR while
// DataSummary advertises `date` (silent shape mismatch), (b) dirtyDateEnrichment
// would invent a fake calendar anchor (e.g. 2024-01-01T09:45:34) if it ran on
// these columns. Detecting them as `text + timeOfDay:true` short-circuits
// both and lets the planner reason about HH:MM:SS comparisons via CMP1.

const TIME_OF_DAY_REGEX = /^([01]?\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

const DEFAULT_TIME_OF_DAY_SENTINELS = new Set<string>([
  "absent",
  "n/a",
  "na",
  "-",
  "--",
  "",
  "null",
  "none",
]);

/** True iff `value` is a plain HH:MM or HH:MM:SS string (24-hour, no AM/PM). */
export function isTimeOfDayValue(value: string): boolean {
  if (typeof value !== "string") return false;
  return TIME_OF_DAY_REGEX.test(value.trim());
}

const TIME_COLUMN_NAME_HINT =
  /\b(time|clock|hour|in[ _-]?at|out[ _-]?at|start|end|punch)\b/i;

export interface TimeOfDayClassification {
  isTimeOfDay: boolean;
  sentinelValues: string[];
}

/**
 * Heuristic classifier for time-of-day columns.
 *
 * Returns isTimeOfDay=true when ≥85% of non-sentinel non-empty samples match
 * HH:MM(:SS) AND the column name carries a time hint, OR when the sample
 * share is ≥95% (high enough to override the name check). Rejects when too
 * few non-sentinel samples (< 5) — not enough signal to commit.
 *
 * `sentinelValues` is the subset of provided sample strings that look like
 * non-time placeholders ("Absent", "N/A", etc.) so the prompt block can
 * surface them and the planner can exclude them with `dimensionFilters`.
 */
export function classifyAsTimeOfDay(
  columnName: string,
  samples: ReadonlyArray<unknown>,
  extraSentinels: ReadonlyArray<string> = []
): TimeOfDayClassification {
  const sentinelSet = new Set([
    ...DEFAULT_TIME_OF_DAY_SENTINELS,
    ...extraSentinels.map((s) => s.trim().toLowerCase()),
  ]);
  const sentinelHits = new Set<string>();
  let timeMatches = 0;
  let nonSentinel = 0;

  for (const raw of samples) {
    if (raw == null) continue;
    const s = String(raw).trim();
    if (s.length === 0) continue;
    const lower = s.toLowerCase();
    if (sentinelSet.has(lower)) {
      sentinelHits.add(s);
      continue;
    }
    nonSentinel++;
    if (isTimeOfDayValue(s)) timeMatches++;
  }

  if (nonSentinel < 5) {
    return { isTimeOfDay: false, sentinelValues: [] };
  }
  const share = timeMatches / nonSentinel;
  const nameHinted = TIME_COLUMN_NAME_HINT.test(columnName);
  const passes = (share >= 0.85 && nameHinted) || share >= 0.95;
  if (!passes) {
    return { isTimeOfDay: false, sentinelValues: [] };
  }
  return {
    isTimeOfDay: true,
    sentinelValues: Array.from(sentinelHits).sort(),
  };
}

/** Conservative date-like column name detection. */
export function isDateColumnName(columnName: string): boolean {
  const n = columnName.trim().toLowerCase().replace(/[_-]+/g, ' ');
  if (!n) return false;
  if (/\b(id|code|sku|zip|postal|phone|qty|quantity)\b/.test(n)) return false;
  return /\b(date|time|timestamp|day|week|month|quarter|qtr|year|fy|fiscal|period|w\/e|week ending)\b/.test(n);
}

/**
 * Strict allowlist for temporal enrichment by column name.
 * LLM may still override this upstream, but value-only detection must not.
 */
export function isTemporalWhitelistColumnName(columnName: string): boolean {
  const n = columnName.trim().toLowerCase().replace(/[_-]+/g, ' ');
  if (!n) return false;
  return /\b(date|dt|quarter|qtr|year|yr|month|period|week|w\/e|time|timestamp)\b/.test(n);
}

export interface ExtractedDate {
  type: 'year' | 'month' | 'date' | 'dateRange';
  year?: number;
  month?: number;
  monthName?: string;
  date?: Date;
  startDate?: Date;
  endDate?: Date;
  originalText: string;
}

/** Lightweight date extraction for explicit YYYY-MM-DD mentions. */
export function extractDatesFromQuery(query: string): ExtractedDate[] {
  const out: ExtractedDate[] = [];
  const m = query.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) {
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}`);
    if (!isNaN(d.getTime())) {
      out.push({ type: 'date', date: d, originalText: m[0] });
    }
  }
  return out;
}
