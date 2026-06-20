// Duration formatting for the client. A duration column ("Working Hrs") is
// stored as a numeric measure in DECIMAL HOURS; this renders it back for
// display ("3h 32m"). Mirrors the server-side formatHoursAsDuration in
// server/lib/durationColumns.ts (kept in sync; both are tiny + pure).

import type { ColumnDuration } from '@/shared/schema';

export type { ColumnDuration };

/**
 * Format decimal hours as a duration.
 *  - "hm" (default): "3h 32m"  (rounds to the minute — ideal for averages)
 *  - "hms":          "03:31:57"
 *  - "decimal":      "3.53h"
 */
export function formatHoursAsDuration(
  hours: number | null | undefined,
  fmt: NonNullable<ColumnDuration['format']> = 'hm'
): string {
  if (hours === null || hours === undefined || !Number.isFinite(hours)) {
    return '—';
  }
  const neg = hours < 0;
  const abs = Math.abs(hours);
  if (fmt === 'decimal') {
    return `${neg ? '-' : ''}${abs.toFixed(2)}h`;
  }
  let out: string;
  if (fmt === 'hms') {
    const totalSec = Math.round(abs * 3600);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    out = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(
      s
    ).padStart(2, '0')}`;
  } else {
    const totalMin = Math.round(abs * 60);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    out = `${h}h ${String(m).padStart(2, '0')}m`;
  }
  return neg ? `-${out}` : out;
}
