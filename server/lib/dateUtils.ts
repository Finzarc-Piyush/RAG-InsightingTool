/**
 * Date utilities with flexible parsing and light heuristics.
 */

export type DatePeriod = 'day' | 'month' | 'quarter' | 'year' | 'monthOnly' | 'month';

export interface NormalizedDate {
  original: string;
  date: Date;
  period: DatePeriod;
  normalizedKey: string;
  displayLabel: string;
}

const MONTH_SHORT_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

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

  const parsed = new Date(str);
  return isNaN(parsed.getTime()) ? null : parsed;
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

/** Simple period hints from natural language. */
export function detectPeriodFromQuery(query: string): DatePeriod | null {
  const q = query.toLowerCase();
  if (q.includes('quarter') || /\bq[1-4]\b/.test(q)) return 'quarter';
  if (q.includes('month') || q.includes('monthly')) return 'month';
  if (q.includes('year') || q.includes('yearly') || q.includes('annual')) return 'year';
  if (q.includes('day') || q.includes('daily') || q.includes('date')) return 'day';
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
