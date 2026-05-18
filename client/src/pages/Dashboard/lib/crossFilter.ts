/**
 * Wave WD2 · Cross-filter brushing — pure helper module.
 *
 * Surfaces a one-way data path from a click on any chart mark to the
 * dashboard-wide `globalFilters` state (an `ActiveChartFilters` map
 * keyed by column name). When a user clicks a bar / point / segment
 * in a dashboard tile, the renderer composes a `CrossFilterEvent`
 * and dispatches it via `dispatchCrossFilter`. `DashboardView`
 * subscribes once at mount, runs `applyCrossFilter` against the
 * current `globalFilters`, and updates state.
 *
 * The toggle semantics: clicking an active (column, value) pair
 * removes it; clicking a new value on a column with an existing
 * categorical filter appends; clicking on a column with no filter
 * (or a non-categorical filter) installs a fresh categorical filter
 * with the single value. This matches the user's expectation that
 * "click to filter, click again to unfilter".
 *
 * Pure functions + one CustomEvent dispatch. No React state. The
 * receiving DashboardView owns its own setState; this module is
 * just the data plumbing.
 */

import type {
  ActiveChartFilters,
  CategoricalFilterSelection,
  ChartFilterSelection,
} from "../../../lib/chartFilters";

/** Event the renderer dispatches when a chart mark is clicked. */
export interface CrossFilterEvent {
  /** The data column the clicked mark binds to (encoding.x.field, color.field, …). */
  column: string;
  /** The clicked value. Numbers are coerced via `toFilterValue` before storage. */
  value: string | number | boolean | null | undefined;
  /** Tile id originating the click — DashboardView uses this to dim non-matching marks elsewhere. */
  sourceTileId?: string;
}

/** CustomEvent name dispatched by chart renderers. DashboardView subscribes once. */
export const CROSS_FILTER_EVENT = "marico:cross-filter";

/**
 * Coerce a clicked value to the canonical string form used for
 * categorical filter storage. `null` / `undefined` → the literal
 * string `"null"` (matches the upstream `(null)` key normalisation
 * in `breakdownRankingTool` and the existing chart filter UI's
 * null-bucket handling). Numbers / booleans get `String(v)`.
 */
export function toFilterValue(raw: unknown): string {
  if (raw === null || raw === undefined) return "null";
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  // Date / other objects — fall back to ISO / String coercion so chart-mark
  // values that flow as `unknown` (e.g. Date in temporal axes, BarCell.outerRaw)
  // produce a stable category label without callers having to narrow first.
  if (raw instanceof Date) return raw.toISOString();
  return String(raw);
}

/**
 * Is `(column, value)` currently active in the global filter map?
 * Always returns false for non-categorical selections on that
 * column — a date or numeric range cannot encode a discrete value
 * match.
 */
export function isCrossFilterActive(
  global: ActiveChartFilters,
  column: string,
  value: string | number | boolean | null | undefined,
): boolean {
  const sel = global[column];
  if (!sel || sel.type !== "categorical") return false;
  return sel.values.includes(toFilterValue(value));
}

/**
 * Apply a cross-filter click to the global filter map. Pure: returns
 * a new map; the input is never mutated.
 *
 * Toggle semantics:
 *  - if (column, value) is already active → remove the value (and
 *    drop the column entirely if the selection becomes empty)
 *  - if column has a categorical selection without `value` → append
 *  - if column has a date / numeric selection → REPLACE it with a
 *    fresh categorical[value] (cross-filter is explicitly discrete;
 *    the user's last action wins)
 *  - if column has no selection → install categorical[value]
 */
export function applyCrossFilter(
  global: ActiveChartFilters,
  event: CrossFilterEvent,
): ActiveChartFilters {
  const v = toFilterValue(event.value);
  const next: ActiveChartFilters = { ...global };
  const existing = next[event.column];

  if (existing?.type === "categorical") {
    if (existing.values.includes(v)) {
      const remaining = existing.values.filter((x) => x !== v);
      if (remaining.length === 0) {
        delete next[event.column];
      } else {
        next[event.column] = {
          type: "categorical",
          values: remaining,
        } satisfies CategoricalFilterSelection;
      }
    } else {
      next[event.column] = {
        type: "categorical",
        values: [...existing.values, v],
      } satisfies CategoricalFilterSelection;
    }
    return next;
  }

  // No existing categorical selection — install a fresh one.
  // This implicitly replaces date / numeric filters too, which is
  // intentional: a chart click is a discrete-value brush.
  next[event.column] = {
    type: "categorical",
    values: [v],
  } satisfies CategoricalFilterSelection;
  return next;
}

/**
 * Remove a single (column, value) pair from the global filter map.
 * No-op when the column has no categorical selection. Drops the
 * column entirely when removing the last value.
 */
export function removeCrossFilter(
  global: ActiveChartFilters,
  column: string,
  value: string | number | boolean | null | undefined,
): ActiveChartFilters {
  const sel = global[column];
  if (!sel || sel.type !== "categorical") return global;
  const v = toFilterValue(value);
  if (!sel.values.includes(v)) return global;
  const remaining = sel.values.filter((x) => x !== v);
  const next: ActiveChartFilters = { ...global };
  if (remaining.length === 0) {
    delete next[column];
  } else {
    next[column] = {
      type: "categorical",
      values: remaining,
    } satisfies CategoricalFilterSelection;
  }
  return next;
}

/**
 * Drop every selection on `column`. Used when a tile's "clear
 * brushing" action fires. Pure.
 */
export function clearCrossFilter(
  global: ActiveChartFilters,
  column: string,
): ActiveChartFilters {
  if (!(column in global)) return global;
  const next: ActiveChartFilters = { ...global };
  delete next[column];
  return next;
}

/**
 * List every active categorical (column, value) cross-filter pair
 * in the global map. Used by DashboardView to render the "brushed
 * by" chip strip and by tile renderers to compute the "dim non-
 * matching marks" mask. Non-categorical selections are skipped.
 */
export function listActiveCrossFilters(
  global: ActiveChartFilters,
): Array<{ column: string; value: string }> {
  const out: Array<{ column: string; value: string }> = [];
  for (const column of Object.keys(global).sort()) {
    const sel: ChartFilterSelection | undefined = global[column];
    if (!sel || sel.type !== "categorical") continue;
    for (const value of [...sel.values].sort()) {
      out.push({ column, value });
    }
  }
  return out;
}

/**
 * Dispatch a `CrossFilterEvent` on `window` using the canonical
 * `CROSS_FILTER_EVENT` name. Chart renderers call this from their
 * mark `onClick` handlers; DashboardView subscribes once at mount.
 *
 * No-op in non-browser environments (SSR, server-test). Returns
 * `true` iff the event was actually dispatched.
 */
export function dispatchCrossFilter(event: CrossFilterEvent): boolean {
  if (typeof window === "undefined" || typeof CustomEvent === "undefined") {
    return false;
  }
  window.dispatchEvent(
    new CustomEvent<CrossFilterEvent>(CROSS_FILTER_EVENT, { detail: event }),
  );
  return true;
}
