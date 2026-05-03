/**
 * Chart palette resolvers. WC1.4.
 *
 * Returns CSS-var strings (`hsl(var(--chart-N))`), NOT resolved hex.
 * The browser resolves the variable at paint time, so theme switches
 * (light ↔ dark) re-paint without re-reading the DOM. Renderers should
 * pass these strings directly to `fill` / `stroke` props.
 *
 * Three palettes:
 *   - qualitative (1..12) — categorical series.
 *   - sequential (1..9)   — single-hue gradient (heatmaps, choropleths).
 *   - diverging  (1..11)  — neutral center, ±5 steps (variance, delta).
 *
 * Each palette is defined in client/src/index.css under `:root` and
 * `.dark` selectors. Adding/removing colors there is a CSS-only change.
 */

export const QUALITATIVE_PALETTE_SIZE = 12;
export const SEQUENTIAL_PALETTE_SIZE = 9;
export const DIVERGING_PALETTE_SIZE = 11;

/**
 * Pick the Nth qualitative series color, wrapping at 12.
 *   qualitativeColor(0)  → 'hsl(var(--chart-1))'
 *   qualitativeColor(11) → 'hsl(var(--chart-12))'
 *   qualitativeColor(12) → 'hsl(var(--chart-1))' (wrap)
 */
export function qualitativeColor(index: number): string {
  const i = ((index % QUALITATIVE_PALETTE_SIZE) + QUALITATIVE_PALETTE_SIZE) %
    QUALITATIVE_PALETTE_SIZE;
  return `hsl(var(--chart-${i + 1}))`;
}

/**
 * Map a value in [0, 1] to one of 9 sequential color stops.
 * Out-of-range values clamp to the ends.
 */
export function sequentialColor(t: number): string {
  if (Number.isNaN(t)) return `hsl(var(--chart-seq-5))`;
  const clamped = Math.max(0, Math.min(1, t));
  const step = Math.round(clamped * (SEQUENTIAL_PALETTE_SIZE - 1));
  return `hsl(var(--chart-seq-${step + 1}))`;
}

/**
 * Map a value in [-1, 1] to one of 11 diverging color stops, with
 * step 6 (1-indexed) as the neutral center. Out-of-range values clamp.
 */
export function divergingColor(t: number): string {
  if (Number.isNaN(t)) return `hsl(var(--chart-div-6))`;
  const clamped = Math.max(-1, Math.min(1, t));
  const halfRange = (DIVERGING_PALETTE_SIZE - 1) / 2; // = 5
  const step = Math.round((clamped + 1) * halfRange);
  return `hsl(var(--chart-div-${step + 1}))`;
}

/**
 * Build a full palette array of N qualitative colors, useful for cases
 * (e.g., d3 ordinal scales) that want an explicit array of strings.
 */
export function qualitativePalette(n: number = QUALITATIVE_PALETTE_SIZE): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(qualitativeColor(i));
  return out;
}

export function sequentialPalette(steps: number = SEQUENTIAL_PALETTE_SIZE): string[] {
  const out: string[] = [];
  for (let i = 0; i < steps; i++) {
    out.push(sequentialColor(steps === 1 ? 0 : i / (steps - 1)));
  }
  return out;
}

export function divergingPalette(steps: number = DIVERGING_PALETTE_SIZE): string[] {
  const out: string[] = [];
  for (let i = 0; i < steps; i++) {
    const t = steps === 1 ? 0 : -1 + (2 * i) / (steps - 1);
    out.push(divergingColor(t));
  }
  return out;
}
