import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Layouts } from 'react-grid-layout';
import {
  ChartSpec,
  Dashboard as ServerDashboard,
  DashboardAnswerEnvelope,
  DashboardSheet,
  DashboardTableSpec,
  ActiveFilterSpec,
  // DPF1/DPF4 · message-mirroring fields the live dashboard view now renders.
  BusinessActionItem,
  InvestigationSummary,
  PriorInvestigationItem,
  AttentionAreaSpec,
} from '@/shared/schema';
import { dashboardsApi } from '@/lib/api';

export interface DashboardData {
  id: string;
  name: string;
  charts: ChartSpec[];
  sheets?: DashboardSheet[];
  createdAt: Date;
  updatedAt: Date;
  lastOpenedAt?: Date;
  username?: string; // Owner's email/username
  isShared?: boolean; // Whether this is a shared dashboard (shared WITH the current user)
  sharedPermission?: "view" | "edit"; // Permission level for shared dashboards
  sharedBy?: string; // Email of the user who shared this dashboard
  permission?: "view" | "edit"; // Computed permission (for convenience)
  hasCollaborators?: boolean; // Whether this dashboard has been shared with others (owned by current user but shared)
  collaborators?: Array<{ userId: string; permission: "view" | "edit" }>; // List of collaborators
  /** W4 · slim envelope captured at create-time. Drives the export's cover,
   *  exec summary, recommendations, and methodology slides. */
  answerEnvelope?: DashboardAnswerEnvelope;
  /** Wave-FA6 · session active filter snapshot at dashboard-creation time. */
  capturedActiveFilter?: ActiveFilterSpec;
  /** DPF1 · BAI1 business action items, patched onto the dashboard after
   *  the post-verifier `businessActionsAgent` resolves. */
  businessActions?: BusinessActionItem[];
  /** DPF1 · synthesizer follow-up CTAs from the originating chat turn. */
  followUpPrompts?: string[];
  /** DPF1 · W13 investigation digest at create-time. */
  investigationSummary?: InvestigationSummary;
  /** DPF1 · W30 prior-investigations snapshot at create-time. */
  priorInvestigationsSnapshot?: PriorInvestigationItem[];
  /** MW4 · management-by-exception attention areas. */
  attentionAreas?: AttentionAreaSpec[];
  /** W-SBGRID · saved free-form positions for the Executive-Summary cards. */
  summaryGridLayout?: Layouts;
  /**
   * Wave DR15 · source session id. Persisted by the server's
   * `from-spec` / `from-analysis` create paths when supplied. Drives
   * the dashboard surface's "Open chat" back-link. Absent on bare
   * `+ New dashboard` creations and on dashboards predating DR15.
   */
  sessionId?: string;
}

/**
 * Wave DR17 · "Step N" tool-call narrative blocks were emitted by the
 * pre-DR17 `buildAllArtefactsNarrativeBlocks` server function. They
 * dump raw tool-call internals
 * (`get_schema_summary: rows=…`, `execute_query_plan: …`) onto the
 * All Artefacts sheet — internal audit data that shouldn't surface
 * on a user-facing dashboard.
 *
 * Server emission stops at DR17, but dashboards already persisted in
 * Cosmos still carry these blocks. This helper strips them at read
 * time so existing dashboards render clean without a one-shot
 * migration script. The match is intentionally narrow — title is
 * exactly "Step <number>" — to avoid clobbering legitimate
 * user-authored narrative whose title happens to start with "Step".
 */
const STEP_BLOCK_TITLE = /^step\s+\d+$/i;

function stripLegacyStepBlocks<S extends DashboardSheet>(sheet: S): S {
  if (!Array.isArray(sheet.narrativeBlocks) || sheet.narrativeBlocks.length === 0) {
    return sheet;
  }
  const filtered = sheet.narrativeBlocks.filter(
    (b) => !STEP_BLOCK_TITLE.test((b.title ?? "").trim()),
  );
  if (filtered.length === sheet.narrativeBlocks.length) return sheet;
  return { ...sheet, narrativeBlocks: filtered };
}

// TYPE-2 · the incoming persisted dashboard carries shared-state + message-
// mirroring fields beyond the lean ServerDashboard shape. Type them from the
// canonical DashboardData field types (Partial — pre-DPF1 docs omit them) so the
// reads below are type-checked instead of cast through `as any`.
type PersistedDashboard = ServerDashboard & {
  isShared?: boolean;
  sharedPermission?: "view" | "edit";
  sharedBy?: string;
} & Partial<
    Pick<
      DashboardData,
      | "collaborators"
      | "answerEnvelope"
      | "capturedActiveFilter"
      | "businessActions"
      | "followUpPrompts"
      | "investigationSummary"
      | "priorInvestigationsSnapshot"
      | "attentionAreas"
      | "sessionId"
    >
  >;

export const normalizeDashboard = (dashboard: PersistedDashboard): DashboardData => {
  const normalized: DashboardData = {
    id: dashboard.id,
    name: dashboard.name,
    charts: dashboard.charts || [],
    sheets: (dashboard.sheets || []).map(stripLegacyStepBlocks),
    createdAt: new Date(dashboard.createdAt),
    updatedAt: new Date(dashboard.updatedAt),
    lastOpenedAt: dashboard.lastOpenedAt ? new Date(dashboard.lastOpenedAt) : undefined,
    username: dashboard.username,
    // Preserve shared dashboard properties
    isShared: dashboard.isShared || false,
    sharedPermission: dashboard.sharedPermission,
    sharedBy: dashboard.sharedBy,
    // Check if dashboard has collaborators (has been shared by owner)
    collaborators: dashboard.collaborators || [],
    hasCollaborators: ((dashboard.collaborators && dashboard.collaborators.length > 0) || false),
    answerEnvelope: dashboard.answerEnvelope,
    capturedActiveFilter: dashboard.capturedActiveFilter,
    // DPF1 · the four message-mirroring fields. All optional + back-compat
    // — pre-DPF1 dashboards return undefined and the panel renders nothing.
    businessActions: dashboard.businessActions,
    followUpPrompts: dashboard.followUpPrompts,
    investigationSummary: dashboard.investigationSummary,
    priorInvestigationsSnapshot: dashboard.priorInvestigationsSnapshot,
    attentionAreas: dashboard.attentionAreas,
    summaryGridLayout: dashboard.summaryGridLayout as Layouts | undefined,
    sessionId: dashboard.sessionId,
  };
  
  // Set permission for convenience (use sharedPermission if it's a shared dashboard)
  if (normalized.isShared && normalized.sharedPermission) {
    normalized.permission = normalized.sharedPermission;
  }
  
  return normalized;
};

export const useDashboardState = () => {
  const queryClient = useQueryClient();
  const [currentDashboard, setCurrentDashboard] = useState<DashboardData | null>(null);

  const {
    data: dashboards = [],
    isFetching,
    isLoading,
    refetch,
    error,
  } = useQuery({
    queryKey: ['dashboards', 'list'],
    queryFn: async () => {
      const res = await dashboardsApi.list();
      const normalized = res.dashboards.map(normalizeDashboard);
      return normalized;
    },
    staleTime: 0, // Always refetch to get latest shared dashboards
  });

  const createDashboardMutation = useMutation({
    mutationFn: async (name: string) => {
      const created = await dashboardsApi.create(name);
      return normalizeDashboard(created);
    },
    onSuccess: (createdDashboard) => {
      queryClient.setQueryData<DashboardData[]>(['dashboards', 'list'], (prev) => {
        const existing = prev ?? [];
        return [...existing, createdDashboard];
      });
      setCurrentDashboard(createdDashboard);
    },
  });

  const addChartMutation = useMutation({
    mutationFn: async ({ dashboardId, chart, sheetId }: { dashboardId: string; chart: ChartSpec; sheetId?: string }) => {
      const updated = await dashboardsApi.addChart(dashboardId, chart, sheetId);
      return normalizeDashboard(updated);
    },
    onSuccess: (updatedDashboard) => {
      queryClient.setQueryData<DashboardData[]>(['dashboards', 'list'], (prev) => {
        if (!prev) return [updatedDashboard];
        return prev.map((dashboard) => (dashboard.id === updatedDashboard.id ? updatedDashboard : dashboard));
      });
      setCurrentDashboard((prev) => (prev?.id === updatedDashboard.id ? updatedDashboard : prev));
    },
  });

  const addTableMutation = useMutation({
    mutationFn: async ({
      dashboardId,
      table,
      sheetId,
    }: {
      dashboardId: string;
      table: DashboardTableSpec;
      sheetId?: string;
    }) => {
      const updated = await dashboardsApi.addTable(dashboardId, table, sheetId);
      return normalizeDashboard(updated);
    },
    onSuccess: (updatedDashboard) => {
      queryClient.setQueryData<DashboardData[]>(['dashboards', 'list'], (prev) => {
        if (!prev) return [updatedDashboard];
        return prev.map((dashboard) => (dashboard.id === updatedDashboard.id ? updatedDashboard : dashboard));
      });
      setCurrentDashboard((prev) => (prev?.id === updatedDashboard.id ? updatedDashboard : prev));
    },
  });

  const removeChartMutation = useMutation({
    mutationFn: async ({ dashboardId, chartIndex, sheetId }: { dashboardId: string; chartIndex: number; sheetId?: string }) => {
      const updated = await dashboardsApi.removeChart(dashboardId, { index: chartIndex, sheetId });
      return normalizeDashboard(updated);
    },
    onSuccess: (updatedDashboard) => {
      queryClient.setQueryData<DashboardData[]>(['dashboards', 'list'], (prev) => {
        if (!prev) return [updatedDashboard];
        return prev.map((dashboard) => (dashboard.id === updatedDashboard.id ? updatedDashboard : dashboard));
      });
      setCurrentDashboard((prev) => (prev?.id === updatedDashboard.id ? updatedDashboard : prev));
    },
  });

  const removeTableMutation = useMutation({
    mutationFn: async ({ dashboardId, tableIndex, sheetId }: { dashboardId: string; tableIndex: number; sheetId?: string }) => {
      const updated = await dashboardsApi.removeTable(dashboardId, { index: tableIndex, sheetId });
      return normalizeDashboard(updated);
    },
    onSuccess: (updatedDashboard) => {
      queryClient.setQueryData<DashboardData[]>(['dashboards', 'list'], (prev) => {
        if (!prev) return [updatedDashboard];
        return prev.map((dashboard) => (dashboard.id === updatedDashboard.id ? updatedDashboard : dashboard));
      });
      setCurrentDashboard((prev) => (prev?.id === updatedDashboard.id ? updatedDashboard : prev));
    },
  });

  const removePivotMutation = useMutation({
    mutationFn: async ({ dashboardId, pivotIndex, sheetId }: { dashboardId: string; pivotIndex: number; sheetId?: string }) => {
      const updated = await dashboardsApi.removePivot(dashboardId, { index: pivotIndex, sheetId });
      return normalizeDashboard(updated);
    },
    onSuccess: (updatedDashboard) => {
      queryClient.setQueryData<DashboardData[]>(['dashboards', 'list'], (prev) => {
        if (!prev) return [updatedDashboard];
        return prev.map((dashboard) => (dashboard.id === updatedDashboard.id ? updatedDashboard : dashboard));
      });
      setCurrentDashboard((prev) => (prev?.id === updatedDashboard.id ? updatedDashboard : prev));
    },
  });

  const deleteDashboardMutation = useMutation({
    mutationFn: async (dashboardId: string) => {
      await dashboardsApi.remove(dashboardId);
      return dashboardId;
    },
    onSuccess: (dashboardId) => {
      queryClient.setQueryData<DashboardData[]>(['dashboards', 'list'], (prev) =>
        (prev ?? []).filter((dashboard) => dashboard.id !== dashboardId)
      );
      setCurrentDashboard((prev) => (prev?.id === dashboardId ? null : prev));
    },
  });

  const getDashboardById = useCallback(
    (dashboardId: string): DashboardData | undefined => dashboards.find((dashboard) => dashboard.id === dashboardId),
    [dashboards]
  );

  const fetchDashboardById = useCallback(
    async (dashboardId: string): Promise<DashboardData> => {
      const dashboard = await dashboardsApi.get(dashboardId);
      const normalized = normalizeDashboard(dashboard);
      // Update the cache
      queryClient.setQueryData<DashboardData[]>(['dashboards', 'list'], (prev) => {
        if (!prev) return [normalized];
        return prev.map((d) => (d.id === normalized.id ? normalized : d));
      });
      return normalized;
    },
    [queryClient]
  );

  const createDashboard = useCallback((name: string) => createDashboardMutation.mutateAsync(name), [
    createDashboardMutation,
  ]);

  const addChartToDashboard = useCallback(
    (dashboardId: string, chart: ChartSpec, sheetId?: string) => addChartMutation.mutateAsync({ dashboardId, chart, sheetId }),
    [addChartMutation]
  );

  const addTableToDashboard = useCallback(
    (dashboardId: string, table: DashboardTableSpec, sheetId?: string) =>
      addTableMutation.mutateAsync({ dashboardId, table, sheetId }),
    [addTableMutation]
  );

  const removeChartFromDashboard = useCallback(
    (dashboardId: string, chartIndex: number, sheetId?: string) =>
      removeChartMutation.mutateAsync({ dashboardId, chartIndex, sheetId }),
    [removeChartMutation]
  );

  const removeTableFromDashboard = useCallback(
    (dashboardId: string, tableIndex: number, sheetId?: string) =>
      removeTableMutation.mutateAsync({ dashboardId, tableIndex, sheetId }),
    [removeTableMutation]
  );

  const removePivotFromDashboard = useCallback(
    (dashboardId: string, pivotIndex: number, sheetId?: string) =>
      removePivotMutation.mutateAsync({ dashboardId, pivotIndex, sheetId }),
    [removePivotMutation]
  );

  const deleteDashboard = useCallback(
    async (dashboardId: string) => {
      await deleteDashboardMutation.mutateAsync(dashboardId);
    },
    [deleteDashboardMutation]
  );

  const renameDashboardMutation = useMutation({
    mutationFn: async ({ dashboardId, name }: { dashboardId: string; name: string }) => {
      const updated = await dashboardsApi.rename(dashboardId, name);
      return normalizeDashboard(updated);
    },
    onSuccess: (updatedDashboard) => {
      queryClient.setQueryData<DashboardData[]>(['dashboards', 'list'], (prev) => {
        if (!prev) return [updatedDashboard];
        return prev.map((dashboard) => (dashboard.id === updatedDashboard.id ? updatedDashboard : dashboard));
      });
      setCurrentDashboard((prev) => (prev?.id === updatedDashboard.id ? updatedDashboard : prev));
    },
    onError: (error: any) => {
      // Error will be handled by the component showing toast
      throw error;
    },
  });

  const renameSheetMutation = useMutation({
    mutationFn: async ({ dashboardId, sheetId, name }: { dashboardId: string; sheetId: string; name: string }) => {
      const updated = await dashboardsApi.renameSheet(dashboardId, sheetId, name);
      return normalizeDashboard(updated);
    },
    onSuccess: (updatedDashboard) => {
      queryClient.setQueryData<DashboardData[]>(['dashboards', 'list'], (prev) => {
        if (!prev) return [updatedDashboard];
        return prev.map((dashboard) => (dashboard.id === updatedDashboard.id ? updatedDashboard : dashboard));
      });
      setCurrentDashboard((prev) => (prev?.id === updatedDashboard.id ? updatedDashboard : prev));
    },
    onError: (error: any) => {
      // Error will be handled by the component showing toast
      throw error;
    },
  });

  const renameDashboard = useCallback(
    (dashboardId: string, name: string) => renameDashboardMutation.mutateAsync({ dashboardId, name }),
    [renameDashboardMutation]
  );

  const renameSheet = useCallback(
    (dashboardId: string, sheetId: string, name: string) => renameSheetMutation.mutateAsync({ dashboardId, sheetId, name }),
    [renameSheetMutation]
  );

  // Wave DR5 · atomic sheet reorder.
  const reorderSheetsMutation = useMutation({
    mutationFn: async ({ dashboardId, orderedSheetIds }: { dashboardId: string; orderedSheetIds: string[] }) => {
      const updated = await dashboardsApi.reorderSheets(dashboardId, orderedSheetIds);
      return normalizeDashboard(updated);
    },
    onSuccess: (updatedDashboard) => {
      queryClient.setQueryData<DashboardData[]>(['dashboards', 'list'], (prev) => {
        if (!prev) return [updatedDashboard];
        return prev.map((dashboard) => (dashboard.id === updatedDashboard.id ? updatedDashboard : dashboard));
      });
      setCurrentDashboard((prev) => (prev?.id === updatedDashboard.id ? updatedDashboard : prev));
    },
    onError: (error: any) => {
      throw error;
    },
  });

  const reorderSheets = useCallback(
    (dashboardId: string, orderedSheetIds: string[]) =>
      reorderSheetsMutation.mutateAsync({ dashboardId, orderedSheetIds }),
    [reorderSheetsMutation]
  );

  const removeSheetMutation = useMutation({
    mutationFn: async ({ dashboardId, sheetId }: { dashboardId: string; sheetId: string }) => {
      const updated = await dashboardsApi.removeSheet(dashboardId, sheetId);
      return normalizeDashboard(updated);
    },
    onSuccess: (updatedDashboard) => {
      queryClient.setQueryData<DashboardData[]>(['dashboards', 'list'], (prev) => {
        if (!prev) return [updatedDashboard];
        return prev.map((dashboard) => (dashboard.id === updatedDashboard.id ? updatedDashboard : dashboard));
      });
      setCurrentDashboard((prev) => (prev?.id === updatedDashboard.id ? updatedDashboard : prev));
    },
    onError: (error: any) => {
      // Error will be handled by the component showing toast
      throw error;
    },
  });

  const removeSheet = useCallback(
    (dashboardId: string, sheetId: string) => removeSheetMutation.mutateAsync({ dashboardId, sheetId }),
    [removeSheetMutation]
  );

  const addSheetMutation = useMutation({
    mutationFn: async ({ dashboardId, name }: { dashboardId: string; name: string }) => {
      const updated = await dashboardsApi.addSheet(dashboardId, name);
      return normalizeDashboard(updated);
    },
    onSuccess: (updatedDashboard) => {
      queryClient.setQueryData<DashboardData[]>(['dashboards', 'list'], (prev) => {
        if (!prev) return [updatedDashboard];
        return prev.map((dashboard) => (dashboard.id === updatedDashboard.id ? updatedDashboard : dashboard));
      });
      setCurrentDashboard((prev) => (prev?.id === updatedDashboard.id ? updatedDashboard : prev));
    },
    onError: (error: any) => {
      // Error will be handled by the component showing toast
      throw error;
    },
  });

  const addSheet = useCallback(
    (dashboardId: string, name: string) => addSheetMutation.mutateAsync({ dashboardId, name }),
    [addSheetMutation]
  );

  const updateChartInsightOrRecommendationMutation = useMutation({
    mutationFn: async ({ dashboardId, chartIndex, updates, sheetId }: { dashboardId: string; chartIndex: number; updates: { keyInsight?: string; sort?: { by: "value" | "category"; direction: "asc" | "desc" }; limit?: { mode: "top" | "bottom"; n: number } | null }; sheetId?: string }) => {
      const updated = await dashboardsApi.updateChartInsightOrRecommendation(dashboardId, chartIndex, updates, sheetId);
      return normalizeDashboard(updated);
    },
    onSuccess: (updatedDashboard) => {
      queryClient.setQueryData<DashboardData[]>(['dashboards', 'list'], (prev) => {
        if (!prev) return [updatedDashboard];
        return prev.map((dashboard) => (dashboard.id === updatedDashboard.id ? updatedDashboard : dashboard));
      });
      setCurrentDashboard((prev) => (prev?.id === updatedDashboard.id ? updatedDashboard : prev));
    },
  });

  const patchSheetContentMutation = useMutation({
    mutationFn: async ({
      dashboardId,
      sheetId,
      narrativeBlocks,
      gridLayout,
    }: {
      dashboardId: string;
      sheetId: string;
      narrativeBlocks?: import('@/shared/schema').DashboardNarrativeBlock[];
      gridLayout?: Record<string, unknown>;
    }) => {
      const updated = await dashboardsApi.patchSheetContent(dashboardId, sheetId, {
        narrativeBlocks,
        gridLayout: gridLayout as import('react-grid-layout').Layouts | undefined,
      });
      return normalizeDashboard(updated);
    },
    onSuccess: (updatedDashboard) => {
      queryClient.setQueryData<DashboardData[]>(['dashboards', 'list'], (prev) => {
        if (!prev) return [updatedDashboard];
        return prev.map((dashboard) => (dashboard.id === updatedDashboard.id ? updatedDashboard : dashboard));
      });
      setCurrentDashboard((prev) => (prev?.id === updatedDashboard.id ? updatedDashboard : prev));
    },
  });

  const updateTableCaptionMutation = useMutation({
    mutationFn: async ({
      dashboardId,
      tableIndex,
      caption,
      sheetId,
    }: {
      dashboardId: string;
      tableIndex: number;
      caption: string;
      sheetId?: string;
    }) => {
      const updated = await dashboardsApi.updateTableCaption(dashboardId, tableIndex, { caption }, sheetId);
      return normalizeDashboard(updated);
    },
    onSuccess: (updatedDashboard) => {
      queryClient.setQueryData<DashboardData[]>(['dashboards', 'list'], (prev) => {
        if (!prev) return [updatedDashboard];
        return prev.map((dashboard) => (dashboard.id === updatedDashboard.id ? updatedDashboard : dashboard));
      });
      setCurrentDashboard((prev) => (prev?.id === updatedDashboard.id ? updatedDashboard : prev));
    },
  });

  const updateChartInsightOrRecommendation = useCallback(
    (dashboardId: string, chartIndex: number, updates: { keyInsight?: string; sort?: { by: "value" | "category"; direction: "asc" | "desc" }; limit?: { mode: "top" | "bottom"; n: number } | null }, sheetId?: string) =>
      updateChartInsightOrRecommendationMutation.mutateAsync({ dashboardId, chartIndex, updates, sheetId }),
    [updateChartInsightOrRecommendationMutation]
  );

  const updateTableCaption = useCallback(
    (dashboardId: string, tableIndex: number, updates: { caption?: string }, sheetId?: string) =>
      updateTableCaptionMutation.mutateAsync({
        dashboardId,
        tableIndex,
        caption: updates.caption ?? '',
        sheetId,
      }),
    [updateTableCaptionMutation]
  );

  const patchSheetContent = useCallback(
    (
      dashboardId: string,
      sheetId: string,
      body: {
        narrativeBlocks?: import('@/shared/schema').DashboardNarrativeBlock[];
        gridLayout?: Record<string, unknown>;
      }
    ) => patchSheetContentMutation.mutateAsync({ dashboardId, sheetId, ...body }),
    [patchSheetContentMutation]
  );

  const status = useMemo(
    () => ({
      isLoading,
      isFetching,
      error,
      refreshing: isFetching && !isLoading,
    }),
    [error, isFetching, isLoading]
  );

  return {
    dashboards,
    currentDashboard,
    setCurrentDashboard,
    createDashboard,
    addChartToDashboard,
    addTableToDashboard,
    removeChartFromDashboard,
    removeTableFromDashboard,
    removePivotFromDashboard,
    deleteDashboard,
    renameDashboard,
    renameSheet,
    reorderSheets,
    addSheet,
    removeSheet,
    updateChartInsightOrRecommendation,
    updateTableCaption,
    patchSheetContent,
    getDashboardById,
    fetchDashboardById,
    status,
    refetch,
  };
};
