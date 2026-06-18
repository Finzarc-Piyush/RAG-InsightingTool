/**
 * brandPalette.ts — single source of truth for the export renderers' brand colors.
 *
 * The PPTX, PDF, and ECharts-SSR masters each used to inline the SAME hex
 * values. This module owns the canonical raw hex once. Each master keeps its
 * own local BRAND object (its exact key set + its '#'-vs-no-'#' convention —
 * pptxgenjs wants bare hex, ECharts/@react-pdf want '#'-prefixed) but builds the
 * VALUES from here, so a palette change lands in one place.
 *
 * ── Identity (the "character") ────────────────────────────────────────────
 * A premium, considered palette — deep NAVY primary + warm GOLD accent + a
 * curated 8-step jewel categorical ramp (distinct neighbours so grouped/series
 * charts stay legible). This replaces the old generic SaaS-cobalt set. The ink
 * is a warm near-black navy, surfaces are soft cool/warm tints, hairlines are
 * delicate. Horizons read as terracotta (now) / gold (this quarter) / teal
 * (strategic) so the whole deck shares one colour world.
 *
 * Pure leaf module: no imports (tint math is inline so this stays dependency-free).
 */

/** Canonical brand hex, RAW (no '#'). Existing keys are preserved (consumers
 *  reference them by name); new tokens are added below them. */
export const EXPORT_HEX = {
  /** Signature deep navy — title field, headers, primary series, badges. */
  primary: "123A63",
  /** Warm gold — accents, emphasis ticks, "this quarter" horizon, highlights. */
  accent: "C8881E",
  /** Ink — headlines & primary body. Warm near-black navy, not pure gray. */
  foreground: "16222F",
  /** Muted — footers, captions, axis ticks, de-emphasised meta. */
  muted: "6A7686",
  /** Hairline — card borders, table grid, dividers. Delicate. */
  border: "DCE1E8",
  /** Slide / chart background. */
  background: "FFFFFF",
  /** Soft cool surface — KPI/card fills, zebra rows. */
  surfaceMuted: "F4F6FA",

  // ── added tokens ─────────────────────────────────────────────────────────
  /** Secondary text — rationales, sublabels. Readable, not washed out. */
  inkSoft: "44556A",
  /** Very light chart gridlines (lighter than `border`). */
  gridline: "EBEEF3",
  /** Warm off-white — cover / section panels. */
  surfaceWarm: "FBF8F2",
  /** Dark navy panel — cover band / section dividers (white text on top). */
  surfaceNavy: "0E2A45",
  /** Positive delta (▲). */
  positive: "2F8F5B",
  /** Negative delta (▼). */
  negative: "C0492F",

  // Horizon hues — coherent with the ramp (terracotta / gold / teal).
  /** "Now" horizon. */
  horizonNow: "C0492F",
  /** "This quarter" horizon. */
  horizonThisQuarter: "C8881E",
  /** "Strategic" horizon. */
  horizonStrategic: "2E7D78",
} as const;

/**
 * 8-step categorical palette, RAW (no '#'). Curated jewel tones ordered so
 * ADJACENT series are clearly different in hue (navy → gold → teal → terracotta
 * …) — the first three (the common case) are maximally distinct.
 */
export const EXPORT_CATEGORICAL = [
  "123A63", // deep navy   (primary)
  "C8881E", // gold        (accent)
  "3E8E7E", // teal
  "C25A4B", // terracotta
  "2F7DA3", // ocean blue
  "6F5C9E", // violet
  "7FA05A", // olive
  "B5547A", // rose
] as const;

/** Prefix a raw hex with '#'. */
export const withHash = (h: string): string => `#${h}`;

/** Categorical palette '#'-prefixed (ECharts-SSR / @react-pdf convention). */
export const EXPORT_CATEGORICAL_HEX = EXPORT_CATEGORICAL.map(withHash);

// ── Colour math (inline; keeps this a pure leaf module) ──────────────────────

const clamp255 = (n: number): number => Math.max(0, Math.min(255, Math.round(n)));

/** Parse a 6-digit hex (with or without '#') to [r,g,b]. */
function toRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

const toHex = (r: number, g: number, b: number): string =>
  [r, g, b].map((v) => clamp255(v).toString(16).padStart(2, "0")).join("").toUpperCase();

/**
 * Mix `hex` toward white by `amount` (0 = original, 1 = white). Used to build
 * soft "badge"/card tints from a brand colour. Returns RAW hex (no '#').
 */
export function tint(hex: string, amount: number): string {
  const [r, g, b] = toRgb(hex);
  return toHex(r + (255 - r) * amount, g + (255 - g) * amount, b + (255 - b) * amount);
}

/**
 * Mix `hex` toward black by `amount` (0 = original, 1 = black). Used to derive a
 * readable text colour for a soft badge (the colour itself is too light on a
 * tint). Returns RAW hex (no '#').
 */
export function shade(hex: string, amount: number): string {
  const [r, g, b] = toRgb(hex);
  return toHex(r * (1 - amount), g * (1 - amount), b * (1 - amount));
}

/** Relative luminance (0–1) — for picking black/white text on a fill. */
function luminance(hex: string): number {
  const [r, g, b] = toRgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Readable text colour (RAW hex) for text placed ON a solid `hex` fill. */
export function onColor(hex: string): string {
  return luminance(hex) > 0.55 ? EXPORT_HEX.foreground : "FFFFFF";
}
