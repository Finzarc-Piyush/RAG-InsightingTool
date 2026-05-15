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
  ChartFilterSelection,
} from "@/lib/chartFilters";
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
