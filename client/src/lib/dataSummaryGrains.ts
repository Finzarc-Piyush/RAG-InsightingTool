import type { TemporalDisplayGrain } from '@/shared/schema';

export function temporalGrainsFromSummaryColumns(
  columns: Array<{ name: string; temporalDisplayGrain?: TemporalDisplayGrain }> | undefined
): Record<string, TemporalDisplayGrain> {
  const out: Record<string, TemporalDisplayGrain> = {};
  if (!columns) return out;
  for (const c of columns) {
    if (c.name && c.temporalDisplayGrain) {
      out[c.name] = c.temporalDisplayGrain;
    }
  }
  return out;
}
