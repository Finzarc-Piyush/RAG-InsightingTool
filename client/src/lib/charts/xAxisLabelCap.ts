export const MAX_X_AXIS_LABELS = 10;

export function pickEvenlySpacedTicks<T>(values: readonly T[], max: number = MAX_X_AXIS_LABELS): T[] {
  const n = values.length;
  if (n === 0) return [];
  if (n <= max) return [...values];
  if (max <= 1) return [values[0]];
  const out: T[] = [];
  const step = (n - 1) / (max - 1);
  const seen = new Set<number>();
  for (let i = 0; i < max; i++) {
    const idx = Math.round(i * step);
    if (!seen.has(idx)) {
      seen.add(idx);
      out.push(values[idx]);
    }
  }
  return out;
}

export function echartsLabelInterval(domainLength: number, max: number = MAX_X_AXIS_LABELS): number {
  if (domainLength <= max) return 0;
  return Math.ceil(domainLength / max) - 1;
}
