import { api } from "@/lib/httpClient";

export interface UploadJobStatusResponse {
  jobId: string;
  sessionId: string;
  status: string;
  progress: number;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  result?: unknown;
  previewReady?: boolean;
  enrichmentStatus?: string;
  /** Server hint: session has data but LLM enrichment not finished */
  enrichmentPhase?: "waiting" | "enriching";
}

export async function getUploadJobStatus(
  jobId: string
): Promise<UploadJobStatusResponse> {
  return api.get<UploadJobStatusResponse>(`/api/upload/status/${jobId}`);
}
