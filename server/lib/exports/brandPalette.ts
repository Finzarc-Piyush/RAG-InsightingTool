/**
 * brandPalette.ts — single source of truth for the export renderers' brand colors.
 *
 * The PPTX, PDF, and ECharts-SSR masters each used to inline the SAME hex
 * values (the pptx master's own comment flagged "three sources of truth is one
 * too many"). This module owns the canonical raw hex once. Each master keeps
 * its own local BRAND object (its exact key set + its '#'-vs-no-'#' convention —
 * pptxgenjs wants bare hex, ECharts/@react-pdf want '#'-prefixed) but builds the
 * VALUES from here, so a palette change lands in one place.
 *
 * Pure leaf module: no imports.
 */

/** Canonical brand hex, RAW (no '#'). */
export const EXPORT_HEX = {
  primary: "0B63F6",
  accent: "0EA5E9",
  foreground: "111827",
  muted: "6B7280",
  border: "D1D5DB",
  background: "FFFFFF",
  surfaceMuted: "F8FAFC",
  horizonNow: "EF4444",
  horizonThisQuarter: "F59E0B",
  horizonStrategic: "10B981",
} as const;

/**
 * 8-step categorical palette, RAW (no '#'). Matches the first 8 of the in-app
 * 12-color `--chart-*` cycle in `client/src/index.css`.
 */
export const EXPORT_CATEGORICAL = [
  "0B63F6", // primary blue
  "0EA5E9", // sky
  "10B981", // emerald
  "F59E0B", // amber
  "EF4444", // red
  "8B5CF6", // violet
  "EC4899", // pink
  "14B8A6", // teal
] as const;

/** Prefix a raw hex with '#'. */
export const withHash = (h: string): string => `#${h}`;

/** Categorical palette '#'-prefixed (ECharts-SSR / @react-pdf convention). */
export const EXPORT_CATEGORICAL_HEX = EXPORT_CATEGORICAL.map(withHash);
