import { format, isValid, parseISO } from 'date-fns';
import type { TemporalDisplayGrain } from '@/shared/schema';

function parseToDate(value: unknown): Date | null {
  if (value instanceof Date && !isNaN(value.getTime())) return value;
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;
  const fromIso = parseISO(s);
  if (isValid(fromIso)) return fromIso;
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d;
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
