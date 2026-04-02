/**
 * Row-level filtering aligned with pivot SQL: COALESCE(CAST(col AS VARCHAR), '') IN (...).
 */

export function pivotDimensionStringKeyForChartFilter(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  if (typeof raw === "boolean") return raw ? "true" : "false";
  if (typeof raw === "number")
    return Number.isFinite(raw) ? String(raw) : "";
  if (typeof raw === "string") return raw;
  if (raw instanceof Date && !isNaN(raw.getTime())) return raw.toISOString();
  if (typeof raw === "object") {
    try {
      const o = raw as Record<string, unknown>;
      return JSON.stringify(raw, Object.keys(o).sort());
    } catch {
      return "[unserializable]";
    }
  }
  return String(raw);
}

export function filterRowsByPivotSelections(
  rows: Record<string, unknown>[],
  filterFields: string[],
  filterSelections: Record<string, string[]> | undefined
): Record<string, unknown>[] {
  if (!filterFields.length) return rows;
  const map = filterSelections ?? {};
  return rows.filter((row) => {
    for (const f of filterFields) {
      const list = map[f];
      if (list === undefined) continue;
      if (list.length === 0) return false;
      const key = pivotDimensionStringKeyForChartFilter(row[f]);
      if (!list.includes(key)) return false;
    }
    return true;
  });
}
