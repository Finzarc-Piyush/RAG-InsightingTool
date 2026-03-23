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

export function getCountNameForIdColumn(columnName: string): string {
  const lower = columnName.toLowerCase();
  if (lower.endsWith("_id")) {
    return lower.replace(/_id$/, "_count");
  }
  return `${lower}_count`;
}
