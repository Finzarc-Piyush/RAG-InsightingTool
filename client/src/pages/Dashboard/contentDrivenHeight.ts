import type { DashboardTile } from "./types";
import { chartAspectRowsForChart } from "./lib/chartTileHeight";

/** Grid geometry needed to size chart tiles by aspect ratio (Wave S2/S3). */
export interface GridGeometry {
  cols: number;
  rowHeight: number;
  gridMargin: [number, number];
}

/**
 * Wave DR18A · per-tile height seeding (extended in Wave S1).
 *
 * Pre-DR18A `placeTilesForCols` and `ensureLayoutsForTiles` stamped a fixed
 * `h` on every fresh tile regardless of content, leaving acres of empty space
 * inside short cards (a 4-line "Limitations" got the same slot as a 12-line
 * "Key conclusion").
 *
 * `contentDrivenHeight` overrides `h` for CONTENT-bearing tiles, scaled to the
 * rendered content:
 *   - narrative / insight / action → text length (line-wrap estimate)
 *   - table → header + data-row count, capped to the inner scroll envelope
 *   - chart → aspect-ratio height (see ./lib/chartTileHeight via DashboardTiles)
 *   - pivot → keeps its fixed default (intrinsic pivot-grid sizing)
 *
 * Consulted ONLY at fresh-seed time. Persisted layouts (`gridLayout`, user
 * resizes, agent-emitted layouts) are respected by `ensureLayoutsForTiles`'
 * filter logic — `contentDrivenHeight` only runs for tiles lacking a layout
 * entry, so a manual resize is never stomped.
 */

interface BaseConfig {
  w: number;
  h: number;
  minW: number;
  minH: number;
}

// ~chars that fit on one rendered line per grid column. A w=6 narrative tile
// holds ~60 chars/line; a w=4 insight tile ~40. (Equivalent to the original
// DR18A `60 * effectiveW/6` for narratives, generalised to any base width.)
const CHARS_PER_GRID_COL = 10;
const TEXT_HEADER_PADDING_ROWS = 2;
const HEIGHT_CEILING_ROWS = 20;

// Tables: title + column header + a little padding, then one grid row per data
// row, capped so a huge table doesn't reserve dead space — the inner
// `max-h-[220px]` scroller (≈ 8 rows) takes over beyond the cap.
const TABLE_HEADER_ROWS = 3;
const TABLE_ROW_CEILING = 8;

function textRows(body: string, baseConfig: BaseConfig, effectiveW: number): number {
  const charsPerLine = Math.max(20, Math.round(effectiveW * CHARS_PER_GRID_COL));
  const approxLines = Math.ceil(body.length / charsPerLine);
  const computed = approxLines + TEXT_HEADER_PADDING_ROWS;
  return Math.max(baseConfig.minH, Math.min(HEIGHT_CEILING_ROWS, computed));
}

export function contentDrivenHeight(
  tile: DashboardTile,
  baseConfig: BaseConfig,
  /** The width (in grid columns) the tile will actually be placed at. */
  effectiveW: number,
  /** Grid geometry — when provided, chart tiles size by aspect ratio (S3). */
  grid?: GridGeometry,
): number {
  switch (tile.kind) {
    case "narrative":
      // A2 · the narrative ("Key conclusion") tile sizes to its text, with the
      // tile's DEFAULT height as the hard ceiling ("only have this current
      // height as max height"). Longer bodies cap here and scroll inside the
      // card rather than reserving a taller-than-default slot.
      return Math.min(
        textRows(tile.block?.body ?? "", baseConfig, effectiveW),
        baseConfig.h,
      );
    case "insight":
      return textRows(tile.narrative ?? "", baseConfig, effectiveW);
    case "action":
      return textRows(tile.recommendation ?? "", baseConfig, effectiveW);
    case "table": {
      const rowCount = tile.table?.rows?.length ?? 0;
      const computed = TABLE_HEADER_ROWS + Math.min(rowCount, TABLE_ROW_CEILING);
      return Math.max(baseConfig.minH, Math.min(HEIGHT_CEILING_ROWS, computed));
    }
    case "chart":
      // Aspect-ratio height when grid geometry is known; otherwise keep the
      // fixed default (back-compat for callers that don't pass geometry).
      // Type-aware so bar charts get the taller floor (chartRowsForChart).
      return grid && tile.chart
        ? chartAspectRowsForChart(
            tile.chart,
            effectiveW,
            grid.cols,
            grid.rowHeight,
            grid.gridMargin,
          )
        : baseConfig.h;
    default:
      // pivot keeps its fixed default (intrinsic pivot-grid sizing).
      return baseConfig.h;
  }
}
