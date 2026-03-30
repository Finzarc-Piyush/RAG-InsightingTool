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
  | 'monthOnly';

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

const MONTH_SHORT_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

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

  // Month name + year: "Sep-24", "Mar 23", "January 2025", "Dec/99" (aligns with client chartFilters / DataPreview pivot).
  const mmmYy = str.match(/^([A-Za-z]{3,})[-\s/]?(\d{2,4})$/i);
  if (mmmYy) {
    const prefix = mmmYy[1].toLowerCase().slice(0, 3);
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

  if (startsWithMonthPrefix) return null;
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
      displayLabel = MONTH_SHORT_NAMES[month];
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
