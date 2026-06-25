/**
 * ============================================================================
 * dashboardLayout.ts — THE authority for "how many charts + how wide each box"
 * ============================================================================
 * WHAT THIS FILE DOES
 *   One pure, deterministic place that DECIDES dashboard composition from the
 *   actual content instead of hardcoded numbers:
 *     - decideFeaturedCount  → how many charts an executive dashboard should
 *       feature, derived from the number of distinct analytical angles the turn
 *       produced (NOT a fixed 3).
 *     - planChartLayout      → the column SPAN + emphasis of each chart box,
 *       derived from the chart's natural width appetite (time-series/heatmap/
 *       many-category read wide; pie/scatter/small-bar read standard) and packed
 *       so the last row fills its width (no orphan gaps → aligned rows).
 *
 * WHY IT MATTERS
 *   This is the single seam the whole "executive dashboard is badly structured /
 *   limited to 3 charts" complaint hangs on. It is parameterised by `columns`
 *   so the SAME decision serves a 2-column inline CSS grid (chat answer) AND a
 *   12-column react-grid-layout canvas (saved /dashboard), and is imported by
 *   the server dashboard builder too — mirroring the codebase's "ONE authority"
 *   pattern (cf. temporalGrainAuthority, queryIntentAuthority).
 *
 * PURITY
 *   No DOM, no I/O, no Date/Math.random. Safe to unit-test and to run on both
 *   the server (tsx) and the client (vite). Types only from ./schema.js.
 */
import type { ChartSpec } from "./schema.js";

export type DashboardTemplate = "executive" | "deep_dive" | "monitoring";
// Mirrors queryIntentAuthority.DepthBudget (the canonical owner — invariant #12).
// Kept as a local structural copy ON PURPOSE: this module is bundled into the
// CLIENT and must stay free of any server/lib/agents/runtime dependency, so it
// does not import the authority. The unions are identical; if either ever gains
// a level, update both (tsc flags the mismatch at the buildDashboard call site).
export type DepthBudget = "minimal" | "standard" | "full";
export type ChartEmphasis = "hero" | "wide" | "standard";

export interface ChartLayoutItem {
  /** Column span on the caller's grid (1..columns). */
  span: number;
  emphasis: ChartEmphasis;
}

export interface PlanChartLayoutOptions {
  /** Grid width in columns: 2 for the inline CSS grid, 12 for react-grid-layout. */
  columns: number;
  /** Give the first chart a full-width "hero" box (executive template). */
  emphasizeFirst?: boolean;
}

// --- named thresholds (no magic numbers downstream) -------------------------

/** A comfortable upper bound on featured charts. 12-col grid = hero + rows of
 *  3-up reaches this in 3 rows; a 2-col inline grid reaches it in ~5 rows. */
export const GRID_FEATURED_MAX = 9;

/** A categorical bar/heatmap with more than this many categories reads better
 *  across a wide box than a cramped third-width one. */
const MANY_CATEGORIES = 12;

/** A multi-series chart with more than this many series needs a wide legend. */
const MANY_SERIES = 4;

// Span mapping onto a wide multi-column grid (≥ this many cols, = DASHBOARD_GRID
// .columns): a "wide" chart takes two-thirds, a "standard" one a third. Narrower
// grids (the 2-col inline answer) collapse to wide→full-row, standard→one column.
const WIDE_GRID_MIN_COLS = 12;
const WIDE_FRACTION = 2 / 3;
const STANDARD_FRACTION = 1 / 3;

/**
 * Stable identity of an analytical "angle": the metric (y) broken down by a
 * dimension (x) optionally split by a series, rendered as a given type. Used to
 * (a) COUNT how many genuinely-distinct views the turn produced and (b) DEDUPE
 * exact repeats during selection. Title is excluded (it varies cosmetically) —
 * distinct from `chartIdentityKey` in schema/charts.ts, which KEEPS the title
 * because it dedupes for persistence/rehydration, not analytical breadth.
 */
export function chartAngleKey(chart: Pick<ChartSpec, "type" | "x" | "y" | "seriesColumn">): string {
  return [chart.type, chart.x ?? "", chart.y ?? "", chart.seriesColumn ?? ""].join("::");
}

/** Distinct analytical angles among a set of charts. */
export function countDistinctAngles(charts: ReadonlyArray<ChartSpec>): number {
  const seen = new Set<string>();
  for (const c of charts) seen.add(chartAngleKey(c));
  return seen.size;
}

/**
 * How wide a chart WANTS to be, independent of the grid size.
 *   - line / area  → time-series, read left-to-right → wide.
 *   - heatmap      → a matrix → wide.
 *   - bar          → wide only when it has many categories or many series,
 *                    otherwise standard.
 *   - pie / scatter / small bar → standard.
 */
export function chartWidthAppetite(
  chart: Pick<ChartSpec, "type" | "data" | "seriesKeys">,
): "wide" | "standard" {
  const type = chart.type;
  if (type === "line" || type === "area" || type === "heatmap") return "wide";
  const categories = chart.data?.length ?? 0;
  const series = chart.seriesKeys?.length ?? 0;
  if (type === "bar" && (categories > MANY_CATEGORIES || series > MANY_SERIES)) return "wide";
  return "standard";
}

// --- chart height by placed width (aspect ratio) ----------------------------

/** The canonical dashboard grid geometry (react-grid-layout `lg` breakpoint).
 *  One source of truth so the SERVER (which seeds chart-tile heights) and the
 *  CLIENT renderer compute the identical height for a given width — no more
 *  "server says h:16, client says h:14" drift. */
export const DASHBOARD_GRID = { columns: 12, rowHeight: 32, marginX: 16, marginY: 16 } as const;

export interface ChartHeightGeometry {
  columns?: number;
  rowHeight?: number;
  marginX?: number;
  marginY?: number;
  /** Reference canvas width in px, held constant for deterministic sizing. */
  containerWidth?: number;
  /** Target height / width ratio (landscape < 1). */
  ratio?: number;
  minRows?: number;
  maxRows?: number;
}

const ASPECT_DEFAULTS = { containerWidth: 1200, ratio: 0.72, minRows: 11, maxRows: 16 } as const;

/**
 * Height (in grid rows) a chart tile should reserve for a given column `span`,
 * proportional to the tile's rendered width at a target aspect ratio, clamped
 * to a sensible [minRows, maxRows] window. Pure + DOM-free (width is derived
 * from grid geometry, not measured) so the server and client agree exactly.
 * A wider box gets a taller height; a narrow box stays short — which is what
 * stops charts from reserving a fixed tall slot and leaving dead space.
 */
export function chartRowsForSpan(span: number, geo: ChartHeightGeometry = {}): number {
  const columns = geo.columns ?? DASHBOARD_GRID.columns;
  const rowHeight = geo.rowHeight ?? DASHBOARD_GRID.rowHeight;
  const marginX = geo.marginX ?? DASHBOARD_GRID.marginX;
  const marginY = geo.marginY ?? DASHBOARD_GRID.marginY;
  const containerWidth = geo.containerWidth ?? ASPECT_DEFAULTS.containerWidth;
  const ratio = geo.ratio ?? ASPECT_DEFAULTS.ratio;
  const minRows = geo.minRows ?? ASPECT_DEFAULTS.minRows;
  const maxRows = geo.maxRows ?? ASPECT_DEFAULTS.maxRows;

  const safeCols = Math.max(columns, 1);
  const s = Math.max(1, Math.min(span, safeCols));
  // react-grid-layout column geometry: a tile spanning `s` columns also
  // reclaims the gutters between them.
  const colWidth = (containerWidth - marginX * (safeCols + 1)) / safeCols;
  const tileWidthPx = Math.max(0, colWidth * s + marginX * (s - 1));
  const targetHeightPx = tileWidthPx * ratio;
  const rows = Math.round((targetHeightPx + marginY) / (rowHeight + marginY));
  return Math.max(minRows, Math.min(maxRows, rows));
}

// Bar charts read top-to-bottom across many x-axis categories, so a span-derived
// aspect height (tuned for time-series/landscape) leaves them too short to tell
// adjacent bars apart without fullscreen. They get a taller FLOOR; a chart with
// many categories (cf. MANY_CATEGORIES) gets taller still. Non-bar types keep the
// pure aspect height. Floors only ever RAISE the aspect result and never exceed
// maxRows, so the pixel math in `chartRowsForSpan` stays the one authority.
const BAR_MIN_ROWS = 12; // ≈ 448px at rowHeight 32 + marginY 16
const MANY_CATEGORY_BAR_MIN_ROWS = 14; // ≈ 512px

/**
 * Height (in grid rows) a chart tile should reserve, aware of the chart TYPE.
 * Delegates the width→height pixel math to `chartRowsForSpan` (the one authority)
 * and applies a type-specific floor on top: bar charts get a taller minimum so
 * many-category bars stay readable on the dashboard grid without expanding.
 */
export function chartRowsForChart(
  chart: Pick<ChartSpec, "type" | "data" | "seriesKeys">,
  span: number,
  geo: ChartHeightGeometry = {},
): number {
  const base = chartRowsForSpan(span, geo); // the ONE pixel authority
  if (chart.type !== "bar") return base;
  const categories = chart.data?.length ?? 0;
  const floor = categories > MANY_CATEGORIES ? MANY_CATEGORY_BAR_MIN_ROWS : BAR_MIN_ROWS;
  const maxRows = geo.maxRows ?? ASPECT_DEFAULTS.maxRows;
  return Math.min(maxRows, Math.max(base, floor));
}

/**
 * Decide how many charts an executive dashboard should FEATURE — driven by the
 * data, not a constant. Starts from the count of distinct analytical angles and
 * softly bounds it by the depth budget and a per-template comfortable ceiling.
 * A single-chart turn features 1; a 2-angle turn features 2; a rich multi-
 * dimension turn features up to GRID_FEATURED_MAX.
 */
export function decideFeaturedCount(
  charts: ReadonlyArray<ChartSpec>,
  opts: { template?: DashboardTemplate; depthBudget?: DepthBudget } = {},
): number {
  const n = charts.length;
  if (n <= 1) return n;
  const distinct = countDistinctAngles(charts);

  // A quick lookup shouldn't sprawl; a deep ask earns full breadth. Dashboards
  // are intentional asks, so the default when depth is unknown is generous.
  const depthBudget = opts.depthBudget ?? "full";
  const depthCap =
    depthBudget === "minimal" ? 3 : depthBudget === "standard" ? 6 : GRID_FEATURED_MAX;

  // Every template gets the full ceiling — "executive" is no longer throttled
  // to a thin top-3 skim; it features as many distinct angles as the data has.
  const templateCap = GRID_FEATURED_MAX;

  return Math.max(1, Math.min(distinct, depthCap, templateCap, n));
}

/**
 * Select WHICH charts to feature, in reading order, deduping exact repeats.
 * Priority preserved from the legacy picker: a "Top drivers of…" tile leads,
 * then the first time-series, then breadth in emission order.
 */
export function selectFeaturedCharts(
  charts: ReadonlyArray<ChartSpec>,
  count: number,
): ChartSpec[] {
  const seen = new Set<string>();
  const out: ChartSpec[] = [];
  const push = (c: ChartSpec) => {
    const k = chartAngleKey(c);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(c);
  };

  const topDrivers = charts.find((c) =>
    (c.title ?? "").toLowerCase().startsWith("top drivers of"),
  );
  if (topDrivers) push(topDrivers);

  const temporal = charts.find((c) => c.type === "line" || c.type === "area");
  if (temporal) push(temporal);

  for (const c of charts) {
    if (out.length >= count) break;
    push(c);
  }
  return out.slice(0, Math.max(0, count));
}

/**
 * Plan per-chart column spans for a grid `columns` wide. Width follows each
 * chart's appetite; the first chart is a full-width hero when `emphasizeFirst`.
 * The LAST ROW is stretched to fill the grid width so rows never leave an
 * orphan gap — the root cause of the "ragged / misaligned" look.
 */
export function planChartLayout(
  charts: ReadonlyArray<ChartSpec>,
  { columns, emphasizeFirst = false }: PlanChartLayoutOptions,
): ChartLayoutItem[] {
  const cols = Math.max(1, Math.floor(columns));
  if (charts.length === 0) return [];

  // Map the abstract appetite onto this grid's width (8-of-12 / 4-of-12 on the
  // dashboard grid; full-row / single-column on the 2-col inline grid).
  const wideSpan = cols >= WIDE_GRID_MIN_COLS ? Math.round(cols * WIDE_FRACTION) : cols;
  const stdSpan =
    cols >= WIDE_GRID_MIN_COLS ? Math.round(cols * STANDARD_FRACTION) : cols >= 2 ? 1 : cols;

  const items: ChartLayoutItem[] = charts.map((chart, i) => {
    if (emphasizeFirst && i === 0) return { span: cols, emphasis: "hero" };
    const appetite = chartWidthAppetite(chart);
    return appetite === "wide"
      ? { span: wideSpan, emphasis: "wide" }
      : { span: stdSpan, emphasis: "standard" };
  });

  for (const it of items) it.span = Math.max(1, Math.min(cols, it.span));
  fillRows(items, cols);
  return items;
}

/**
 * Stretch each row's items so their spans sum to the full grid width — every
 * row, not just the last — distributing leftover columns evenly left-to-right.
 * This guarantees no orphan gap on any row (the root of the "ragged / mis-
 * aligned" look): a lone box on its row becomes full-width rather than leaving
 * a hole. Mutates `items` in place.
 */
function fillRows(items: ChartLayoutItem[], cols: number): void {
  // Group items into rows by greedy left-to-right packing, then fill each row.
  let row: ChartLayoutItem[] = [];
  let acc = 0;
  const flush = () => {
    let remaining = cols - acc;
    let idx = 0;
    while (remaining > 0 && row.length > 0) {
      row[idx % row.length]!.span += 1;
      remaining--;
      idx++;
    }
    row = [];
    acc = 0;
  };

  for (const it of items) {
    if (acc + it.span > cols) flush();
    row.push(it);
    acc += it.span;
  }
  flush();
}
