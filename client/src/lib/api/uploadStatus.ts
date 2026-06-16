import { api } from "@/lib/httpClient";

export type EnrichmentStep = "inferring_profile" | "dirty_date_enrichment" | "building_context" | "persisting";
export type UploadPhase = "uploading" | "queued" | "preparing_preview" | "enriching" | "finalizing" | "completed" | "failed";

/** Latest upload poll fields for enrichment UX (while job polling is active). */
export interface DatasetEnrichmentPollSnapshot {
  uploadProgress: number;
  phase?: UploadPhase;
  phaseMessage?: string;
  enrichmentPhase?: "waiting" | "enriching";
  enrichmentStep?: EnrichmentStep;
  understandingReady?: boolean;
}

export interface UploadJobStatusResponse {
  jobId: string;
  sessionId: string;
  status: string;
  progress: number;
  phase?: UploadPhase;
  phaseMessage?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  result?: unknown;
  previewReady?: boolean;
  enrichmentStatus?: string;
  /** Server hint: session has data but LLM enrichment not finished */
  enrichmentPhase?: "waiting" | "enriching";
  /** In-memory upload job: coarse step during post-preview enrichment */
  enrichmentStep?: EnrichmentStep;
  understandingReady?: boolean;
  understandingReadyAt?: number;
  suggestedQuestions?: string[];
  /** Non-fatal processing warnings (e.g. Snowflake truncation, CSV parse quality). */
  warnings?: string[];
  /** Optional fast-path payload for immediate preview rendering */
  previewSummary?: {
    rowCount: number;
    columnCount: number;
    columns: Array<{ name: string; type: string }>;
    numericColumns?: string[];
    dateColumns?: string[];
  };
  previewSampleRows?: Record<string, any>[];
  /** Ready-state hint for preview payload completeness */
  previewPayloadState?: "none" | "summary_only" | "full";
}

export async function getUploadJobStatus(
  jobId: string,
  sessionId?: string
): Promise<UploadJobStatusResponse> {
  // DATA-2 · pass the sessionId so a status poll that lands on a non-owning
  // server instance (or after a cold start) can resolve from the durable
  // Cosmos doc's persisted enrichmentStatus instead of the instance-pinned
  // in-memory job Map. Backward-compatible: omitting it preserves the old
  // jobId-only URL.
  const qs = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
  return api.get<UploadJobStatusResponse>(`/api/upload/status/${jobId}${qs}`);
}
