/**
 * ID column naming heuristics (no heavy deps — safe to import from dataTransform tests).
 */
export function isIdColumn(columnName: string): boolean {
  const lower = columnName.toLowerCase();
  return (
    /_id$|^id$|_id_/i.test(columnName) ||
    [
      "order_id",
      "item_id",
      "customer_id",
      "user_id",
      "product_id",
      "transaction_id",
    ].includes(lower)
  );
}

/** Column titles that look like surrogate keys — never date-enriched or reclassified as dates. */
export function isLikelyIdentifierColumnName(columnName: string): boolean {
  const norm = columnName.toLowerCase().replace(/\s+/g, " ").trim();
  const stripped = norm.replace(/^#\s*/, "");
  const collapsed = stripped.replace(/[\s_#-]/g, "");

  if (isIdColumn(columnName)) return true;
  if (/^(row id|order id|line id|record id)$/.test(stripped)) return true;
  if (/^(rowid|row_id|lineid|recordid|orderid)$/i.test(collapsed)) return true;
  if (/^(row|order|customer|invoice|record|line)[\s_-]?(no|number|num)\.?$/.test(stripped)) return true;
  if (/^(rowno|orderno|customerno|invoiceno|recordno|lineno)$/.test(collapsed)) return true;
  if (stripped === "#" || stripped === "index" || stripped === "idx" || stripped === "no.") return true;
  if (/\b(row|record|line|order|customer|transaction|invoice)[\s_]?id\b/.test(stripped)) return true;
  if (/\b(uuid|guid)\b/.test(stripped)) return true;
  if (norm === "sku" || norm.endsWith(" sku")) return true;
  return false;
}

export function getCountNameForIdColumn(columnName: string): string {
  const lower = columnName.toLowerCase();
  if (lower.endsWith("_id")) {
    return lower.replace(/_id$/, "_count");
  }
  return `${lower}_count`;
}
