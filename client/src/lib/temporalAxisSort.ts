/**
 * Chronological ordering for pivot row/column labels and chart axes
 * (normalized facet keys, ISO dates, then lexical fallback).
 */

function isoWeekStartUtc(isoYear: number, isoWeek: number): number {
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const dayOfWeek = jan4.getUTCDay() || 7;
  const mondayWeek1 = new Date(jan4);
  mondayWeek1.setUTCDate(jan4.getUTCDate() - (dayOfWeek - 1));
  const mondayTarget = new Date(mondayWeek1);
  mondayTarget.setUTCDate(mondayWeek1.getUTCDate() + (isoWeek - 1) * 7);
  return mondayTarget.getTime();
}

/** Parse sortable instant (UTC ms) for known temporal facet / ISO-like labels. */
export function parseTemporalLabelSortKey(label: string): number | null {
  const s = String(label ?? '').trim();
  if (!s) return null;

  let m: RegExpMatchArray | null;

  if (/^\d{4}$/.test(s)) {
    return Date.UTC(Number(s), 0, 1);
  }

  m = s.match(/^(\d{4})-(\d{2})$/);
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    if (month >= 1 && month <= 12) return Date.UTC(year, month - 1, 1);
  }

  m = s.match(/^(\d{4})-Q([1-4])$/);
  if (m) {
    const year = Number(m[1]);
    const q = Number(m[2]);
    return Date.UTC(year, (q - 1) * 3, 1);
  }

  m = s.match(/^(\d{4})-H([1-2])$/);
  if (m) {
    const year = Number(m[1]);
    const h = Number(m[2]);
    return Date.UTC(year, (h - 1) * 6, 1);
  }

  m = s.match(/^(\d{4})-W(\d{2})$/);
  if (m) {
    const year = Number(m[1]);
    const wk = Number(m[2]);
    if (wk >= 1 && wk <= 53) return isoWeekStartUtc(year, wk);
  }

  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return Date.UTC(year, month - 1, day);
    }
  }

  const isoTry = Date.parse(s);
  if (!Number.isNaN(isoTry)) return isoTry;

  return null;
}

export function compareTemporalOrLexicalLabels(a: string, b: string): number {
  const ta = parseTemporalLabelSortKey(a);
  const tb = parseTemporalLabelSortKey(b);
  if (ta != null && tb != null) return ta - tb;
  if (ta != null) return -1;
  if (tb != null) return 1;
  return a.localeCompare(b, undefined, { numeric: true });
}
