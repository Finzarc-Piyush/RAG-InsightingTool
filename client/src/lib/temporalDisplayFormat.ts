import { format, isValid, parseISO } from 'date-fns';
import type { TemporalDisplayGrain } from '@/shared/schema';

function buildDate(year: number, month: number, day: number): Date | null {
  if (year < 1900 || year > 2100) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  return d;
}

function parseToDate(value: unknown): Date | null {
  if (value instanceof Date && !isNaN(value.getTime())) return value;
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;
  const fromIso = parseISO(s);
  if (isValid(fromIso)) return fromIso;

  const ymd = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (ymd) {
    return buildDate(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]));
  }

  const mdy = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (mdy) {
    return buildDate(Number(mdy[3]), Number(mdy[1]), Number(mdy[2]));
  }

  const monthYear = s.match(/^([A-Za-z]{3,})[-\s](\d{2,4})$/);
  if (monthYear) {
    const monthMap: Record<string, number> = {
      jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
      jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
    };
    const month = monthMap[monthYear[1].slice(0, 3).toLowerCase()];
    let year = Number(monthYear[2]);
    if (month && Number.isFinite(year)) {
      if (monthYear[2].length === 2) year = year <= 30 ? 2000 + year : 1900 + year;
      return buildDate(year, month, 1);
    }
  }

  return null;
}

export function formatDateCellForGrain(value: unknown, grain: TemporalDisplayGrain): string | null {
  const d = parseToDate(value);
  if (!d) return null;
  if (grain === 'year') return format(d, 'yyyy');
  if (grain === 'monthOrQuarter') return format(d, 'MMM-yy');
  return format(d, 'dd/MM/yy');
}

/** Client-side median-gap grain when API did not send temporalDisplayGrain (older sessions). */
export function inferTemporalGrainFromSample(values: unknown[]): TemporalDisplayGrain {
  const dates: Date[] = [];
  for (const v of values.slice(0, 500)) {
    const d = parseToDate(v);
    if (d) dates.push(d);
  }
  const unique = [
    ...new Map(
      dates.map((d) => [`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`, d] as const)
    ).values(),
  ].sort((a, b) => a.getTime() - b.getTime());
  if (unique.length < 2) return 'dayOrWeek';

  const deltas: number[] = [];
  for (let i = 1; i < unique.length; i++) {
    const days = (unique[i]!.getTime() - unique[i - 1]!.getTime()) / 86_400_000;
    if (days > 0) deltas.push(days);
  }
  if (deltas.length === 0) return 'dayOrWeek';
  const sorted = [...deltas].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)]!;
  if (med < 14) return 'dayOrWeek';
  if (med < 120) return 'monthOrQuarter';
  return 'year';
}
