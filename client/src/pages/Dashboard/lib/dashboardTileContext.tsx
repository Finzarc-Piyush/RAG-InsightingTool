/**
 * Wave WD2-wiring-bar · dashboard-tile React context.
 *
 * Tiny scope that a dashboard chart tile wraps around its renderer
 * (ChartShim / PremiumChart / legacy ChartRenderer) so the renderer
 * can identify *which tile* a click event originates from. Used by
 * BarRenderer (and future renderers in WD2-wiring-rest) to dispatch
 * the WD2 `CROSS_FILTER_EVENT` with a `sourceTileId` set, which is
 * the signal `DashboardView` uses to attribute brushed filters back
 * to the originating tile.
 *
 * Default value is `null` — when a chart renders outside the
 * dashboard (chat, explorer, share previews), `useDashboardTileContext()`
 * returns null and the renderer takes the no-op path. This keeps
 * the chat / explorer click-handling story unchanged (those paths
 * already use the `<ChartGrid>` context for in-grid cross-filter).
 */

import { createContext, useContext, useMemo, type ReactNode } from "react";

export interface DashboardTileContextValue {
  tileId: string;
}

const Ctx = createContext<DashboardTileContextValue | null>(null);

export interface DashboardTileProviderProps {
  tileId: string;
  children: ReactNode;
}

export function DashboardTileProvider({
  tileId,
  children,
}: DashboardTileProviderProps) {
  const value = useMemo<DashboardTileContextValue>(
    () => ({ tileId }),
    [tileId],
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
