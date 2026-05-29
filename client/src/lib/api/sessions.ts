import { api } from "@/lib/httpClient";
import type {
  PivotState,
  ActiveFilterSpec,
  ActiveFilterCondition,
  DateTimeColumnPair,
  DimensionHierarchy,
  UserDirective,
} from "@/shared/schema";

/** SU-UX1 · payload shape mirroring the per-column indicator metadata. */
export interface IndicatorAnnotationPayload {
  column: string;
  kind: "boolean" | "categorical";
  positiveValues?: string[];
  negativeValues?: string[];
  sentinelValues?: string[];
}

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

  /**
   * Toggle/set the sidebar pin flag on a session. Pinned sessions sort to the
   * top of the Recent Sessions list. Server stamps `pinnedAt` to now when
   * `pinned=true`, clears it when `pinned=false`.
   */
  updateSessionPinned: (sessionId: string, pinned: boolean) =>
    api.patch(`/api/sessions/${sessionId}`, { pinned }),

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

  /**
   * SU-UX1 — replace dataSummary's schema-annotation arrays. Either field is
   * optional; pass `[]` to clear. The server stamps `source: "user"` on
   * everything in the new arrays.
   */
  updateSchemaAnnotations: (
    sessionId: string,
    payload: {
      dateTimeColumnPairs?: DateTimeColumnPair[];
      indicators?: IndicatorAnnotationPayload[];
    },
  ) =>
    api.put<{
      success: true;
      dateTimeColumnPairs?: DateTimeColumnPair[];
      indicators: Array<{ column: string; kind: "boolean" | "categorical" }>;
    }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/schema-annotations`,
      payload,
    ),

  deleteSession: (sessionId: string) => api.delete(`/api/sessions/${sessionId}`),

  /**
   * Wave W-UD9 · list per-dataset directives for the session's dataset
   * fingerprint. Returns both the full directive list (for the audit
   * panel) and the active subset (status === "active").
   */
  listDirectives: (sessionId: string) =>
    api.get<{
      sessionId: string;
      datasetFingerprint: string | null;
      directives: UserDirective[];
      activeDirectives: UserDirective[];
      updatedAt?: number;
      version?: number;
    }>(`/api/sessions/${encodeURIComponent(sessionId)}/directives`),

  /** Wave W-UD9 · revoke (soft-delete) a directive. Audit row is preserved. */
  revokeDirective: (sessionId: string, directiveId: string) =>
    api.delete<{
      success: true;
      directiveId: string;
      datasetFingerprint: string;
      activeDirectives: UserDirective[];
    }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/directives/${encodeURIComponent(directiveId)}`
    ),

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


