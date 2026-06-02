/**
 * Wave-FA · Pure model helpers for the dataset preview pane.
 *
 * Kept free of React/DOM so the column-sizing, caption, and cell-text rules
 * are unit-testable under the client's node-environment vitest runner (no
 * jsdom). `DatasetPreviewPane` is the only consumer.
 */
import { formatDateCellForGrain } from "@/lib/temporalDisplayFormat";
import type { TemporalDisplayGrain } from "@/shared/schema";

export type PreviewMode = "200" | "full";

export const COL_MIN_PX = 112;
export const COL_MAX_PX = 360;
const COL_CHAR_PX = 7.5;
const COL_PAD_PX = 28;
const WIDTH_SAMPLE_ROWS = 60;

/**
 * Estimate a per-column pixel width from the header plus a sample of cell
 * strings, clamped to [COL_MIN_PX, COL_MAX_PX]. Header and body rows apply the
 * same widths, so the exact value only needs to be consistent, not precise.
 */
export function estimateColumnWidth(
  column: string,
  rows: Record<string, unknown>[]
): number {
  let maxLen = column.length;
  const n = Math.min(rows.length, WIDTH_SAMPLE_ROWS);
  for (let i = 0; i < n; i++) {
    const v = rows[i]?.[column];
    if (v === null || v === undefined) continue;
    const len = String(v).length;
    if (len > maxLen) maxLen = len;
  }
  const px = maxLen * COL_CHAR_PX + COL_PAD_PX;
  return Math.max(COL_MIN_PX, Math.min(COL_MAX_PX, Math.round(px)));
}

export interface PreviewCaptionInput {
  mode: PreviewMode;
  /** Rows actually rendered (after the server slice / cap). */
  shown: number;
  /** Total rows surviving the filter. */
  filteredRows: number;
  /** True when the full set was capped at the server limit. */
  truncated?: boolean;
  /** Human label for the cap, e.g. "50,000". */
  capLabel: string;
}

/** Footer caption describing how much of the filtered set is on screen. */
export function buildPreviewCaption({
  mode,
  shown,
  filteredRows,
  truncated,
  capLabel,
}: PreviewCaptionInput): string {
  const s = shown.toLocaleString();
  const t = filteredRows.toLocaleString();
  if (mode === "full") {
    return truncated
      ? `Showing first ${s} of ${t} rows (capped at ${capLabel})`
      : `Showing all ${s} of ${t} rows`;
  }
  return `Showing first ${s} of ${t} rows matching`;
}

/**
 * Resolve the display text for a cell. Returns `null` to signal the caller
 * should render the muted "null" placeholder (empty / missing values).
 * Mirrors the dataset-variant rules in `DataPreviewTable`: dates are
 * grain-formatted, everything else is shown raw.
 */
export function resolvePreviewCellText(
  raw: unknown,
  isDate: boolean,
  grain: TemporalDisplayGrain | undefined
): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (isDate) {
    const formatted = grain !== undefined ? formatDateCellForGrain(raw, grain) : null;
    return formatted ?? String(raw);
  }
  return String(raw);
}
