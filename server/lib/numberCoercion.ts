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

/** parseFloat-based coercion. Returns the finite number, or null. */
export function toNumberOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const f = parseFloat(v);
    if (Number.isFinite(f)) return f;
  }
  return null;
}
