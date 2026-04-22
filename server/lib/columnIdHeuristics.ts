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
  // "code" suffix covers postal code, zip code, pin code, product code, area code, etc.
  if (/\bcode\b/.test(stripped)) return true;
  return false;
}

/**
 * Returns true when a numerically-typed column should be reclassified as a string
 * because its values look like identifiers or codes rather than measurable quantities.
 *
 * Three statistical signals (no hardcoded column-name lists):
 *   A) Name already matches isLikelyIdentifierColumnName (catches IDs / codes by pattern)
 *   B) Very high cardinality (≥80% unique) — row-level surrogate keys
 *   C) Fixed integer digit-width (all values same length ≥3 digits) — postal/ZIP/PIN codes
 *
 * Caller is responsible for ensuring every value in `nonNullValues` already passed
 * the numeric threshold before calling this.
 */
export function isIdentifierLikeNumericColumn(
  colName: string,
  nonNullValues: unknown[]
): boolean {
  if (!nonNullValues.length) return false;
  // Must be all integers (no decimal point) for any of the signals to apply.
  const allInt = nonNullValues.every((v) => /^-?\d+$/.test(String(v).trim()));
  if (!allInt) return false;
  // Signal A: name-pattern match
  if (isLikelyIdentifierColumnName(colName)) return true;
  // Signal B: high cardinality → sequential / surrogate key
  const unique = new Set(nonNullValues.map(String)).size;
  if (unique / nonNullValues.length >= 0.8) return true;
  // Signal C: fixed digit width → code field (e.g. all 5-digit ZIP codes)
  const lengths = nonNullValues.map((v) => String(v).trim().replace(/^-/, "").length);
  const minLen = Math.min(...lengths);
  const maxLen = Math.max(...lengths);
  if (minLen === maxLen && minLen >= 3) return true;
  return false;
}

export function getCountNameForIdColumn(columnName: string): string {
  const lower = columnName.toLowerCase();
  if (lower.endsWith("_id")) {
    return lower.replace(/_id$/, "_count");
  }
  return `${lower}_count`;
}
