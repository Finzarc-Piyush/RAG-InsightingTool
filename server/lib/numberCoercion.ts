/**
 * Shared numeric coercion helpers.
 *
 * `toNumber` (the percent/comma-stripping, NaN-on-blank variant) was copy-pasted
 * byte-for-byte across chartGenerator, dataTransform and correlationMath;
 * `toNumberOrNull` (the parseFloat, null-on-blank variant) was duplicated in
 * dataProvenance and rowSetRef. This is the one definition of each.
 *
 * NOTE: a few modules intentionally keep their own stricter/looser variants
 * (e.g. chartDownsampling strips currency symbols; richColumnProfile does an
 * aggressive non-numeric strip; streamingCorrelationAnalyzer treats non-finite
 * numbers as NaN). Those are deliberately NOT consolidated here.
 */

/** Strip %/commas, trim, coerce to Number. Returns NaN for null/undefined/''. */
export function toNumber(value: unknown): number {
  if (value === null || value === undefined || value === '') return NaN;
  const cleaned = String(value).replace(/[%,]/g, '').trim();
  return Number(cleaned);
}

/**
 * Number()-based coercion (NOT parseFloat). Trims strings, returns null for
 * blank or non-finite input. This is the exact body that was copy-pasted as
 * `toNumberOrNull` (cohort, rfm, hierarchicalDrill, priceElasticity) and
 * `numericValue` (breakdownRanking, twoSegment) across the analytical tools.
 * Distinct from `toNumberOrNull` below, which uses parseFloat (so e.g.
 * "12px" -> null here vs 12 there, "1,000" -> null here vs 1 there).
 */
export function toFiniteNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** parseFloat-based coercion. Returns the finite number, or null. */
export function toNumberOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const f = parseFloat(v);
    if (Number.isFinite(f)) return f;
  }
  return null;
}

/**
 * Round `value` to `digits` decimal places. Non-finite inputs pass through
 * unchanged. Consolidates the byte-identical `round` helpers previously
 * duplicated across marketBasketTool, priceElasticityTool, richColumnProfile
 * (default 6) and budgetOptimizerTool (hardcoded 2).
 */
export function roundTo(value: number, digits = 6): number {
  if (!Number.isFinite(value)) return value;
  const k = Math.pow(10, digits);
  return Math.round(value * k) / k;
}
