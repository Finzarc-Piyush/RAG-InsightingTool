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
  DashboardScorecardSpec,
  DashboardSpec,
  DashboardTableSpec,
  DashboardCardDefinition,
} from "@/shared/schema";
import type { Layouts } from "react-grid-layout";

/** Wave W9 · guided-card-builder picker metadata (measures + dimensions). */
export interface BuilderMeasure {
  ref: string;
  kind: "metric" | "column";
  label: string;
  format: "number" | "percent" | "currency" | "ratio" | "duration";
  currencyCode?: string;
  allowedAggregations: Array<"sum" | "avg" | "count" | "min" | "max" | "median">;
  defaultAggregation: "sum" | "avg" | "count" | "min" | "max" | "median";
}
export interface BuilderDimension {
  column: string;
  label: string;
  kind: "categorical" | "temporal";
  values?: Array<{ value: string | number; count: number }>;
  hasTopValues: boolean;
}
export interface BuilderMetadata {
  measures: BuilderMeasure[];
  dimensions: BuilderDimension[];
}

/** Wave W12 · live-preview response from /tiles/preview. */
export type TilePreviewResult =
  | { ok: true; cardType: "scorecard"; scorecard: DashboardScorecardSpec }
  | { ok: true; cardType: "chart"; chart: ChartSpec }
  | { ok: true; cardType: "table"; table: DashboardTableSpec };

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
    updates: {
      keyInsight?: string;
      /** Wave S6 · persist the chart's "Sort by" choice. */
      sort?: { by: "value" | "category"; direction: "asc" | "desc" };
      /** Persist the chart's Top-N / Bottom-N selection; `null` clears it. */
      limit?: { mode: "top" | "bottom"; n: number } | null;
      /** W6/W7 · persist the parity toolbar's mark switch / layout / labels. */
      type?: string;
      barLayout?: "grouped" | "stacked";
      dataLabels?: boolean;
    },
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
  /** Wave W8 (data-bound cards) · re-run every Executive-Summary scorecard's
   *  query against the current dataset and persist refreshed snapshots. */
  recomputeScorecards: (dashboardId: string) =>
    api.post<Dashboard>(`/api/dashboards/${dashboardId}/scorecards/recompute`, {}),
  /** Wave W9 · guided card builder — measures + dimensions the picker offers. */
  getBuilderMetadata: (dashboardId: string) =>
    api.get<BuilderMetadata>(`/api/dashboards/${dashboardId}/builder-metadata`),
  /** Wave W12 · live-preview a composed card (no persist). */
  previewTile: (
    dashboardId: string,
    cardDefinition: DashboardCardDefinition,
    title?: string
  ) =>
    api.post<TilePreviewResult>(`/api/dashboards/${dashboardId}/tiles/preview`, {
      cardDefinition,
      title,
    }),
  /** Wave W12 · compose + persist a data-bound card (returns the updated dashboard). */
  composeTile: (
    dashboardId: string,
    cardDefinition: DashboardCardDefinition,
    opts?: { sheetId?: string; title?: string }
  ) =>
    api.post<Dashboard>(`/api/dashboards/${dashboardId}/tiles/compose`, {
      cardDefinition,
      sheetId: opts?.sheetId,
      title: opts?.title,
    }),
  /** Wave DR5 · atomic sheet reorder. Body: full ordered id list. */
  reorderSheets: (dashboardId: string, orderedSheetIds: string[]) =>
    api.post<Dashboard>(
      `/api/dashboards/${dashboardId}/sheets/reorder`,
      { orderedSheetIds }
    ),
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


