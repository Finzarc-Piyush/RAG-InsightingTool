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
    api.get<RichDataSummaryResponse>(
      `/api/sessions/${sessionId}/data-summary`,
    ),
};

/* ------------------------------------------------------------------ *
 * Rich, type-aware data-summary response (GET /sessions/:id/data-summary)
 * Mirrors server/lib/richColumnProfile.ts. Each column carries only the
 * statistics that are meaningful for its kind.
 * ------------------------------------------------------------------ */

export type ColumnKind = "numeric" | "date" | "categorical" | "boolean";

export interface BaseColumnProfile {
  name: string;
  kind: ColumnKind;
  datatypeLabel: string;
  totalValues: number;
  nullCount: number;
  nullPct: number;
  completeness: number;
  distinctCount: number;
}

export interface NumericColumnProfile extends BaseColumnProfile {
  kind: "numeric";
  nonNumericCount: number;
  mean: number | null;
  median: number | null;
  std: number | null;
  variance: number | null;
  min: number | null;
  max: number | null;
  range: number | null;
  q1: number | null;
  q3: number | null;
  iqr: number | null;
  p5: number | null;
  p95: number | null;
  sum: number | null;
  zeroCount: number;
  negativeCount: number;
  outlierCount: number;
  skewness: number | null;
  cv: number | null;
  integerLike: boolean;
  currencySymbol: string | null;
  histogram: Array<{ x0: number; x1: number; count: number }>;
}

export interface DateColumnProfile extends BaseColumnProfile {
  kind: "date";
  minIso: string | null;
  maxIso: string | null;
  spanDays: number | null;
  distinctDayCount: number;
  unparseableCount: number;
  grain: "dayOrWeek" | "monthOrQuarter" | "year" | null;
  timeline: Array<{ label: string; count: number }>;
}

export interface CategoricalColumnProfile extends BaseColumnProfile {
  kind: "categorical" | "boolean";
  mode: string | number | null;
  topValues: Array<{ value: string | number; count: number; pct: number }>;
  otherCount: number;
  otherPct: number;
  cardinalityRatio: number;
  isHighCardinality: boolean;
  isLikelyId: boolean;
  isConstant: boolean;
  minLength: number | null;
  maxLength: number | null;
  avgLength: number | null;
  positiveValues?: string[];
  negativeValues?: string[];
}

export type RichColumnProfile =
  | NumericColumnProfile
  | DateColumnProfile
  | CategoricalColumnProfile;

export interface RichDataSummaryResponse {
  dataset: {
    rowCount: number;
    columnCount: number;
    typeBreakdown: {
      numeric: number;
      date: number;
      categorical: number;
      boolean: number;
    };
    totalCells: number;
    totalNulls: number;
    overallCompleteness: number;
    duplicateRowCount: number | null;
  };
  qualityScore: number;
  columns: RichColumnProfile[];
}

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
 *
 * Used by the pivot FILTERS shelf and per-header slice filters. Returns the
 * full distinct set — the same authoritative DuckDB `data` table the agent
 * tools see — so the FILTERS popover never silently truncates the user's
 * choices. The 100k limit is a defensive ceiling, not a paging window: any
 * realistic FMCG dimension column (regions, brands, products, SKUs, months)
 * is well below it. If a column ever genuinely has >100k distinct values,
 * a checkbox-list filter is the wrong UX shape anyway.
 *
 * Wave-FA · `excludeColumn` opt-in produces Excel cross-column filtering: the
 * server narrows the value list by other active-filter conditions but
 * excludes any condition on the column being requested (so "Region" filter
 * shows all Regions, narrowed only by "Country", "Year", etc.).
 *
 * `unfiltered=true` forces the canonical, unfiltered value list — used by the
 * filter UI's first-load to show the user every possible value.
 */
export async function fetchPivotColumnDistincts(
  sessionId: string,
  column: string,
  limit = 100_000,
  options?: { excludeColumn?: string; unfiltered?: boolean }
): Promise<string[]> {
  const params = new URLSearchParams({ column, limit: String(limit) });
  if (options?.excludeColumn) params.set("excludeColumn", options.excludeColumn);
  if (options?.unfiltered) params.set("unfiltered", "true");
  const res = await api.get<PivotFieldsColumnDistinctResponse>(
    `/api/data/${encodeURIComponent(sessionId)}/pivot/fields?${params.toString()}`
  );
  const raw = res.fields?.[0]?.distinctValues;
  if (!Array.isArray(raw)) return [];
  return raw.map((v) => (v === null || v === undefined ? '' : String(v)));
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


