// Header tokenization — split a column header into atomic tokens
// that the classifier can feed into `matchPeriod` / `matchMetric`.
//
// Separators: whitespace, hyphen, underscore, pipe, parens, brackets,
// slash, comma. Apostrophes are preserved so that "Dec'24" stays one
// token and the period vocabulary's month-with-year matcher can pick
// it up.
//
// The classifier in W4 composes contiguous n-grams from these tokens
// so multi-word metrics and periods ("Value Sales", "Jan 2024") match
// even when the raw header uses non-space separators.

/**
 * Split a column header on common separators. Returns non-empty
 * tokens in original order, preserving case. Apostrophes and
 * internal digits stay attached to the surrounding token.
 */
export function tokenize(header: string): string[] {
  if (!header || typeof header !== "string") return [];
  const out: string[] = [];
  for (const part of header.split(/[\s\-_|()\[\]/,]+/u)) {
    const trimmed = part.trim();
    if (trimmed) out.push(trimmed);
  }
  return out;
}

/**
 * Contiguous n-grams of a token list, joined by a single space.
 * `sizes` defaults to [3, 2, 1] so callers can scan most-specific
 * first without having to reverse a result.
 */
export function ngrams(tokens: string[], sizes: number[] = [3, 2, 1]): string[] {
  const out: string[] = [];
  for (const size of sizes) {
    if (size < 1) continue;
    for (let i = 0; i + size <= tokens.length; i++) {
      out.push(tokens.slice(i, i + size).join(" "));
    }
  }
  return out;
}
