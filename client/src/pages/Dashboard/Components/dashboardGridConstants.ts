/**
 * W-SBGRID · shared react-grid-layout primitives.
 *
 * The dashboard now has TWO free-form grids: the chart/table/narrative tile
 * canvas (`DashboardTiles`) and the Executive-Summary card canvas
 * (`DashboardSummaryGrid`). They MUST share the same breakpoints / column
 * counts / row height / gutters so a 4-wide tile means the same thing on both —
 * so those constants (and the `WidthProvider(Responsive)` wrapper + the RGL CSS
 * side-effect imports) live here, imported by both. Don't re-declare them.
 */
import { Responsive, WidthProvider } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";

export const ResponsiveGridLayout = WidthProvider(Responsive);

export const GRID_COLS = { lg: 12, md: 10, sm: 6, xs: 4, xxs: 2 } as const;
export const GRID_ROW_HEIGHT = 32;
// DR8 · tight gutters give the canvas a denser, dashboard-grade feel.
export const GRID_MARGIN: [number, number] = [16, 16];

/** All 8 edges, fresh array per call (the RGL prop wants a mutable array). */
export const allResizeHandles = (): Array<"s" | "e" | "n" | "w" | "se" | "sw" | "ne" | "nw"> => [
  "s",
  "e",
  "n",
  "w",
  "se",
  "sw",
  "ne",
  "nw",
];
