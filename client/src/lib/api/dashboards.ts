import { api } from "@/lib/httpClient";
import { ChartSpec, Dashboard, DashboardTableSpec } from "@/shared/schema";

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
};


