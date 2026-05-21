/**
 * Wave WI4-foundation · Explain-this-slice — pure helper module.
 *
 * The third click-intent on chart marks, sibling to WD2's
 * [`crossFilter.ts`](./crossFilter.ts) and WD3's
 * [`drillThrough.ts`](./drillThrough.ts). Where:
 *
 *   - WD2 captures a SINGLE click on a mark and dispatches a
 *     `CrossFilterEvent` (discrete-value filter, dashboard-wide).
 *   - WD3 captures a SINGLE cmd / ctrl-click on a mark and
 *     dispatches a `DrillThroughEvent` (rows behind the slice, side
 *     sheet).
 *   - WI4 captures a RECT-DRAG (mouse-down + mouse-up at ≥ 6 px
 *     apart) and dispatches an `ExplainSliceEvent` (re-run the WI2
 *     insight generator on JUST the brushed sub-region, panel UI).
 *
 * The cmd / ctrl modifier check is irrelevant here — a brush drag is
 * already distinct from a click by virtue of the cursor travel. The
 * 6-px threshold is the same one already inlined in LineRenderer's
 * `onBrushUp` (a sub-6-px drag is treated as a click, NOT a brush);
 * lifting it into this foundation lets every renderer share one
 * uniform definition.
 *
 * Pure functions + one CustomEvent dispatch. No React state. The
 * receiving DashboardView owns its own panel-open state; this module
 * is just the data plumbing.
 */

import type { ActiveChartFilters } from "../../../lib/chartFilters";

/**
 * The pixel threshold below which a brush drag is treated as a click
 * (and routed to the cross-filter / drill-through paths) rather than
 * as an explain-this-slice intent. Lifted from LineRenderer's
 * `onBrushUp` inline `Math.abs(hi - lo) < 6` check — the same
 * threshold every renderer that grows brush mechanics in subsequent
 * WI4-wiring waves will reuse, so a future tweak lands in one place.
 */
export const BRUSH_MIN_PX = 6;

/**
 * A captured brush region in data-space. Discriminated union covers
 * the four flavours every WI4-wiring target binds to:
 *
 *  - `numeric`: continuous quantitative axis (BarRenderer with
 *    numeric x, RegressionRenderer, scatter w/ numeric x). Bounds
 *    are inclusive — `start <= value <= end`.
 *  - `temporal`: temporal axis (LineRenderer / AreaRenderer when
 *    `isTemporal`, scatter w/ Date x). Bounds are inclusive millis
 *    since epoch — `startMs <= value <= endMs`. Storing ms (not
 *    Date) keeps the event JSON-serialisable, which matters when the
 *    panel debounces / dedupes brushes via a hash key.
 *  - `categorical`: discrete axis (BarRenderer cat-x, LineRenderer
 *    cat-x, AreaRenderer cat-x). `values` is the ordered list of
 *    rendered x-axis labels that fall inside the brush rectangle —
 *    `filterRowsByBrushRegion` matches rows whose `column` value
 *    coerces to one of these labels.
 *  - `box2d`: 2D rectangular brush (PointRenderer scatter — the only
 *    chart kind with two independently-continuous axes). Bounds are
 *    inclusive on both axes — `xMin <= rowX <= xMax && yMin <= rowY
 *    <= yMax`. The y-axis column name is bound ON the region itself
 *    (rather than passed as a separate `filterRowsByBrushRegion`
 *    argument) because, unlike the three 1D variants whose y-axis is
 *    irrelevant to row matching, a box2d brush needs the second
 *    column name at filter time. Caller passes the x-column via
 *    `filterRowsByBrushRegion`'s third arg as usual; the y-column
 *    rides on the region.
 *
 * Pre-normalised: `start <= end` for the range variants; `values`
 * is non-empty for `categorical` (an empty brush degenerates to
 * "no slice" and the renderer should not dispatch); `xMin < xMax`
 * AND `yMin < yMax` for `box2d` (zero-area rejected — no rows to
 * filter against). The constructor helpers (`makeNumericRegion` /
 * `makeTemporalRegion` / `makeCategoricalRegion` / `makeBox2dRegion`)
 * enforce both invariants so callers can't fire a malformed event.
 */
export type BrushRegion =
  | { readonly kind: "numeric"; readonly start: number; readonly end: number }
  | {
      readonly kind: "temporal";
      readonly startMs: number;
      readonly endMs: number;
    }
  | {
      readonly kind: "categorical";
      readonly values: readonly string[];
    }
  | {
      readonly kind: "box2d";
      readonly xMin: number;
      readonly xMax: number;
      readonly yMin: number;
      readonly yMax: number;
      readonly yColumn: string;
    };

/**
 * Event the renderer dispatches when a mouse-up closes a brush drag
 * of ≥ `BRUSH_MIN_PX`. DashboardView subscribes once at mount, opens
 * the ExplainSlice panel, and re-runs `useInsightRegen` against the
 * rows that match `region` AND `filters`.
 *
 * Field shape mirrors `DrillThroughEvent` (`chartId` / `column` /
 * `sourceTileId` / `filters`) so the three click-intent events
 * stay co-located in the renderer's mental model. The single new
 * field is `region` — the brushed sub-domain in data-space — which
 * is the load-bearing payload (the rest of the fields are
 * book-keeping the receiver uses to address the right tile + filter
 * context).
 */
export interface ExplainSliceEvent {
  /** Chart whose insight to regenerate against the brushed slice. */
  chartId: string;
  /** The x-axis column the brush filters against (encoding.x.field). */
  column: string;
  /** Brushed sub-domain in data-space. */
  region: BrushRegion;
  /** Tile id originating the brush — mirrors CrossFilterEvent.sourceTileId. */
  sourceTileId?: string;
  /**
   * Snapshot of active filters at brush-up time. The slice rows
   * shown / re-explained are AFTER global + per-tile filters have
   * been applied, then narrowed further by `region`. Empty /
   * undefined means "no other filters active".
   */
  filters?: ActiveChartFilters;
  /**
   * Wave WI4-client-sheetId-resolution · the active sheet's id at
   * brush time, injected by the DashboardView listener (NOT by the
   * dispatching renderer — renderers don't know the sheet they live
   * in). When present, the ExplainSlicePanel's chartId
   * (`"chart-N"`) lookup is scoped to the named sheet, disambiguating
   * multi-sheet dashboards where `chart-0` exists in every sheet.
   * Captured at brush time (not panel-render time) so the resolution
   * context is stable across subsequent sheet navigation while the
   * panel is open. Undefined for single-sheet dashboards (and for
   * any panel mount that pre-dates this wave); the panel preserves
   * the legacy `activeSheet.charts[idx]` lookup in that case.
   * Predictable-failure on stale sheetId (sheet deleted between
   * brush and panel render): resolver returns null, panel renders
   * "Could not resolve the chart for..." — mirrors the server-side
   * WD3 resolver's `chart_not_found` contract.
   */
  sheetId?: string;
}

/** CustomEvent name dispatched by chart renderers. DashboardView subscribes once. */
export const EXPLAIN_SLICE_EVENT = "marico:explain-slice";

/**
 * Is a brush drag (mouseDown at `start`, mouseUp at `end`, both in
 * the same pixel-space) wide enough to count as an explain-this-
 * slice intent? Below the threshold, the brush is treated as a
 * click and falls through to the cross-filter / drill-through paths.
 *
 * Accepts `null` for either bound (a renderer whose brush state is
 * mid-reset returns `false`, defensive). `start === end` is also
 * `false` (a zero-distance brush is a click).
 *
 * The default threshold mirrors the inline `< 6` check already in
 * [`LineRenderer.onBrushUp`](../../../lib/charts/visxRenderers/LineRenderer.tsx).
 * Subsequent WI4-wiring waves replace those inline checks with calls
 * to this helper so a future tweak lands in one place.
 */
export function isBrushDrag(
  start: number | null | undefined,
  end: number | null | undefined,
  minPx: number = BRUSH_MIN_PX,
): boolean {
  if (start === null || start === undefined) return false;
  if (end === null || end === undefined) return false;
  return Math.abs(end - start) >= minPx;
}

/**
 * Normalise a numeric region so `start <= end`. Returns `null` for
 * a zero-width region (the renderer should fall back to the click
 * path in that case). Construction-helper that lets renderers pass
 * raw mouseDown / mouseUp data-space bounds without pre-sorting.
 */
export function makeNumericRegion(
  a: number,
  b: number,
): BrushRegion | null {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const start = Math.min(a, b);
  const end = Math.max(a, b);
  if (start === end) return null;
  return { kind: "numeric", start, end };
}

/**
 * Normalise a temporal region (millis since epoch) so
 * `startMs <= endMs`. Returns `null` for a zero-width region or
 * non-finite inputs. Construction-helper for renderers whose brush
 * resolves into a Date / ISO range.
 */
export function makeTemporalRegion(
  aMs: number,
  bMs: number,
): BrushRegion | null {
  if (!Number.isFinite(aMs) || !Number.isFinite(bMs)) return null;
  const startMs = Math.min(aMs, bMs);
  const endMs = Math.max(aMs, bMs);
  if (startMs === endMs) return null;
  return { kind: "temporal", startMs, endMs };
}

/**
 * Build a categorical region from the visible x-axis labels that
 * fall inside the brush rectangle. Returns `null` for an empty list
 * (callers should not dispatch in that case — the brush hit no
 * categories). Order is preserved (renderers pass labels in their
 * rendered order so downstream UI can show them naturally).
 */
export function makeCategoricalRegion(
  values: readonly string[],
): BrushRegion | null {
  if (values.length === 0) return null;
  return { kind: "categorical", values: [...values] };
}

/**
 * Wave WI4-foundation-box2d · normalise a 2D rectangular region
 * (PointRenderer scatter brush) so `xMin <= xMax` and `yMin <= yMax`.
 * Returns `null` for a zero-area region (either dimension collapses)
 * or non-finite inputs on any of the four bounds.
 *
 * The y-column name is bound onto the region itself because, unlike
 * the three 1D variants whose y-axis is irrelevant to row matching,
 * a box2d brush needs both axes' column names at filter time. The
 * caller passes the x-column via `filterRowsByBrushRegion`'s third
 * arg as usual; the y-column rides on the region.
 *
 * Construction-helper that lets PointRenderer pass raw mouseDown /
 * mouseUp data-space bounds without pre-sorting — same shape as the
 * three 1D constructors.
 */
export function makeBox2dRegion(
  ax: number,
  bx: number,
  ay: number,
  by: number,
  yColumn: string,
): BrushRegion | null {
  if (!Number.isFinite(ax) || !Number.isFinite(bx)) return null;
  if (!Number.isFinite(ay) || !Number.isFinite(by)) return null;
  const xMin = Math.min(ax, bx);
  const xMax = Math.max(ax, bx);
  const yMin = Math.min(ay, by);
  const yMax = Math.max(ay, by);
  if (xMin === xMax) return null;
  if (yMin === yMax) return null;
  return { kind: "box2d", xMin, xMax, yMin, yMax, yColumn };
}

/**
 * Coerce a row value to the millis-since-epoch form used for
 * `temporal` region matching. Mirrors the chart util `asTime`'s
 * shape (Date / ISO string / numeric ms). Returns `NaN` for
 * un-coercible values so the filter predicate drops them.
 */
function asTimeMs(raw: unknown): number {
  if (raw === null || raw === undefined) return Number.NaN;
  if (raw instanceof Date) return raw.getTime();
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") {
    const t = Date.parse(raw);
    return Number.isFinite(t) ? t : Number.NaN;
  }
  return Number.NaN;
}

/**
 * Coerce a row value to the canonical string form used for
 * `categorical` region matching. Mirrors `crossFilter.toFilterValue`'s
 * shape: `null` / `undefined` → `"null"`; Date → ISO; everything else
 * → `String(v)`. Kept private so the helper stays a pure-fn boundary
 * — callers don't need the string form, only the predicate result.
 */
function asCategoryString(raw: unknown): string {
  if (raw === null || raw === undefined) return "null";
  if (typeof raw === "string") return raw;
  if (raw instanceof Date) return raw.toISOString();
  return String(raw);
}

/**
 * Apply a brush region as a post-filter over rows. Pure: returns a
 * new array; the input is never mutated. Reads `column` from each
 * row (treating the row as a plain key/value record) and matches
 * against the region's discriminator.
 *
 * Mirrors the shape of `applyChartFilters` from
 * [`chartFilters.ts`](../../../lib/chartFilters.ts) so the WI4 panel
 * can compose it with the existing dashboard filter pipeline:
 * `applyChartFilters(rows, filters)` → `filterRowsByBrushRegion(...,
 * region)`. The two helpers are commutative because both are
 * predicate-AND filters.
 *
 * Edge cases:
 *   - `numeric` region: rows whose `column` is non-finite are
 *     dropped (cannot satisfy `start <= NaN <= end`).
 *   - `temporal` region: rows whose `column` coerces to `NaN` via
 *     `asTimeMs` are dropped (un-parseable date / null / missing).
 *   - `categorical` region: rows whose `column` coerces to a value
 *     NOT in `region.values` are dropped; `null` / `undefined` row
 *     values match against the literal string `"null"` if the
 *     region includes it (symmetric with `crossFilter.toFilterValue`).
 */
export function filterRowsByBrushRegion<T extends Record<string, unknown>>(
  rows: readonly T[],
  column: string,
  region: BrushRegion,
): T[] {
  if (region.kind === "numeric") {
    const { start, end } = region;
    return rows.filter((row) => {
      const v = row[column];
      if (v === null || v === undefined || v === "") return false;
      const n = typeof v === "number" ? v : Number(v);
      if (!Number.isFinite(n)) return false;
      return n >= start && n <= end;
    });
  }
  if (region.kind === "temporal") {
    const { startMs, endMs } = region;
    return rows.filter((row) => {
      const t = asTimeMs(row[column]);
      if (!Number.isFinite(t)) return false;
      return t >= startMs && t <= endMs;
    });
  }
  if (region.kind === "box2d") {
    // Wave WI4-foundation-box2d · two-axis bounded filter. `column`
    // is the x-axis (same convention as numeric/temporal); the y-
    // axis column rides on the region itself. Both dimensions use
    // the same null/empty-string drop + Number() coercion as the
    // numeric branch so string-typed numerics from CSV / JSON match
    // cleanly without silent dropouts.
    const { xMin, xMax, yMin, yMax, yColumn } = region;
    return rows.filter((row) => {
      const xv = row[column];
      const yv = row[yColumn];
      if (xv === null || xv === undefined || xv === "") return false;
      if (yv === null || yv === undefined || yv === "") return false;
      const x = typeof xv === "number" ? xv : Number(xv);
      const y = typeof yv === "number" ? yv : Number(yv);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
      return x >= xMin && x <= xMax && y >= yMin && y <= yMax;
    });
  }
  // categorical
  const allowed = new Set(region.values);
  return rows.filter((row) => allowed.has(asCategoryString(row[column])));
}

/**
 * Dispatch an `ExplainSliceEvent` on `window` using the canonical
 * `EXPLAIN_SLICE_EVENT` name. Chart renderers call this from their
 * `onBrushUp` handlers when `isBrushDrag(start, end)` is truthy.
 * DashboardView subscribes once at mount.
 *
 * No-op in non-browser environments (SSR, server-test). Returns
 * `true` iff the event was actually dispatched. Mirrors
 * `dispatchCrossFilter` / `dispatchDrillThrough`'s SSR-safe shape.
 */
export function dispatchExplainSlice(event: ExplainSliceEvent): boolean {
  if (typeof window === "undefined" || typeof CustomEvent === "undefined") {
    return false;
  }
  window.dispatchEvent(
    new CustomEvent<ExplainSliceEvent>(EXPLAIN_SLICE_EVENT, { detail: event }),
  );
  return true;
}
