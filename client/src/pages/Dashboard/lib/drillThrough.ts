/**
 * Wave WD3-foundation · Drill-through to underlying rows — pure helper.
 *
 * Pairs naturally with the now-complete WD2-wiring + WD2-dim families:
 *   - WD2-wiring captures the click and dispatches a cross-filter.
 *   - WD2-dim provides visual feedback on the brushed slice.
 *   - WD3 layers a second click-intent on top: when cmd (mac) / ctrl
 *     (windows / linux) is held during the click, the renderer
 *     dispatches a `DrillThroughEvent` instead of a `CrossFilterEvent`,
 *     and `DashboardView` opens a side-sheet showing the underlying
 *     rows for that (chart, column, value) pair.
 *
 * The cmd / ctrl detection MUST be uniform across all 15 renderers
 * (10 visx + 5 ECharts), so the modifier check lives here in a single
 * pure helper instead of duplicated per-renderer. This is the same
 * "share the helper, not the wiring" precedent set by WD2's
 * `crossFilter.ts` module.
 *
 * Pure functions + one CustomEvent dispatch. No React state. The
 * receiving DashboardView owns its own setState; this module is just
 * the data plumbing — mirrors WD2's crossFilter helper shape so the
 * two click intents stay co-located in the renderer's mental model.
 */

import type { ActiveChartFilters } from "../../../lib/chartFilters";

/**
 * A single (column, value) pin within a drill-through request. Most
 * renderers fire single-pin events; multi-dim renderers (RectRenderer
 * heatmap, where a cell intersects row × col) attach additional pins
 * via `DrillThroughEvent.extraPins`.
 *
 * `value` is `unknown` to match `toFilterValue` / `isCrossFilterActive`'s
 * widening precedent — the server endpoint applies its own
 * canonicalisation per the inferred column type.
 */
export interface DrillThroughPin {
  /** The data column the clicked mark binds to. */
  column: string;
  /** The clicked value. Numbers / Dates / null are coerced server-side. */
  value: unknown;
}

/**
 * Event the renderer dispatches when a chart mark is cmd/ctrl-clicked.
 * The receiving DashboardView opens a side-sheet that fetches the rows
 * backing the clicked (column, value) pin(s) within `chartId`.
 *
 * Mirrors the `CrossFilterEvent` shape (same `column` / `value` /
 * `sourceTileId` field naming) plus a `chartId` so the server endpoint
 * can fetch the right backing dataset and an optional `filters`
 * snapshot so the drill-through respects the dashboard's currently-
 * active global + per-tile filter context at click time (the rows
 * shown are AFTER any active filter is applied, not the un-filtered
 * raw rows). `value` is `unknown` to match `toFilterValue` /
 * `isCrossFilterActive`'s widening precedent — the server endpoint
 * applies its own canonicalisation.
 *
 * **Multi-pin drill targets** (RectRenderer heatmap and future N-dim
 * marks). The primary `(column, value)` pin is the FIRST drill axis;
 * `extraPins` is an optional ordered list of additional pins to
 * intersect with the primary. The server endpoint applies the primary
 * + all extras as WHERE clauses BEFORE returning rows — semantically
 * an AND-intersection (rows that match every pin). The receiver UI
 * renders the primary + extras symmetrically (the primary's only
 * special role is in the sheet's title / description text). Single-
 * pin renderers (bar / cat-5 / line / area / point / 5 ECharts marks)
 * omit `extraPins` — the field is fully optional and backwards-compat
 * for them.
 */
export interface DrillThroughEvent {
  /** Chart whose backing rows to fetch. */
  chartId: string;
  /** Primary pin's column (encoding.x.field, color.field, row dim, …). */
  column: string;
  /** Primary pin's value. */
  value: unknown;
  /**
   * Additional pins for multi-dimensional drill targets. RectRenderer
   * (heatmap) fires one event with the row dim as the primary
   * `column` / `value` pair and the col dim as `extraPins[0]`. The
   * server endpoint applies primary + all extras as WHERE clauses
   * BEFORE returning rows (AND-intersection). Empty / undefined →
   * single-pin event (the WD3-wiring-bar / cat / trend / point shape).
   */
  extraPins?: DrillThroughPin[];
  /** Tile id originating the click — mirrors CrossFilterEvent.sourceTileId. */
  sourceTileId?: string;
  /**
   * Snapshot of active filters at click time. The server endpoint
   * applies these BEFORE pinning the (column, value) pair so the
   * drill-through respects the dashboard's current global + per-tile
   * filter context. Empty / undefined means "no other filters
   * active".
   */
  filters?: ActiveChartFilters;
}

/** CustomEvent name dispatched by chart renderers. DashboardView subscribes once. */
export const DRILL_THROUGH_EVENT = "marico:drill-through";

/**
 * Cross-platform modifier check. macOS uses `metaKey` (⌘); Windows /
 * Linux use `ctrlKey`. Either flag fires the drill-through path. This
 * mirrors the de-facto convention across the ecosystem (GitHub,
 * VS Code, Linear, ...): ⌘-click on mac = ctrl-click elsewhere =
 * "inspect this thing".
 *
 * Plain click stays on the cross-filter path; cmd / ctrl modifies the
 * intent to "show me the underlying rows for this slice". The two
 * paths are mutually exclusive — a renderer branches on this helper
 * at the top of its onClick handler and dispatches one event or the
 * other, never both.
 *
 * Accepts a sparse event shape so callers can pass React synthetic /
 * native DOM / ECharts onChartClick events alike (the three event
 * shapes used by the WD2-wiring family). `undefined` / `null` →
 * `false` (defensive: a renderer that somehow loses its event in a
 * test or SSR path falls back to the safe cross-filter intent).
 */
export function isModifierClick(
  event:
    | { metaKey?: boolean; ctrlKey?: boolean }
    | undefined
    | null,
): boolean {
  if (!event) return false;
  return !!event.metaKey || !!event.ctrlKey;
}

/**
 * Dispatch a `DrillThroughEvent` on `window` using the canonical
 * `DRILL_THROUGH_EVENT` name. Chart renderers call this from their
 * mark `onClick` handlers when `isModifierClick(event)` is truthy.
 * DashboardView subscribes once at mount.
 *
 * No-op in non-browser environments (SSR, server-test). Returns
 * `true` iff the event was actually dispatched. Mirrors
 * `dispatchCrossFilter`'s SSR-safe shape.
 */
export function dispatchDrillThrough(event: DrillThroughEvent): boolean {
  if (typeof window === "undefined" || typeof CustomEvent === "undefined") {
    return false;
  }
  window.dispatchEvent(
    new CustomEvent<DrillThroughEvent>(DRILL_THROUGH_EVENT, { detail: event }),
  );
  return true;
}
