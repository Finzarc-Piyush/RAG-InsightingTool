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
 */

export interface ChartAspectOptions {
  /** target height / width ratio (landscape < 1). */
  ratio?: number;
  minRows?: number;
  maxRows?: number;
  /** reference dashboard canvas width in px (kept constant for determinism). */
  containerWidth?: number;
}

const DEFAULT_CONTAINER_WIDTH = 1200;
const DEFAULT_RATIO = 0.62;
const DEFAULT_MIN_ROWS = 9;
const DEFAULT_MAX_ROWS = 16;

export function chartAspectRows(
  effectiveW: number,
  cols: number,
  rowHeight: number,
  gridMargin: [number, number],
  opts: ChartAspectOptions = {},
): number {
  const {
    ratio = DEFAULT_RATIO,
    minRows = DEFAULT_MIN_ROWS,
    maxRows = DEFAULT_MAX_ROWS,
    containerWidth = DEFAULT_CONTAINER_WIDTH,
  } = opts;

  const [marginX, marginY] = gridMargin;
  const safeCols = Math.max(cols, 1);
  const span = Math.max(1, Math.min(effectiveW, safeCols));

  // react-grid-layout column geometry: usable width is the canvas minus the
  // inter/outer column gutters; a tile spanning `span` columns also reclaims
  // the gutters between those columns.
  const colWidth = (containerWidth - marginX * (safeCols + 1)) / safeCols;
  const tileWidthPx = Math.max(0, colWidth * span + marginX * (span - 1));

  const targetHeightPx = tileWidthPx * ratio;
  // Convert px → grid rows: each extra row adds (rowHeight + marginY) px.
  const rows = Math.round((targetHeightPx + marginY) / (rowHeight + marginY));

  return Math.max(minRows, Math.min(maxRows, rows));
}
