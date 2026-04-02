import { api } from "@/lib/httpClient";
import {
  ColumnStatisticsResponse,
  CompleteAnalysisData,
  RawDataResponse,
  UserAnalysisSessionsResponse,
  type PivotQueryRequest,
  type PivotQueryResponse,
} from "@/shared/schema";

/** Response from GET /api/data/:sessionId/sample */
export interface SessionSampleResponse {
  sessionId: string;
  rows: Record<string, unknown>[];
  count: number;
  limit: number;
  random: boolean;
}

/**
 * Row-level sample from the session columnar store (for pivot when preview is aggregated-only).
 * Legacy sessions that were persisted as aggregated-only tables cannot regain dropped dimensions
 * (e.g. City under Region) until the user reverts data-ops changes or re-uploads the source file.
 */
export async function fetchSessionSampleRows(
  sessionId: string,
  limit = 2000
): Promise<SessionSampleResponse> {
  return api.get<SessionSampleResponse>(
    `/api/data/${encodeURIComponent(sessionId)}/sample?limit=${limit}`
  );
}

export const dataApi = {
  getUserSessions: (username: string) =>
    api.get<UserAnalysisSessionsResponse>(`/data/user/${username}/sessions`),

  getAnalysisData: (chatId: string, username: string) =>
    api.get<CompleteAnalysisData>(`/data/chat/${chatId}?username=${username}`),

  getAnalysisDataBySession: (sessionId: string) =>
    api.get<CompleteAnalysisData>(`/data/session/${sessionId}`),

  getColumnStatistics: (chatId: string, username: string) =>
    api.get<ColumnStatisticsResponse>(
      `/data/chat/${chatId}/statistics?username=${username}`
    ),

  getRawData: (chatId: string, username: string, page = 1, limit = 100) =>
    api.get<RawDataResponse>(
      `/data/chat/${chatId}/raw-data?username=${username}&page=${page}&limit=${limit}`
    ),

  getSessionSampleRows: (sessionId: string, limit = 2000) =>
    api.get<SessionSampleResponse>(
      `/api/data/${encodeURIComponent(sessionId)}/sample?limit=${limit}`
    ),

  getDataSummary: (sessionId: string) =>
    api.get<{
      summary: Array<{
        variable: string;
        datatype: string;
        total_values: number;
        null_values: number;
        non_null_values: number;
        mean?: number | null;
        median?: number | null;
        mode?: any;
        std_dev?: number | null;
        min?: number | string | null;
        max?: number | string | null;
      }>;
      qualityScore: number;
      recommendedQuestions: string[];
    }>(`/api/sessions/${sessionId}/data-summary`),
};

export async function pivotQuery(
  sessionId: string,
  request: PivotQueryRequest
): Promise<PivotQueryResponse> {
  return api.post<PivotQueryResponse>(
    `/api/data/${encodeURIComponent(sessionId)}/pivot/query`,
    request
  );
}

/** Response shape for GET /api/data/:sessionId/pivot/fields?column=... */
export interface PivotFieldsColumnDistinctResponse {
  sessionId: string;
  fields: Array<{
    name: string;
    type?: string;
    cardinality?: number;
    distinctValues?: string[];
    hasMore?: boolean;
  }>;
}

/**
 * Distinct string values for a column from the session `data` table (full dataset).
 * Used for pivot filter UI when preview rows omit the column.
 */
export async function fetchPivotColumnDistincts(
  sessionId: string,
  column: string,
  limit = 2000
): Promise<string[]> {
  const res = await api.get<PivotFieldsColumnDistinctResponse>(
    `/api/data/${encodeURIComponent(sessionId)}/pivot/fields?column=${encodeURIComponent(column)}&limit=${limit}`
  );
  const vals = res.fields?.[0]?.distinctValues;
  if (!Array.isArray(vals)) return [];
  return vals.map((v) => (v === null || v === undefined ? '' : String(v)));
}

export interface PivotDrillthroughRequest {
  rowFields: string[];
  rowValues: string[];
  colField: string | null;
  colKey: string | null;
  filterFields: string[];
  filterSelections?: Record<string, string[]>;
  valueFields: string[];
  limit?: number;
}

export interface PivotDrillthroughResponse {
  sessionId: string;
  count: number;
  rows: Record<string, unknown>[];
}

export async function pivotDrillthrough(
  sessionId: string,
  request: PivotDrillthroughRequest
): Promise<PivotDrillthroughResponse> {
  return api.post<PivotDrillthroughResponse>(
    `/api/data/${encodeURIComponent(sessionId)}/pivot/drillthrough`,
    request
  );
}


