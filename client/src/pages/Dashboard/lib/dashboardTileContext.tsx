/**
 * Wave WD2-wiring-bar · dashboard-tile React context.
 * Wave WD2-dim-foundation · carries `filters` so renderers can compute
 *   a dim factor for marks that don't match the active cross-filter.
 *
 * Tiny scope that a dashboard chart tile wraps around its renderer
 * (ChartShim / PremiumChart / legacy ChartRenderer) so the renderer
 * can identify *which tile* a click event originates from. Used by
 * BarRenderer (and the WD2-wiring-rest renderers) to dispatch the WD2
 * `CROSS_FILTER_EVENT` with a `sourceTileId` set, which is the signal
 * `DashboardView` uses to attribute brushed filters back to the
 * originating tile.
 *
 * WD2-dim-foundation extends the value with an optional `filters`
 * snapshot: the dashboard-wide `ActiveChartFilters` map already
 * threaded through `ChartTileBody`. Renderers in the upcoming
 * WD2-dim-* family (bar / cat / rect / trend / point / echarts) read
 * it via `useDashboardTileContext()` to call `isCrossFilterActive`
 * per mark and multiply opacity by ~0.4 when the mark's categorical
 * value isn't in the active selection. Pre-existing chat / explorer
 * grid.filter dim semantics are untouched — `grid.inGrid` and
 * `dashboardTile` are mutually exclusive contexts.
 *
 * Default value is `null` — when a chart renders outside the
 * dashboard (chat, explorer, share previews), `useDashboardTileContext()`
 * returns null and the renderer takes the no-op path. This keeps
 * the chat / explorer click-handling story unchanged (those paths
 * already use the `<ChartGrid>` context for in-grid cross-filter).
 */

import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { ActiveChartFilters } from "../../../lib/chartFilters";

export interface DashboardTileContextValue {
  tileId: string;
  /**
   * Dashboard-wide active filters at render time. Optional: pre-WD2-dim
   * providers omit it, in which case renderers should treat the
   * context as filter-empty (no dim factor applied). The value is the
   * SAME `ActiveChartFilters` map `DashboardView` holds in state —
   * referentially fresh on every dashboard re-render.
   */
  filters?: ActiveChartFilters;
}

const Ctx = createContext<DashboardTileContextValue | null>(null);

export interface DashboardTileProviderProps {
  tileId: string;
  /**
   * WD2-dim-foundation · forwarded into the context value so renderers
   * can compute a dim factor per mark. Optional for backwards
   * compatibility with consumers (tests, legacy mounts) that don't
   * have a filter map handy.
   */
  filters?: ActiveChartFilters;
  children: ReactNode;
}

export function DashboardTileProvider({
  tileId,
  filters,
  children,
}: DashboardTileProviderProps) {
  const value = useMemo<DashboardTileContextValue>(
    () => ({ tileId, ...(filters !== undefined ? { filters } : {}) }),
    [tileId, filters],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * Read the active dashboard-tile context. Returns `null` outside a
 * `<DashboardTileProvider>` (chat / explorer / share preview surfaces);
 * callers must treat null as "no dashboard wiring".
 */
export function useDashboardTileContext(): DashboardTileContextValue | null {
  return useContext(Ctx);
}

/** Internal — exported for tests / advanced consumers. */
export const DashboardTileContext = Ctx;
