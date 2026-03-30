/**
 * Analysis table numeric display: integers for |n| ≥ 10, decimals when smaller.
 */
export function formatAnalysisNumber(n: number): string {
  if (!Number.isFinite(n)) {
    return String(n);
  }
  const abs = Math.abs(n);
  if (abs >= 10) {
    return Math.round(n).toLocaleString(undefined, {
      maximumFractionDigits: 0,
    });
  }
  const s = n.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 6,
  });
  return s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

export function parseNumericCell(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  const raw = String(value).trim();
  if (!raw) return null;
  if (raw.toLowerCase() === 'null') return null;

  // Handle wrapped negative numbers like "(1,234.56)".
  const isParenNeg = raw.startsWith('(') && raw.endsWith(')');

  // Strip common formatting:
  // - thousands separators (',')
  // - percent symbols ('%')
  // - currency symbols (₹ $ € £ ¥)
  // - whitespace
  const cleaned = raw
    .replace(/^\(+/, '')
    .replace(/\)+$/, '')
    .replace(/[$€£¥₹]/g, '')
    .replace(/,/g, '')
    .replace(/%/g, '')
    .replace(/\s+/g, '');

  const num = parseFloat(cleaned);
  if (!Number.isFinite(num)) return null;
  return isParenNeg ? -Math.abs(num) : num;
}
