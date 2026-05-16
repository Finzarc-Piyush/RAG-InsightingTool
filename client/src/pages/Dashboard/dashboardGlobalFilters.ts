/**
 * Wave DR4 · pure helpers for the dashboard-level global filter bar.
 *
 * Three responsibilities:
 *
 *   1. translate a captured `ActiveFilterSpec` (the session-time filter
 *      snapshotted on the dashboard at creation) into the
 *      `ActiveChartFilters` shape that ChartRenderer already consumes
 *   2. partition the global filter per tile — split into "applicable"
 *      (columns present in this tile's data) and "inapplicable" (columns
 *      the tile cannot honor). The inapplicable list drives the chip
 *      shown on tile headers explaining why a filter doesn't bite there.
 *   3. score columns across tiles by frequency so the filter bar UI can
 *      surface the most useful filterable dimensions first.
 *
 * No React, no async, no DOM. Tested in node via vitest.
 */
import type { ActiveFilterSpec, ActiveFilterCondition } from "@/shared/schema";
import type {
  ActiveChartFilters,
  CategoricalFilterSelection,
  ChartFilterDefinition,
  ChartFilterSelection,
  DateFilterSelection,
  NumericFilterSelection,
} from "@/lib/chartFilters";
import { deriveChartFilterDefinitions } from "@/lib/chartFilters";
import type { DashboardTile } from "./types";

/**
 * Returns the column keys present in a chart tile's bundled data. Other
 * tile kinds (narrative, table, pivot, insight, action) return an empty
 * list — global filters never apply to them, so they always render in
 * the inapplicable list when surfacing badges.
 */
export function extractTileColumns(tile: DashboardTile): string[] {
  if (tile.kind !== "chart") return [];
  const rows = tile.chart.data;
  if (!rows || rows.length === 0) return [];
  // Union of keys across rows in case some are sparse.
  const keys = new Set<string>();
  for (const row of rows) {
    if (!row) continue;
    for (const k of Object.keys(row)) keys.add(k);
  }
  return Array.from(keys);
}

/**
 * Translate a captured ActiveFilterSpec into ChartRenderer's ActiveChartFilters.
 *
 * - `kind: 'in'`     → categorical with the recorded values
 * - `kind: 'range'`  → numeric (when min/max are numeric coercible)
 * - `kind: 'dateRange'` → date with from/to
 *
 * Conditions whose shape can't be expressed in ActiveChartFilters
 * (e.g. mixed strings + numbers in a range) are skipped silently — the
 * pre-fill is a starting point, not a contract. Callers may still surface
 * the captured-filter chip (DR2) for the full provenance.
 */
export function capturedActiveFilterToChartFilters(
  spec: ActiveFilterSpec | undefined,
): ActiveChartFilters {
  const out: ActiveChartFilters = {};
  if (!spec || !spec.conditions) return out;
  for (const c of spec.conditions) {
    const sel = conditionToSelection(c);
    if (sel) out[c.column] = sel;
  }
  return out;
}

function conditionToSelection(
  c: ActiveFilterCondition,
): ChartFilterSelection | undefined {
  if (c.kind === "in") {
    if (!c.values || c.values.length === 0) return undefined;
    return { type: "categorical", values: [...c.values] };
  }
  if (c.kind === "range") {
    const min = numericOrUndefined(c.min);
    const max = numericOrUndefined(c.max);
    if (min === undefined && max === undefined) return undefined;
    return { type: "numeric", min, max };
  }
  if (c.kind === "dateRange") {
    const start = stringOrUndefined(c.from);
    const end = stringOrUndefined(c.to);
    if (start === undefined && end === undefined) return undefined;
    return { type: "date", start, end };
  }
  return undefined;
}

function numericOrUndefined(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function stringOrUndefined(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = typeof v === "string" ? v : String(v);
  return s.length > 0 ? s : undefined;
}

/**
 * Split a `global` filter into the subset whose columns appear in this
 * tile's data (`applicable`) and the columns missing from the tile
 * (`inapplicableColumns`). The applicable subset is what we hand to
 * ChartRenderer; the inapplicable list is what the tile chrome surfaces
 * as "Region filter doesn't apply here".
 *
 * Per-tile override beats global — if `perTile` is set for this tile,
 * it wins outright and the inapplicable list is empty (the user
 * deliberately chose what to apply).
 */
export interface GlobalForTileResult {
  applicable: ActiveChartFilters;
  inapplicableColumns: string[];
}

export function globalForTile(
  tile: DashboardTile,
  global: ActiveChartFilters,
  perTile?: ActiveChartFilters,
): GlobalForTileResult {
  if (perTile) {
    return { applicable: perTile, inapplicableColumns: [] };
  }
  const cols = new Set(extractTileColumns(tile));
  const applicable: ActiveChartFilters = {};
  const inapplicable: string[] = [];
  for (const [col, sel] of Object.entries(global)) {
    if (!sel) continue;
    if (cols.has(col)) {
      applicable[col] = sel;
    } else {
      inapplicable.push(col);
    }
  }
  return { applicable, inapplicableColumns: inapplicable };
}

/**
 * Across all tiles, return columns that appear in at least one chart's
 * data, with their frequency and total tile count so the filter bar can
 * sort + show "applies to N of M" hints.
 */
export interface DashboardFilterableColumn {
  column: string;
  appearsInTiles: number;
  totalChartTiles: number;
}

export function dashboardFilterableColumns(
  tiles: DashboardTile[],
): DashboardFilterableColumn[] {
  const chartTiles = tiles.filter((t) => t.kind === "chart");
  const totalChartTiles = chartTiles.length;
  const counts = new Map<string, number>();
  for (const t of chartTiles) {
    const cols = extractTileColumns(t);
    for (const c of cols) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([column, appearsInTiles]) => ({
      column,
      appearsInTiles,
      totalChartTiles,
    }))
    .sort((a, b) => b.appearsInTiles - a.appearsInTiles || a.column.localeCompare(b.column));
}

/**
 * Wave WD1 · merge rows from every chart tile into a single dataset for
 * filter-definition inference. Capped at `maxRows` per tile to keep
 * downstream `deriveChartFilterDefinitions` work bounded — categorical
 * distinct-value detection and date-range/numeric-range stats converge
 * fast, so 2000 rows per tile is more than enough for the picker.
 *
 * Pure — no DOM, no async.
 */
export function aggregateTileRowsForFiltering(
  tiles: DashboardTile[],
  maxRowsPerTile = 2000,
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const tile of tiles) {
    if (tile.kind !== "chart") continue;
    const rows = tile.chart.data;
    if (!rows || rows.length === 0) continue;
    const slice = rows.slice(0, maxRowsPerTile);
    for (const r of slice) {
      if (r && typeof r === "object") {
        out.push(r as Record<string, unknown>);
      }
    }
  }
  return out;
}

/**
 * Wave WD1 · returns the set of `ChartFilterDefinition`s available to
 * add via the global filter bar's `+ Add filter` button. Excludes any
 * column currently active in `currentGlobal` (re-adding an active filter
 * is handled by the chip's edit affordance, not Add). Sorted by column
 * frequency across tiles so the most useful filterable dimensions
 * surface first.
 *
 * When all chart tiles are empty / no chart tiles exist, returns [].
 *
 * Pure — no DOM, no async.
 */
export function availableFilterDefinitions(
  tiles: DashboardTile[],
  currentGlobal: ActiveChartFilters,
): ChartFilterDefinition[] {
  const aggregated = aggregateTileRowsForFiltering(tiles);
  if (aggregated.length === 0) return [];
  const defs = deriveChartFilterDefinitions(aggregated);
  const taken = new Set(
    Object.entries(currentGlobal)
      .filter(([, sel]) => !!sel)
      .map(([col]) => col),
  );
  const filtered = defs.filter((d) => !taken.has(d.key));
  // Order by frequency across tiles: columns present in more tiles first.
  const freq = new Map<string, number>(
    dashboardFilterableColumns(tiles).map((c) => [c.column, c.appearsInTiles]),
  );
  return filtered.sort((a, b) => {
    const fa = freq.get(a.key) ?? 0;
    const fb = freq.get(b.key) ?? 0;
    if (fa !== fb) return fb - fa;
    return a.key.localeCompare(b.key);
  });
}

/**
 * Wave WD1 · pure helpers that produce the next `ActiveChartFilters`
 * state given a column + the user's selection from the picker. Used by
 * the `AddFilterPopover` on confirm. Three variants — one per filter
 * kind — keep call sites type-safe and avoid an `unknown` middle-state.
 */
export function addCategoricalFilter(
  current: ActiveChartFilters,
  column: string,
  values: string[],
): ActiveChartFilters {
  if (values.length === 0) return current;
  const sel: CategoricalFilterSelection = {
    type: "categorical",
    values: [...values],
  };
  return { ...current, [column]: sel };
}

export function addNumericFilter(
  current: ActiveChartFilters,
  column: string,
  min: number | undefined,
  max: number | undefined,
): ActiveChartFilters {
  if (min === undefined && max === undefined) return current;
  const sel: NumericFilterSelection = { type: "numeric" };
  if (min !== undefined) sel.min = min;
  if (max !== undefined) sel.max = max;
  return { ...current, [column]: sel };
}

export function addDateFilter(
  current: ActiveChartFilters,
  column: string,
  start: string | undefined,
  end: string | undefined,
): ActiveChartFilters {
  if (!start && !end) return current;
  const sel: DateFilterSelection = { type: "date" };
  if (start) sel.start = start;
  if (end) sel.end = end;
  return { ...current, [column]: sel };
}
