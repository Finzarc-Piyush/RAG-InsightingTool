/**
 * W10 · Brand tokens for the PPTX export.
 *
 * PPTX is static, so we can't read the live Tailwind tokens at render time.
 * Instead this file declares the canonical hex values used by the export
 * pipeline; if brand tokens change, update them here once.
 *
 * Hex values are sourced from the in-app dark/light theme tokens defined in
 * `client/src/index.css` (kept aligned by inspection — see THEMING.md).
 */

export const EXPORT_BRAND = {
  /** Cover/title accent + primary headers. */
  primary: '0B63F6',
  /** Body text on light backgrounds. */
  foreground: '111827',
  /** Slide titles. */
  title: '1F2937',
  /** Footer / page numbers. */
  muted: '6B7280',
  /** Section dividers / table grid. */
  border: 'D1D5DB',
  /** Slide background. */
  background: 'FFFFFF',
  /** Confidence chips and KPI accent. */
  accent: '0EA5E9',
  /** "Now" horizon recommendation chip. */
  horizonNow: 'EF4444',
  /** "This quarter" horizon. */
  horizonQuarter: 'F59E0B',
  /** "Strategic" horizon. */
  horizonStrategic: '10B981',
} as const;

/** Inter is the in-app default; PPTX falls back to the system if unavailable. */
export const EXPORT_FONT_FAMILY = 'Inter';

/** Pixel ratio used by html-to-image when rasterizing tiles. 5× delivers
 *  print-grade DPI in PPTX while staying under the file-size sweet spot. */
export const EXPORT_PIXEL_RATIO = 5;

/** Standard 16:9 wide PowerPoint slide in inches. */
export const SLIDE_WIDTH_IN = 13.33;
export const SLIDE_HEIGHT_IN = 7.5;
