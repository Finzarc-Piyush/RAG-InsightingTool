import { api } from "@/lib/httpClient";
import type { AnalysisMemoryEntry } from "@shared/schema";

export interface MemoryListResponse {
  entries: AnalysisMemoryEntry[];
  count: number;
  nextCursor: number | null;
}

export interface MemorySearchHit {
  chunkId: string;
  chunkType: string;
  content: string;
  score?: number;
}

export interface MemorySearchResponse {
  hits: MemorySearchHit[];
  query: string;
  retrievalError?: string;
  diagnostics?: { meanSimilarity: number };
}

export const analysisMemoryApi = {
  list: (
    sessionId: string,
    opts: { types?: string[]; cursor?: number; limit?: number } = {}
  ): Promise<MemoryListResponse> => {
    const params = new URLSearchParams();
    if (opts.types?.length) params.set("type", opts.types.join(","));
    if (opts.cursor) params.set("cursor", String(opts.cursor));
    if (opts.limit) params.set("limit", String(opts.limit));
    const qs = params.toString();
    return api.get(
      `/api/sessions/${sessionId}/memory${qs ? `?${qs}` : ""}`
    );
  },

  search: (
    sessionId: string,
    query: string,
    k = 12
  ): Promise<MemorySearchResponse> => {
    const params = new URLSearchParams({ q: query, k: String(k) });
    return api.get(
      `/api/sessions/${sessionId}/memory/search?${params.toString()}`
    );
  },

  exportUrl: (
    sessionId: string,
    format: "markdown" | "json" = "markdown"
  ): string =>
    `/api/sessions/${sessionId}/memory/export?format=${format}`,
};
