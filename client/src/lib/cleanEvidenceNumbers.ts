/**
 * W-CW2 · Render-side hygiene for machine-precision decimal leaks.
 *
 * The narrator/synthesizer occasionally echoes a raw `repr()`-style decimal into
 * a finding's evidence prose — e.g. "survival_rate = 0.6296296296296297, which
 * is 62.96%". The 16-digit tail is noise that reads as "useless / unpolished".
 * This helper rounds any number carrying ≥5 fractional digits down to 4 decimal
 * places, leaving percentages, short decimals, integers, years, and IDs alone.
 *
 * It is a conservative, context-free safety net for already-persisted answers;
 * the durable fix lives at generation (the answer-envelope contract bans raw
 * decimals). Applied to `findings[].evidence` and `findings[].magnitude`.
 */
export function cleanEvidenceNumbers(text: string): string {
  if (!text) return text;
  return text.replace(/-?\d+\.\d{5,}/g, (match) => {
    const n = Number(match);
    // Number(n.toFixed(4)) drops trailing zeros: 0.6296296296296297 → 0.6296.
    return Number.isFinite(n) ? String(Number(n.toFixed(4))) : match;
  });
}
