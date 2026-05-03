import { api } from "@/lib/httpClient";
import type {
  PivotState,
  ActiveFilterSpec,
  ActiveFilterCondition,
  DimensionHierarchy,
} from "@/shared/schema";

/** Server response from /sessions/:sessionId/active-filter (PUT/DELETE/GET). */
export interface ActiveFilterResponse {
  ok: true;
  activeFilter: ActiveFilterSpec | null;
  totalRows: number;
  filteredRows: number;
  preview: Record<string, unknown>[];
  effectiveConditionCount: number;
}

export const sessionsApi = {
  getAllSessions: () => api.get("/api/sessions"),

  getSessionsPaginated: (pageSize: number = 10, continuationToken?: string) => {
    const params = new URLSearchParams({ pageSize: pageSize.toString() });
    if (continuationToken) {
      params.append("continuationToken", continuationToken);
    }
    return api.get(`/api/sessions/paginated?${params}`);
  },

  getSessionsFiltered: (filters: {
    startDate?: string;
    endDate?: string;
    fileName?: string;
    minMessageCount?: number;
    maxMessageCount?: number;
  }) => {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        params.append(key, value.toString());
      }
    });
    return api.get(`/api/sessions/filtered?${params}`);
  },

  getSessionStatistics: () => api.get("/api/sessions/statistics"),

  getSessionDetails: (sessionId: string) =>
    api.get(`/api/sessions/details/${sessionId}`),

  getSessionsByUser: (username: string) =>
    api.get(`/api/sessions/user/${username}`),

  updateSessionName: (sessionId: string, fileName: string) =>
    api.patch(`/api/sessions/${sessionId}`, { fileName }),

  updateSessionContext: (sessionId: string, permanentContext: string) =>
    api.patch(`/api/sessions/${sessionId}/context`, { permanentContext }),

  /** EU1 — replace the dimensionHierarchies array on a session. */
  updateSessionHierarchies: (
    sessionId: string,
    hierarchies: DimensionHierarchy[],
  ) =>
    api.put(`/api/sessions/${encodeURIComponent(sessionId)}/hierarchies`, {
      hierarchies,
    }),

  deleteSession: (sessionId: string) => api.delete(`/api/sessions/${sessionId}`),

  getSessionAnalysisContext: (sessionId: string) =>
    api.get(`/api/sessions/${sessionId}/analysis-context`),

  /**
   * W-PivotState · persist (or clear with `null`) the per-message pivot + chart
   * UI state so the user's view is restored on reopen and is visible to the
   * agent on follow-up turns. Called debounced from `DataPreviewTable`.
   */
  updateMessagePivotState: (
    sessionId: string,
    messageTimestamp: number,
    pivotState: PivotState | null
  ) =>
    api.patch(
      `/api/sessions/${sessionId}/messages/${messageTimestamp}/pivot-state`,
      { pivotState }
    ),

  /**
   * Wave-FA3 · Per-session non-destructive filter overlay. Clearing returns the
   * canonical row count; setting returns the filtered count + 50-row preview.
   */
  getActiveFilter: (sessionId: string) =>
    api.get<ActiveFilterResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/active-filter`
    ),

  setActiveFilter: (sessionId: string, conditions: ActiveFilterCondition[]) =>
    api.put<ActiveFilterResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/active-filter`,
      { conditions }
    ),

  clearActiveFilter: (sessionId: string) =>
    api.delete<ActiveFilterResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/active-filter`
    ),
};


