/**
 * CQ-5 · Single definition of analysis-cell numeric parsing, shared by the
 * server (pivotQueryService) and client (formatAnalysisNumber). Was byte-for-byte
 * duplicated and hand-synced across both runtimes. Pure — safe in shared/.
 *
 * Strips currency symbols ($ € £ ¥ ₹), thousands separators, percent signs and
 * whitespace; treats `(1,234)` as a negative; returns null for empty / "null" /
 * non-finite input.
 */
export function parseNumericCell(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;

  const raw = String(value).trim();
  if (!raw) return null;
  if (raw.toLowerCase() === "null") return null;

  const isParenNeg = raw.startsWith("(") && raw.endsWith(")");

  const cleaned = raw
    .replace(/^\(+/, "")
    .replace(/\)+$/, "")
    .replace(/[$€£¥₹]/g, "")
    .replace(/,/g, "")
    .replace(/%/g, "")
    .replace(/\s+/g, "");

  const num = parseFloat(cleaned);
  if (!Number.isFinite(num)) return null;
  return isParenNeg ? -Math.abs(num) : num;
}
