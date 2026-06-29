/**
 * W-DEC1 · Render-side hygiene: clamp machine-precision decimals to ≤2 places.
 *
 * The narrator / insight LLM occasionally echoes a raw `repr()`-style float into
 * prose — e.g. "PCNO(R) contributes 75.86126417319149 Rs Cr" or
 * "survival_rate = 0.6296296296296297". Per the product rule "no more than two
 * decimal places anywhere", any number carrying ≥3 fractional digits is rounded
 * to 2 decimals (trailing zeros dropped: 1.999999 → 2, 0.6296… → 0.63). Numbers
 * already at ≤2 dp, integers, percentages, years, and dotted IDs / versions are
 * left untouched.
 *
 * Boundary-guarded: a number is only clamped when the character immediately
 * before it is NOT a letter, digit, underscore, or dot — so identifiers like
 * "session_1.23456" and versions like "v1.2.345" are never rewritten.
 *
 * It is a conservative, context-free safety net applied at EVERY insight render
 * surface (chat answer card, Key-Insights panel, chart insight, body prose). The
 * durable fix also lives at generation (the answer-envelope contract + compact
 * number formatter cap decimals). `cleanEvidenceNumbers` is kept as a
 * back-compat alias for existing import sites.
 */
export function clampInsightDecimals(text: string): string {
  if (!text) return text;
  return text.replace(/-?\d+\.\d{3,}/g, (match: string, offset: number, full: string) => {
    const prev = offset > 0 ? full[offset - 1] : '';
    // Part of an identifier / dotted version / longer numeric token → leave alone.
    if (prev && /[A-Za-z0-9_.]/.test(prev)) return match;
    const n = Number(match);
    // Number(n.toFixed(2)) drops trailing zeros: 0.6296… → 0.63, 1.999… → 2.
    return Number.isFinite(n) ? String(Number(n.toFixed(2))) : match;
  });
}

/** Back-compat alias — historic call sites import this name. */
export const cleanEvidenceNumbers = clampInsightDecimals;
