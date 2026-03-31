import { api } from "@/lib/httpClient";
import {
  ColumnStatisticsResponse,
  CompleteAnalysisData,
  RawDataResponse,
  UserAnalysisSessionsResponse,
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


