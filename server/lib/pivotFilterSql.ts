export function quoteIdent(col: string): string {
  return `"${col.replace(/"/g, '""')}"`;
}

export function escapeSqlStringLiteral(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/** WHERE clause for pivot-style filter fields (inclusive IN lists). */
export function buildPivotFilterWhereSql(
  filterFields: string[],
  filterSelections: Record<string, string[]> | undefined
): string {
  const parts: string[] = [];
  const sel = filterSelections ?? {};
  for (const f of filterFields) {
    const arr = sel[f];
    if (arr === undefined) continue;
    if (arr.length === 0) return "1=0";
    const colExpr = `COALESCE(CAST(${quoteIdent(f)} AS VARCHAR), '')`;
    const inList = arr.map((v) => escapeSqlStringLiteral(String(v))).join(", ");
    parts.push(`${colExpr} IN (${inList})`);
  }
  return parts.length ? parts.join(" AND ") : "1=1";
}
