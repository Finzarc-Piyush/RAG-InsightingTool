import type { DashboardTile } from "./types";

/**
 * Wave DR18A · per-tile height seeding.
 *
 * Pre-DR18A `placeTilesForCols` and `ensureLayoutsForTiles` both
 * stamped a fixed `h` (e.g. narrative = 10 grid rows) on every fresh
 * tile regardless of body length. A 4-line "Limitations" block got
 * the same ~320px slot as a 12-line "Key conclusion", leaving acres
 * of empty space inside the smaller card.
 *
 * `contentDrivenHeight` overrides `h` for narrative tiles only,
 * scaled to body length. Other tile kinds (chart / table / pivot /
 * insight / action) keep their fixed defaults — those have intrinsic
 * size from the chart/table content and don't benefit from text-based
 * sizing.
 *
 * The function is consulted ONLY at fresh-seed time. Persisted
 * layouts in `gridLayout` (user-resized tiles, edit-mode commits,
 * agent-emitted layouts) are respected by the existing
 * `ensureLayoutsForTiles` filter logic — `contentDrivenHeight` is
 * called only for tiles that don't already have a layout entry.
 */

interface BaseConfig {
  w: number;
  h: number;
  minW: number;
  minH: number;
}

const NARRATIVE_LINE_CHARS = 60;
const NARRATIVE_HEADER_PADDING_ROWS = 2;
const NARRATIVE_HEIGHT_CEILING_ROWS = 20;

export function contentDrivenHeight(
  tile: DashboardTile,
  baseConfig: BaseConfig,
  /** The width (in grid columns) the tile will actually be placed at. */
  effectiveW: number,
): number {
  if (tile.kind !== "narrative") return baseConfig.h;
  const body = tile.block?.body ?? "";
  // The narrative tile is `w: 6` of a 12-col grid by default. At
  // smaller column counts the rendered width shrinks proportionally,
  // so the line-wrap budget shrinks with it.
  const widthFactor = Math.max(effectiveW, 1) / Math.max(baseConfig.w, 1);
  const charsPerLine = Math.max(20, Math.round(NARRATIVE_LINE_CHARS * widthFactor));
  const approxLines = Math.ceil(body.length / charsPerLine);
  const computed = approxLines + NARRATIVE_HEADER_PADDING_ROWS;
  return Math.max(
    baseConfig.minH,
    Math.min(NARRATIVE_HEIGHT_CEILING_ROWS, computed),
  );
}
