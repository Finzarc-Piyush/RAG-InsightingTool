import { api, apiClient } from "@/lib/httpClient";
import { getAuthorizationHeader } from "@/auth/msalToken";
import { getUserEmail } from "@/utils/userStorage";
import {
  ChartSpec,
  CreateReportDashboardRequest,
  Dashboard,
  DashboardNarrativeBlock,
  DashboardPatch,
  DashboardPivotSpec,
  DashboardSpec,
  DashboardTableSpec,
} from "@/shared/schema";
import type { Layouts } from "react-grid-layout";

export const dashboardsApi = {
  list: () => api.get<{ dashboards: Dashboard[] }>("/api/dashboards"),
  get: (dashboardId: string) => api.get<Dashboard>(`/api/dashboards/${dashboardId}`),
  create: (name: string, charts?: ChartSpec[]) =>
    api.post<Dashboard>("/api/dashboards", { name, charts }),
  remove: (dashboardId: string) => api.delete(`/api/dashboards/${dashboardId}`),
  addChart: (dashboardId: string, chart: ChartSpec, sheetId?: string) =>
    api.post<Dashboard>(`/api/dashboards/${dashboardId}/charts`, { chart, sheetId }),
  addTable: (dashboardId: string, table: DashboardTableSpec, sheetId?: string) =>
    api.post<Dashboard>(`/api/dashboards/${dashboardId}/tables`, { table, sheetId }),
  removeChart: (
    dashboardId: string,
    payload: { index?: number; title?: string; type?: ChartSpec["type"]; sheetId?: string }
  ) => api.delete<Dashboard>(`/api/dashboards/${dashboardId}/charts`, { data: payload as any }),
  removeTable: (dashboardId: string, payload: { index: number; sheetId?: string }) =>
    api.delete<Dashboard>(`/api/dashboards/${dashboardId}/tables`, { data: payload }),
  addPivot: (dashboardId: string, pivot: DashboardPivotSpec, sheetId?: string) =>
    api.post<Dashboard>(`/api/dashboards/${dashboardId}/pivots`, { pivot, sheetId }),
  removePivot: (dashboardId: string, payload: { index: number; sheetId?: string }) =>
    api.delete<Dashboard>(`/api/dashboards/${dashboardId}/pivots`, { data: payload }),
  addSheet: (dashboardId: string, name: string) =>
    api.post<Dashboard>(`/api/dashboards/${dashboardId}/sheets`, { name }),
  removeSheet: (dashboardId: string, sheetId: string) =>
    api.delete<Dashboard>(`/api/dashboards/${dashboardId}/sheets/${sheetId}`),
  renameSheet: (dashboardId: string, sheetId: string, name: string) =>
    api.patch<Dashboard>(`/api/dashboards/${dashboardId}/sheets/${sheetId}`, { name }),
  rename: (dashboardId: string, name: string) =>
    api.patch<Dashboard>(`/api/dashboards/${dashboardId}`, { name }),
  updateChartInsightOrRecommendation: (
    dashboardId: string,
    chartIndex: number,
    updates: { keyInsight?: string },
    sheetId?: string
  ) =>
    api.patch<Dashboard>(`/api/dashboards/${dashboardId}/charts/${chartIndex}`, {
      sheetId,
      ...updates,
    }),
  updateTableCaption: (
    dashboardId: string,
    tableIndex: number,
    updates: { caption: string },
    sheetId?: string
  ) =>
    api.patch<Dashboard>(`/api/dashboards/${dashboardId}/tables/${tableIndex}`, {
      sheetId,
      ...updates,
    }),
  createFromAnalysis: (body: CreateReportDashboardRequest) =>
    api.post<Dashboard>("/api/dashboards/from-analysis", body),
  /**
   * Phase 2 — commit an agent-emitted DashboardSpec from the chat preview card.
   *
   * `sessionId` (Phase 2.E) is optional but strongly recommended: the
   * server stamps `chatDocument.lastCreatedDashboardId` so the
   * `patch_dashboard` agent tool can resolve "the dashboard we just
   * built" on follow-up turns without the user restating the id.
   */
  createFromSpec: (spec: DashboardSpec, sessionId?: string) =>
    api.post<Dashboard>("/api/dashboards/from-spec", { spec, sessionId }),
  /** Phase 2.E — atomic follow-up edits to an existing dashboard. */
  patch: (dashboardId: string, patch: DashboardPatch) =>
    api.post<Dashboard>(`/api/dashboards/${dashboardId}/patch`, { patch }),
  patchSheetContent: (
    dashboardId: string,
    sheetId: string,
    body: {
      narrativeBlocks?: DashboardNarrativeBlock[];
      gridLayout?: Layouts;
    }
  ) =>
    api.patch<Dashboard>(
      `/api/dashboards/${dashboardId}/sheets/${sheetId}/content`,
      body
    ),
  exportDashboard: async (dashboardId: string, format: "pdf" | "pptx") => {
    const auth = await getAuthorizationHeader();
    const userEmail = getUserEmail();
    const res = await apiClient.post(
      `/api/dashboards/${dashboardId}/export`,
      { format },
      {
        responseType: "blob",
        headers: {
          ...auth,
          "Content-Type": "application/json",
          ...(userEmail ? { "X-User-Email": userEmail } : {}),
        },
      }
    );
    const cd = res.headers["content-disposition"] as string | undefined;
    const nameMatch = cd?.match(/filename="([^"]+)"/);
    const filename =
      nameMatch?.[1] ?? `dashboard.${format === "pdf" ? "pdf" : "pptx"}`;
    const url = URL.createObjectURL(res.data as Blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  },
};


