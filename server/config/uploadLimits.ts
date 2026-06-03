/**
 * Central, env-driven limits for upload, ingestion, and profiling.
 *
 * Phase 0 (large-dataset robustness) consolidates limits that were previously
 * scattered as hardcoded literals across `routes/upload.ts`, `utils/uploadQueue.ts`,
 * `lib/largeFileProcessor.ts`, `lib/snowflakeService.ts` and
 * `controllers/sessionController.ts` so they are documented in one place and
 * overridable per environment.
 *
 * Values are exposed as getters that read `process.env` on each access. This keeps
 * unit tests able to override env at runtime and sidesteps any import-order
 * dependency on `loadEnv.ts` (invariant #3) — there is no frozen module-load read.
 */

/** Parse a positive-number env var, falling back when unset / blank / invalid. */
export function envPositiveInt(envVar: string, fallback: number): number {
  const raw = process.env[envVar];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const MB = 1024 * 1024;

export const uploadLimits = {
  /** Max multipart upload size (bytes). Backstop against in-memory OOM. */
  get maxUploadBytes(): number {
    return envPositiveInt("UPLOAD_MAX_BYTES", 200 * MB);
  },
  /** File size at/above which the chunked ingestion path is used (bytes). */
  get chunkingThresholdBytes(): number {
    return envPositiveInt("CHUNKING_THRESHOLD_BYTES", 10 * MB);
  },
  /** File size at/above which DuckDB native large-file processing is used (bytes). */
  get largeFileThresholdBytes(): number {
    return envPositiveInt("LARGE_FILE_THRESHOLD_BYTES", 50 * MB);
  },
  /** Max rows loaded into memory for LLM analysis sampling. */
  get maxRowsForAiAnalysis(): number {
    return envPositiveInt("MAX_ROWS_FOR_AI_ANALYSIS", 100_000);
  },
  /** Max rows imported from a Snowflake table in one pull (truncation point). */
  get snowflakeMaxImportRows(): number {
    return envPositiveInt("SNOWFLAKE_MAX_IMPORT_ROWS", 500_000);
  },
  /** Max rows used to compute the on-demand data-summary profile. */
  get maxRowsForDataSummaryProfile(): number {
    return envPositiveInt("MAX_ROWS_FOR_DATA_SUMMARY_PROFILE", 300_000);
  },
  /**
   * Estimated row ceiling for in-memory Excel (.xlsx) parsing before we refuse
   * with an actionable error instead of OOMing. SheetJS has no streaming path;
   * Phase 2 removes this guard by streaming Excel ingest. Tunable per environment.
   */
  get maxExcelRowsInMemory(): number {
    return envPositiveInt("MAX_EXCEL_ROWS_IN_MEMORY", 1_000_000);
  },
} as const;
