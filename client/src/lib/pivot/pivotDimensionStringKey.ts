/** Stable key for grouping/filtering pivot dimensions (avoids `[object Object]`). */
export function pivotDimensionStringKey(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'boolean') return raw ? 'true' : 'false';
  if (typeof raw === 'number')
    return Number.isFinite(raw) ? String(raw) : '';
  if (typeof raw === 'string') return raw;
  if (raw instanceof Date && !isNaN(raw.getTime())) return raw.toISOString();
  if (typeof raw === 'object') {
    try {
      const o = raw as Record<string, unknown>;
      return JSON.stringify(raw, Object.keys(o).sort());
    } catch {
      return '[unserializable]';
    }
  }
  return String(raw);
}
