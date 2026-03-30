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
  jobId: string
): Promise<UploadJobStatusResponse> {
  return api.get<UploadJobStatusResponse>(`/api/upload/status/${jobId}`);
}
