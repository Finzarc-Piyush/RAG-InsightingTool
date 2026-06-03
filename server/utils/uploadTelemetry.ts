/**
 * Phase 0 · large-dataset telemetry.
 *
 * Emits one structured, grep-able line per upload so we can baseline row count /
 * ingestion path / memory / duration BEFORE the Phases 1–3 re-architecture and
 * measure the improvement after. No external dependency — uses the codebase's
 * console-logging convention with a JSON tail for easy extraction.
 */

export type UploadPath =
  | 'snowflake'
  | 'chunking'
  | 'large-file'
  | 'in-memory'
  | 'unknown';

export interface UploadTelemetry {
  sessionId: string;
  jobId: string;
  source: 'file' | 'snowflake';
  /** Which ingestion branch actually ran (after any fallback). */
  path: UploadPath;
  rowCount: number;
  columnCount: number;
  fileBytes?: number;
  durationMs: number;
  /** Resident-set-size sample (MB) at completion — a cheap proxy for peak. */
  rssMb: number;
  /** Number of warnings attached to the job (truncation, parse quality, …). */
  warnings: number;
}

/** Current resident set size in MB (rounded). */
export function currentRssMb(): number {
  return Math.round(process.memoryUsage().rss / (1024 * 1024));
}

/** Emit one structured telemetry line. Never throws (callers wrap defensively too). */
export function logUploadTelemetry(t: UploadTelemetry): void {
  try {
    console.log(`📈 upload-telemetry ${JSON.stringify(t)}`);
  } catch {
    /* telemetry must never break an upload */
  }
}
