/**
 * Wave S2 · aspect-ratio height for chart tiles.
 *
 * Pre-S2 every chart tile seeded at a fixed `h: 14` (≈ 448px) regardless of
 * how wide it was placed, so a 4-col chart reserved as much vertical space as
 * a 12-col one — leaving dead space and ragged alignment against content-sized
 * text tiles. `chartAspectRows` reserves a height proportional to the tile's
 * actual rendered width at a target aspect ratio, clamped to a sensible
 * [minRows, maxRows] window so charts stay usable (room for axes + the insight
 * footer) without towering.
 *
 * Pure + DOM-free: the tile's pixel width is derived from the grid geometry
 * (columns + margins + a reference canvas width), not measured — so it's safe
 * to call at fresh-seed time and unit-test deterministically.
 *
 * The actual math lives in the shared `chartRowsForSpan` authority so the SERVER
 * (which seeds chart-tile heights in dashboardTemplates) and this client
 * renderer compute the identical height for a given width — no drift. This
 * wrapper just adapts the client's (cols, rowHeight, [marginX, marginY]) call
 * shape to that authority.
 */
import { chartRowsForSpan } from "@/shared/dashboardLayout";

export interface ChartAspectOptions {
  /** target height / width ratio (landscape < 1). */
  ratio?: number;
  minRows?: number;
  maxRows?: number;
  /** reference dashboard canvas width in px (kept constant for determinism). */
  containerWidth?: number;
}

export function chartAspectRows(
  effectiveW: number,
  cols: number,
  rowHeight: number,
  gridMargin: [number, number],
  opts: ChartAspectOptions = {},
): number {
  return chartRowsForSpan(effectiveW, {
    columns: cols,
    rowHeight,
    marginX: gridMargin[0],
    marginY: gridMargin[1],
    containerWidth: opts.containerWidth,
    ratio: opts.ratio,
    minRows: opts.minRows,
    maxRows: opts.maxRows,
  });
}
