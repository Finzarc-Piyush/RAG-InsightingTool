import { useCallback, useEffect, useState } from "react";

/**
 * Wave DR18D · per-tile chart/pivot view mode.
 *
 * Each chart tile on a dashboard can be flipped between its native
 * chart rendering and a pivot table over the same `chart.data` array.
 * The choice is per-tile (one chart at "pivot", others at "chart") and
 * lives in `sessionStorage` keyed by `${dashboardId}:${tileId}` so a
 * refresh preserves the user's last view. Default = `chart` so
 * existing dashboards open exactly as they did pre-DR18D.
 *
 * Mirrors the storage convention used by `DashboardEditModeContext`
 * (DR1) and `TileInsightFooter` (DR18B).
 */

export type ChartTileViewMode = "chart" | "pivot";

const STORAGE_PREFIX = "dashboard-chart-tile-view-mode:";

export function readPersistedChartTileViewMode(
  dashboardId: string,
  tileId: string,
): ChartTileViewMode {
  if (typeof sessionStorage === "undefined") return "chart";
  try {
    const raw = sessionStorage.getItem(`${STORAGE_PREFIX}${dashboardId}:${tileId}`);
    if (raw === "pivot") return "pivot";
    return "chart";
  } catch {
    return "chart";
  }
}

export function writePersistedChartTileViewMode(
  dashboardId: string,
  tileId: string,
  mode: ChartTileViewMode,
): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(`${STORAGE_PREFIX}${dashboardId}:${tileId}`, mode);
  } catch {
    // Quota / private mode — fall back to in-memory state.
  }
}

interface UseChartTileViewModeResult {
  mode: ChartTileViewMode;
  setMode: (mode: ChartTileViewMode) => void;
  toggle: () => void;
}

export function useChartTileViewMode(
  dashboardId: string,
  tileId: string,
): UseChartTileViewModeResult {
  const [mode, setModeState] = useState<ChartTileViewMode>(() =>
    readPersistedChartTileViewMode(dashboardId, tileId),
  );

  // Re-hydrate when the tile id / dashboard changes (sheet swap, etc.).
  useEffect(() => {
    setModeState(readPersistedChartTileViewMode(dashboardId, tileId));
  }, [dashboardId, tileId]);

  const setMode = useCallback(
    (next: ChartTileViewMode) => {
      setModeState(next);
      writePersistedChartTileViewMode(dashboardId, tileId, next);
    },
    [dashboardId, tileId],
  );

  const toggle = useCallback(() => {
    setMode(mode === "chart" ? "pivot" : "chart");
  }, [mode, setMode]);

  return { mode, setMode, toggle };
}
