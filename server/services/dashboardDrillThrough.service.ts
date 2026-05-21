/**
 * Wave WD3-server · server-side filter for dashboard drill-through requests.
 *
 * Closes the round-trip for the WD3 drill-through family. The client
 * dispatches a `DRILL_THROUGH_EVENT` when the user cmd / ctrl-clicks a
 * chart mark; the DashboardView listener opens the side-sheet with the
 * event detail; this endpoint returns the underlying rows for the
 * (chart, column, value) pin under the active filter snapshot. The
 * sheet's previous placeholder body gets replaced with a TanStack-
 * Query-fetched row list.
 *
 * Pure-fn at the bottom of this file (`filterChartRowsForDrill`) so it
 * can be unit-tested without the express route wrapper. The controller
 * thread is just auth + dashboard-lookup + 4xx/5xx mapping.
 *
 * The chart-by-id lookup mirrors the existing XLSX export endpoint's
 * approach: charts inside a dashboard are identified by tileId
 * (`chart-${index}` per sheet — same convention as the client's
 * `DashboardView.tsx` derivation).
 *
 * Wave WD3-server-sheetId-resolution · `findChartByTileId` accepts an
 * optional `sheetId` to disambiguate the per-sheet chartId on multi-
 * sheet dashboards. With `sheetId` the lookup is scoped to that sheet
 * (returns null if the sheetId doesn't match any sheet OR that sheet
 * has no chart at the index); without `sheetId` the legacy walk-across-
 * sheets behaviour returns the first match (backwards-compat for
 * shareable URLs that pre-date the disambiguation wave).
 */

import type { Dashboard, ChartSpec } from "../shared/schema.js";

// ── Type definitions (mirror the client's drillThrough.ts) ─────────

export interface DrillThroughPin {
  column: string;
  value: unknown;
}

export interface CategoricalFilterSelection {
  type: "categorical";
  values: string[];
}
export interface DateFilterSelection {
  type: "date";
  start?: string;
  end?: string;
}
export interface NumericFilterSelection {
  type: "numeric";
  min?: number;
  max?: number;
}
export type ChartFilterSelection =
  | CategoricalFilterSelection
  | DateFilterSelection
  | NumericFilterSelection;

export type ActiveChartFilters = Record<string, ChartFilterSelection | undefined>;

export interface DrillThroughRequest {
  /** Primary pin column (matches `DrillThroughEvent.column`). */
  column: string;
  /** Primary pin value. */
  value: unknown;
  /** Additional pins (for multi-dim drill targets — heatmap row × col). */
  extraPins?: DrillThroughPin[];
  /** Active filters at click time. Applied BEFORE pinning. */
  filters?: ActiveChartFilters;
  /**
   * Wave WD3-server-sheetId-resolution · optional sheet id that scopes
   * the chartId lookup to a specific sheet on multi-sheet dashboards.
   * When omitted, the legacy walk-across-sheets behaviour is preserved
   * (backwards-compat for shareable URLs that pre-date this wave).
   * Captured at click time on the client so the resolution context
   * survives subsequent sheet navigation while the side-sheet is open.
   */
  sheetId?: string;
}

export interface DrillThroughResponse {
  rows: Array<Record<string, unknown>>;
  /** Total rows that matched the request, BEFORE the cap. */
  totalMatched: number;
  /** True iff `totalMatched > rows.length` (the cap clipped the result). */
  capApplied: boolean;
  /** Lightweight chart metadata for the sheet display. */
  chart: { title: string; tileId: string };
}

/** Default row-count cap. A drill on a large categorical bucket could otherwise return 10K+ rows. */
export const DRILL_ROW_CAP = 1000;

// ── Pure helpers ────────────────────────────────────────────────────

/**
 * Stringify a raw value for comparison. Mirrors `toFilterValue` from
 * the client's `crossFilter.ts` so server-side comparison matches the
 * client's wire-storage stringification: null / undefined → "null";
 * numbers / booleans / Dates → String(v); strings pass through.
 */
function stringifyForComparison(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "string") return v;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/**
 * Row matches a single pin (column = value) if the row's stringified
 * value at `column` equals the stringified `value`. Mirrors the
 * client's categorical filter comparison logic in `applyChartFilters`.
 */
function rowMatchesPin(
  row: Record<string, unknown>,
  pin: DrillThroughPin,
): boolean {
  return stringifyForComparison(row[pin.column]) === stringifyForComparison(pin.value);
}

/**
 * Row matches a `ChartFilterSelection`. Ported from the client's
 * `applyChartFilters` semantics: categorical = value-in-set;
 * numeric = value-in-range; date = ISO-prefix comparison.
 */
function rowMatchesFilter(
  row: Record<string, unknown>,
  column: string,
  selection: ChartFilterSelection,
): boolean {
  const value = row[column];

  if (selection.type === "categorical") {
    if (!selection.values || selection.values.length === 0) return true;
    const stringValue = stringifyForComparison(value);
    return selection.values.includes(stringValue);
  }

  if (selection.type === "numeric") {
    if (selection.min === undefined && selection.max === undefined) return true;
    if (typeof value !== "number" || Number.isNaN(value)) return false;
    if (selection.min !== undefined && value < selection.min) return false;
    if (selection.max !== undefined && value > selection.max) return false;
    return true;
  }

  // date: compare as ISO strings (YYYY-MM-DD lexicographic order is
  // also temporal order). Lazy: don't parse / normalize timezones —
  // matches the wire-storage shape on dashboard.globalFilters.
  if (!selection.start && !selection.end) return true;
  const iso =
    value instanceof Date
      ? value.toISOString()
      : typeof value === "string"
        ? value
        : null;
  if (iso === null) return false;
  if (selection.start && iso < selection.start) return false;
  if (selection.end && iso > selection.end) return false;
  return true;
}

/**
 * Find a chart by its tileId (e.g. `chart-3`) within a dashboard.
 *
 * Wave WD3-server-sheetId-resolution · when `sheetId` is provided, the
 * lookup is scoped to that specific sheet — returns null if no sheet
 * matches the id OR if the target sheet has no chart at the index.
 * Without `sheetId` the legacy walk returns the first match across all
 * sheets (preserves resolution for shareable URLs that carry chartId
 * but no sheetId). Same `chart-${index}` convention as the client's
 * `DashboardView.tsx` tile derivation.
 */
export function findChartByTileId(
  dashboard: Dashboard,
  tileId: string,
  sheetId?: string,
): ChartSpec | null {
  // Parse `chart-${idx}`. Anything else → null (invalid tileId).
  const match = /^chart-(\d+)$/.exec(tileId);
  if (!match) return null;
  const idx = Number(match[1]);
  if (!Number.isFinite(idx) || idx < 0) return null;
  const sheets = dashboard.sheets || [];
  if (sheetId !== undefined) {
    // Scoped lookup: find the named sheet, then look up chart-${idx}
    // in it. A stale sheetId (sheet deleted since the click was made)
    // resolves to null rather than silently falling back to a
    // different sheet's chart — predictable failure beats silent
    // mis-resolution.
    const targetSheet = sheets.find((sheet) => sheet.id === sheetId);
    if (!targetSheet) return null;
    return (targetSheet.charts || [])[idx] ?? null;
  }
  for (const sheet of sheets) {
    const chart = (sheet.charts || [])[idx];
    if (chart) return chart;
  }
  return null;
}

/**
 * Apply the drill request to a chart's rows: filters first, then the
 * primary pin, then each extra pin (AND-intersection). Cap at
 * `DRILL_ROW_CAP`. Pure function — testable without a real dashboard.
 */
export function filterChartRowsForDrill(
  chartRows: Array<Record<string, unknown>>,
  request: DrillThroughRequest,
): Pick<DrillThroughResponse, "rows" | "totalMatched" | "capApplied"> {
  const filters = request.filters ?? {};
  const primaryPin: DrillThroughPin = { column: request.column, value: request.value };
  const extraPins = request.extraPins ?? [];

  const matching: Array<Record<string, unknown>> = [];
  for (const row of chartRows) {
    // Active filters BEFORE pins (mirrors the brief's "server applies
    // filters first, then pin").
    let passed = true;
    for (const [column, selection] of Object.entries(filters)) {
      if (!selection) continue;
      if (!rowMatchesFilter(row, column, selection)) {
        passed = false;
        break;
      }
    }
    if (!passed) continue;
    if (!rowMatchesPin(row, primaryPin)) continue;
    let extraOk = true;
    for (const pin of extraPins) {
      if (!rowMatchesPin(row, pin)) {
        extraOk = false;
        break;
      }
    }
    if (!extraOk) continue;
    matching.push(row);
  }

  const totalMatched = matching.length;
  const capApplied = totalMatched > DRILL_ROW_CAP;
  const rows = capApplied ? matching.slice(0, DRILL_ROW_CAP) : matching;
  return { rows, totalMatched, capApplied };
}

/**
 * Top-level drill-through resolver. Looks up the chart, applies the
 * filter, returns the response shape. Throws on chart-not-found so the
 * controller can map to 404.
 */
export function resolveDrillThrough(
  dashboard: Dashboard,
  chartId: string,
  request: DrillThroughRequest,
): DrillThroughResponse {
  // Wave WD3-server-sheetId-resolution · thread the optional sheetId
  // through to the chart lookup so multi-sheet dashboards resolve
  // chart-N against the correct sheet (the chartId is per-sheet, so
  // chart-0 in Sheet 1 and chart-0 in Sheet 2 are distinct charts).
  const chart = findChartByTileId(dashboard, chartId, request.sheetId);
  if (!chart) {
    throw new Error(`chart_not_found:${chartId}`);
  }
  const chartRows = (chart.data ?? []) as Array<Record<string, unknown>>;
  const { rows, totalMatched, capApplied } = filterChartRowsForDrill(
    chartRows,
    request,
  );
  return {
    rows,
    totalMatched,
    capApplied,
    chart: { title: chart.title ?? "Chart", tileId: chartId },
  };
}
