import React, { createContext, useContext, ReactNode } from 'react';
import { useDashboardState, DashboardData } from '../modules/useDashboardState';

/**
 * HMR-RESILIENT CONTEXT INSTANCE.
 *
 * In dev, when any file in the DashboardContext dependency graph is edited,
 * Vite's HMR re-evaluates `DashboardContext.tsx`, which calls `createContext`
 * a second time. The eager App-level `<DashboardProvider>` stays bound to
 * the original context instance; lazy-loaded consumers (e.g. /dashboard
 * route) get the new instance — and `useContext` returns `undefined`,
 * throwing "useDashboardContext must be used within a DashboardProvider".
 *
 * The fix is the same pattern the codebase uses for `cachedMsalInstance` in
 * App.tsx — keep the singleton on `globalThis` so it survives module
 * re-evaluation. Type signatures + exports below are unchanged.
 */
const CONTEXT_KEY = "__MARICO_DASHBOARD_CONTEXT_V1__";

interface DashboardContextType {
  dashboards: DashboardData[];
  currentDashboard: DashboardData | null;
  setCurrentDashboard: (dashboard: DashboardData | null) => void;
  createDashboard: (name: string) => Promise<DashboardData>;
  addChartToDashboard: (dashboardId: string, chart: any, sheetId?: string) => Promise<DashboardData>;
  addTableToDashboard: (dashboardId: string, table: any, sheetId?: string) => Promise<DashboardData>;
  removeChartFromDashboard: (dashboardId: string, chartIndex: number, sheetId?: string) => Promise<DashboardData>;
  removeTableFromDashboard: (dashboardId: string, tableIndex: number, sheetId?: string) => Promise<DashboardData>;
  deleteDashboard: (dashboardId: string) => Promise<void>;
  renameDashboard: (dashboardId: string, name: string) => Promise<DashboardData>;
  renameSheet: (dashboardId: string, sheetId: string, name: string) => Promise<DashboardData>;
  addSheet: (dashboardId: string, name: string) => Promise<DashboardData>;
  removeSheet: (dashboardId: string, sheetId: string) => Promise<DashboardData>;
  updateChartInsightOrRecommendation: (dashboardId: string, chartIndex: number, updates: { keyInsight?: string }, sheetId?: string) => Promise<DashboardData>;
  updateTableCaption: (dashboardId: string, tableIndex: number, updates: { caption?: string }, sheetId?: string) => Promise<DashboardData>;
  patchSheetContent: (
    dashboardId: string,
    sheetId: string,
    body: {
      narrativeBlocks?: import('@/shared/schema').DashboardNarrativeBlock[];
      gridLayout?: Record<string, unknown>;
    }
  ) => Promise<DashboardData>;
  getDashboardById: (dashboardId: string) => DashboardData | undefined;
  fetchDashboardById: (dashboardId: string) => Promise<DashboardData>;
  status: {
    isLoading: boolean;
    isFetching: boolean;
    error: unknown;
    refreshing: boolean;
  };
  refetch: () => Promise<any>;
}

export const DashboardContext: React.Context<DashboardContextType | undefined> =
  ((globalThis as Record<string, unknown>)[CONTEXT_KEY] as
    | React.Context<DashboardContextType | undefined>
    | undefined) ??
  ((globalThis as Record<string, unknown>)[CONTEXT_KEY] = createContext<
    DashboardContextType | undefined
  >(undefined)) as React.Context<DashboardContextType | undefined>;

interface DashboardProviderProps {
  children: ReactNode;
}

export function DashboardProvider({ children }: DashboardProviderProps) {
  const dashboardState = useDashboardState();

  return (
    <DashboardContext.Provider value={dashboardState}>
      {children}
    </DashboardContext.Provider>
  );
}

export function useDashboardContext() {
  const context = useContext(DashboardContext);
  if (context === undefined) {
    // Surface HMR-related context-mismatch hints in dev.
    if (typeof console !== "undefined") {
      console.error(
        "[DashboardContext] consumer saw `undefined` despite Provider in tree. " +
          "If this fired during an HMR update, do a hard refresh (Cmd+Shift+R) " +
          "to flush the stale chunk."
      );
    }
    throw new Error('useDashboardContext must be used within a DashboardProvider');
  }
  return context;
}
