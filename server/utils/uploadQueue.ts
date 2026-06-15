/**
 * Upload Processing Queue
 * Handles async processing of large file uploads to prevent blocking
 */

import { randomUUID } from 'node:crypto';
import type { ChartSpec, Insight, SemanticModel, SessionAnalysisContext } from '../shared/schema.js';
import { mergeSuggestedQuestions } from '../lib/suggestedQuestions.js';
import { ColumnarStorageService } from '../lib/columnarStorage.js';
import { uploadLimits } from '../config/uploadLimits.js';
import { logUploadTelemetry, currentRssMb, type UploadPath } from './uploadTelemetry.js';
import { isParquetReadPathEnabled, writeAndUploadSessionParquet } from '../lib/sessionParquet.js';
import { logger } from "../lib/logger.js";
import { capChartDataPoints } from "../lib/chartDownsampling.js";
import { errorMessage } from "./errorMessage.js";

export interface SnowflakeImportConfig {
  tableName: string;
  database?: string;
  schema?: string;
  account?: string;
  username?: string;
  password?: string;
  warehouse?: string;
  role?: string;
  /** Known total row count from table metadata, for a richer truncation warning. */
  knownTotalRows?: number;
}

type UploadJobEnrichmentStep =
  | 'inferring_profile'
  | 'dirty_date_enrichment'
  | 'building_context'
  | 'persisting';

interface UploadJob {
  jobId: string;
  sessionId: string;
  username: string;
  fileName: string;
  fileBuffer?: Buffer;
  mimeType?: string;
  sheetName?: string;
  blobInfo?: { blobUrl: string; blobName: string };
  snowflakeImport?: SnowflakeImportConfig;
  status:
    | 'pending'
    | 'uploading'
    | 'parsing'
    | 'preview_ready'
    | 'analyzing'
    | 'saving'
    | 'completed'
    | 'failed';
  progress: number; // 0-100
  error?: string;
  result?: any;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  /** Client UX: coarse phase during post-preview enrichment (in-memory only). */
  enrichmentStep?: UploadJobEnrichmentStep;
  /** Understanding checkpoint: dataset profile/context is ready for UX suggestions. */
  understandingReady?: boolean;
  understandingReadyAt?: number;
  suggestedQuestions?: string[];
  warnings?: string[];
  blobPersisted?: boolean;
}

class UploadQueue {
  private jobs: Map<string, UploadJob> = new Map();
  private processing: Set<string> = new Set();
  private readonly MAX_CONCURRENT = 3; // Process max 3 files concurrently
  private readonly MAX_QUEUE_SIZE = 50;
  // Feature flag: compute detailed Python-based data summary statistics during upload
  // This can add significant time for large files, so it's disabled by default to
  // keep initial upload/analysis faster. When enabled, it populates dataSummaryStatistics
  // for the Data Summary modal during the initial upload instead of on-demand.
  private readonly ENABLE_UPLOAD_DATA_SUMMARY_STATS = false;

  /**
   * Add a new upload job to the queue
   */
  async enqueue(
    sessionId: string,
    username: string,
    fileName: string,
    fileBuffer: Buffer,
    mimeType: string,
    sheetName?: string,
    blobInfo?: { blobUrl: string; blobName: string }
  ): Promise<string> {
    if (this.jobs.size >= this.MAX_QUEUE_SIZE) {
      throw new Error('Upload queue is full. Please try again later.');
    }

    // SEC-1: jobIds must be unguessable — a guessable id (time prefix + Math.random)
    // combined with a missing ownership check is a cross-tenant IDOR. Use a CSPRNG.
    const jobId = `job_${randomUUID()}`;
    
    const job: UploadJob = {
      jobId,
      sessionId,
      username,
      fileName,
      fileBuffer,
      mimeType,
      sheetName,
      blobInfo,
      status: 'pending',
      progress: 0,
      createdAt: Date.now(),
    };

    this.jobs.set(jobId, job);
    
    // Start processing if not at max capacity
    this.processNext();
    
    return jobId;
  }

  /**
   * Add a Snowflake table import job (same queue, same status endpoint)
   */
  async enqueueSnowflakeImport(
    sessionId: string,
    username: string,
    fileName: string,
    snowflakeImport: SnowflakeImportConfig
  ): Promise<string> {
    if (this.jobs.size >= this.MAX_QUEUE_SIZE) {
      throw new Error('Upload queue is full. Please try again later.');
    }
    // SEC-1: jobIds must be unguessable — a guessable id (time prefix + Math.random)
    // combined with a missing ownership check is a cross-tenant IDOR. Use a CSPRNG.
    const jobId = `job_${randomUUID()}`;
    const job: UploadJob = {
      jobId,
      sessionId,
      username,
      fileName,
      snowflakeImport,
      status: 'pending',
      progress: 0,
      createdAt: Date.now(),
    };
    this.jobs.set(jobId, job);
    this.processNext();
    return jobId;
  }

  /**
   * Get job status
   */
  getJob(jobId: string): UploadJob | null {
    return this.jobs.get(jobId) || null;
  }

  /**
   * Process next job in queue
   */
  private async processNext(): Promise<void> {
    if (this.processing.size >= this.MAX_CONCURRENT) {
      return; // Already at max capacity
    }

    // Find next pending job
    const pendingJob = Array.from(this.jobs.values()).find(
      job => job.status === 'pending' && !this.processing.has(job.jobId)
    );

    if (!pendingJob) {
      return; // No pending jobs
    }

    this.processing.add(pendingJob.jobId);
    this.processJob(pendingJob).finally(() => {
      this.processing.delete(pendingJob.jobId);
      // Process next job
      this.processNext();
    });
  }

  /**
   * Process a single job
   */
  private async processJob(job: UploadJob): Promise<void> {
    const JOB_TIMEOUT = 120 * 60 * 1000; // 120 minutes timeout for large files
    const timeoutId = setTimeout(() => {
      if (job.status !== 'completed' && job.status !== 'failed') {
        job.status = 'failed';
        job.error = 'Processing timeout: File processing took too long. Please try with a smaller file or contact support.';
        job.completedAt = Date.now();
        logger.error(`⏱️ Upload job ${job.jobId} timed out after ${JOB_TIMEOUT / 1000 / 60} minutes`);
      }
    }, JOB_TIMEOUT);
    
    try {
      job.startedAt = Date.now();
      job.status = 'uploading';
      job.progress = 5;

      // Import processing functions dynamically to avoid circular dependencies
      const {
        parseFile,
        getAndClearLastCsvParseDiagnostics,
        createDataSummary,
        canonicalizeDateColumnValues,
        applyUploadPipelineWithProfile,
        resolveDateColumnsForUpload,
        warnSuspiciousDuplicateRowIdInSample,
      } = await import('../lib/fileParser.js');
      const { inferDatasetProfile, emptyDatasetProfile } = await import('../lib/datasetProfile.js');
      // Wave W-DPC1 · dataset-profile cache (skip the LLM call on re-uploads).
      const { fingerprintFromSummary } = await import('../lib/datasetFingerprint.js');
      const { readCachedProfile, writeCachedProfile, computeContextHash } = await import(
        '../models/datasetProfileCache.model.js'
      );
      const { processLargeFile, shouldUseLargeFileProcessing, getDataForAnalysis } = await import('../lib/largeFileProcessor.js');
      const {
        createChatDocument,
        generateColumnStatistics,
        getChatBySessionIdEfficient,
        updateChatDocument,
        ensureChatDocumentForUploadJob,
      } = await import('../models/chat.model.js');
      const { saveChartsToBlob, uploadFileToBlob } = await import('../lib/blobStorage.js');
      const queryCache = (await import('../lib/cache.js')).default;

      // W29 · initialise to `[]` so tsc's flow analysis (which can't prove
      // every branch assigns) stops complaining. Production-proven safe:
      // every reachable path assigns before reading. The empty default is a
      // no-op in those paths.
      let data: Record<string, any>[] = [];
      let summary: ReturnType<typeof createDataSummary>;
      let datasetProfile: ReturnType<typeof emptyDatasetProfile>;
      let storagePath: string | undefined;
      let chunkIndexBlob: { blobName: string; totalChunks: number; totalRows: number } | undefined;
      let useLargeFileProcessing = false;
      let useChunking = false;
      // Phase 2 (W2.0) · set only when USE_PARQUET_READ_PATH is on and the durable
      // Parquet was written after materialize; otherwise stays undefined (no-op).
      let parquetBlobInfo: { blobName: string; version: number; rowCount?: number } | undefined;
      // Durable, enrichment-exact copy of the authoritative `data` rows, written
      // after materialize so a cold /tmp reloads the EXACT upload-time rows via
      // loadLatestData's currentDataBlob priority instead of re-parsing the
      // original blob (which loses enrichment and silently zeroes measures).
      let enrichedDataBlobInfo:
        | { blobUrl: string; blobName: string; version: number; lastUpdated: number }
        | undefined;
      let skipDateEnrichmentForSuspiciousCsv = false;

      // Keep Blob as best-effort and off the /upload critical path.
      if (job.fileBuffer && !job.blobInfo) {
        try {
          job.blobInfo = await uploadFileToBlob(
            job.fileBuffer,
            job.fileName,
            job.username,
            job.mimeType
          );
          job.blobPersisted = true;
        } catch (blobError) {
          job.blobPersisted = false;
          logger.warn("⚠️ Queue blob upload failed; continuing without blobInfo:", blobError);
        }
      } else if (job.blobInfo) {
        job.blobPersisted = true;
      }

      // Wave QL10 · Idempotent placeholder ensure. Normally the upload
      // controller (uploadController.ts) has already created the doc
      // synchronously before enqueue; `ensureChatDocumentForUploadJob`
      // checks existence first and short-circuits when found, so this is
      // a no-op on the happy path. The fallback path remains for non-HTTP
      // callers (tests, recovery flows, the Snowflake controller which
      // does its own pre-create).
      //
      // Using the bare `createPlaceholderSession` here would have created
      // a SECOND chat row (chatId is derived from `${fileName}_${ts}` —
      // different ts → different id, but same sessionId), polluting the
      // user's session list.
      try {
        await ensureChatDocumentForUploadJob({
          sessionId: job.sessionId,
          username: job.username,
          fileName: job.fileName,
          fileSize: job.fileBuffer?.length ?? 0,
          blobInfo: job.blobInfo,
        });
      } catch (placeholderError: any) {
        logger.warn("⚠️ Queue placeholder ensure skipped (will self-heal later):", {
          sessionId: job.sessionId,
          error: placeholderError?.message || String(placeholderError),
        });
      }

      // Snowflake import: fetch raw rows (enrichment applies profile after preview checkpoint)
      if (job.snowflakeImport) {
        job.status = 'parsing';
        job.progress = 10;
        const { fetchTableData, snowflakeTruncationWarning } = await import('../lib/snowflakeService.js');
        const imported = await fetchTableData(job.snowflakeImport);
        data = imported.rows;
        if (!data || data.length === 0) {
          throw new Error('No data found in Snowflake table');
        }
        const truncWarn = snowflakeTruncationWarning(imported);
        if (truncWarn) {
          job.warnings = [...(job.warnings || []), truncWarn];
          logger.warn(`⚠️ ${truncWarn}`);
        }
        job.progress = 40;
      } else if (job.fileBuffer) {
        // File upload path
        useLargeFileProcessing = shouldUseLargeFileProcessing(job.fileBuffer.length);
        useChunking = job.fileBuffer.length >= uploadLimits.chunkingThresholdBytes; // default 10MB

      // Try chunking first for files >= 10MB (faster upload and query)
      if (useChunking) {
        try {
          const { chunkFile } = await import('../lib/chunkingService.js');
          logger.log(`📦 File is ${(job.fileBuffer.length / 1024 / 1024).toFixed(2)}MB. Using chunking for faster processing...`);
          
          job.status = 'parsing';
          job.progress = 5;
          
          // Parse file first to get summary (needed for chunking)
          const tempData = await parseFile(job.fileBuffer, job.fileName, { sheetName: job.sheetName });
          if (tempData.length === 0) {
            throw new Error('No data found in file');
          }
          
          const emptyProf = emptyDatasetProfile();
          const interimChunkSummary = createDataSummary(tempData);
          const summaryForChunk = {
            ...interimChunkSummary,
            dateColumns: resolveDateColumnsForUpload(tempData, emptyProf),
          };

          job.progress = 10;

          // Chunk the file
          const chunkIndex = await chunkFile(
            job.fileBuffer,
            job.sessionId,
            job.fileName,
            summaryForChunk,
            (progress) => {
              job.progress = 10 + Math.floor(progress.progress * 0.3); // Use 30% of progress for chunking
              if (progress.message) {
                logger.log(`  ${progress.message}`);
              }
            }
          );
          
          chunkIndexBlob = {
            blobName: `chunks/${job.sessionId}/index.json`,
            totalChunks: chunkIndex.totalChunks,
            totalRows: chunkIndex.totalRows,
          };
          
          // OPTIMIZATION: For very large files, load only a sample of chunks for AI analysis
          // This dramatically speeds up processing while maintaining statistical accuracy
          const { loadChunkData } = await import('../lib/chunkingService.js');
          const MAX_ROWS_FOR_AI = uploadLimits.maxRowsForAiAnalysis; // default 100K rows for AI analysis
          const shouldSampleChunks = chunkIndex.totalRows > MAX_ROWS_FOR_AI;
          
          if (shouldSampleChunks) {
            // Load chunks proportionally to get ~100K rows
            const targetChunks = Math.ceil((MAX_ROWS_FOR_AI / chunkIndex.totalRows) * chunkIndex.totalChunks);
            const chunksToLoad = Math.min(targetChunks, chunkIndex.totalChunks);
            const step = Math.floor(chunkIndex.totalChunks / chunksToLoad);
            const sampledChunks = chunkIndex.chunks.filter((_, idx) => idx % step === 0).slice(0, chunksToLoad);
            logger.log(`📦 Loading ${sampledChunks.length} of ${chunkIndex.totalChunks} chunks (sampled from ${chunkIndex.totalRows} rows) for faster AI analysis...`);
            data = await loadChunkData(sampledChunks);
            logger.log(`✅ Loaded ${data.length} rows (sampled) from ${chunkIndex.totalChunks} chunks (${chunkIndex.totalRows} rows total) for AI analysis`);
          } else {
            logger.log(`📦 Loading ALL ${chunkIndex.totalChunks} chunks for full data analysis (${chunkIndex.totalRows} rows total)...`);
            data = await loadChunkData(chunkIndex.chunks); // Load ALL chunks for smaller files
            logger.log(`✅ File chunked into ${chunkIndex.totalChunks} chunks (${chunkIndex.totalRows} rows total), loaded ${data.length} rows for AI analysis`);
          }
          job.progress = 40;
        } catch (chunkError) {
          logger.warn('⚠️ Chunking failed, falling back to standard processing:', chunkError);
          // Fall through to standard processing
          useChunking = false;
        }
      }

      if (!useChunking && useLargeFileProcessing) {
        // Use streaming and columnar storage for large files
        logger.log(`📦 Large file detected (${(job.fileBuffer.length / 1024 / 1024).toFixed(2)}MB). Using streaming pipeline...`);
        
        job.status = 'parsing';
        job.progress = 10;
        
        try {
          const result = await processLargeFile(
            job.fileBuffer,
            job.sessionId,
            job.fileName,
            (progress) => {
              job.progress = progress.progress;
              if (progress.message) {
                logger.log(`  ${progress.message}`);
              }
            }
          );
          
          storagePath = result.storagePath;

          logger.log(`📊 Loading ALL ${result.rowCount} rows for enrichment...`);
          data = await getDataForAnalysis(job.sessionId, undefined, undefined);
          logger.log(`✅ Large file processed: ${result.rowCount} rows, using ALL ${data.length} rows in memory`);
        } catch (largeFileError) {
          const errorMsg = errorMessage(largeFileError);
          throw new Error(`Failed to process large file: ${errorMsg}`);
        }
      } else if (!useChunking) {
        // Smaller in-memory parse (skip when chunking already populated `data`)
        job.status = 'parsing';
        job.progress = 15;
        try {
          data = await parseFile(job.fileBuffer, job.fileName, { sheetName: job.sheetName });
          const parseDiagnostics = getAndClearLastCsvParseDiagnostics();
          if (parseDiagnostics) {
            const mismatchWarnRatio = Number(process.env.CSV_MISMATCH_WARN_RATIO) || 0.015;
            const warning = `${parseDiagnostics.warning} Sample lines: ${parseDiagnostics.sampleRowNumbers.join(', ') || 'n/a'}`;
            job.warnings = [...(job.warnings || []), warning];
            if (parseDiagnostics.mismatchRatio >= mismatchWarnRatio) {
              skipDateEnrichmentForSuspiciousCsv = true;
              logger.warn(
                `⚠️ Skipping date enrichment due to suspicious CSV parse quality (${(parseDiagnostics.mismatchRatio * 100).toFixed(2)}% mismatched rows).`
              );
            }
          }
        } catch (parseError) {
          const errorMsg = errorMessage(parseError);
          if (errorMsg.includes('memory') || errorMsg.includes('heap') || errorMsg.includes('too large')) {
            throw new Error('File is too large to parse. Please try with a smaller file (under 100MB) or reduce the number of rows.');
          }
          throw new Error(`Failed to parse file: ${errorMsg}`);
        }
        
        if (data.length === 0) {
          throw new Error('No data found in file');
        }
        job.progress = 25;
      }
      } // end else if (job.fileBuffer)

      // Wide-format auto-melt: if the parsed dataset has period
      // headers (Q1 23, MAT Dec-24, Latest 12 Mths 2YA …) we reshape
      // it to long form HERE — before profile inference, summary
      // creation, DuckDB materialisation, RAG indexing — so every
      // downstream consumer sees a normal long-format table. The
      // original wide buffer remains in blob storage for download.
      // Feature-flag escape hatch: `WIDE_FORMAT_AUTO_MELT_ENABLED=false`.
      let wideFormatTransform: import('../shared/schema.js').WideFormatTransform | undefined;
      const wideFormatEnabled =
        process.env.WIDE_FORMAT_AUTO_MELT_ENABLED !== 'false' &&
        process.env.WIDE_FORMAT_AUTO_MELT_ENABLED !== '0';
      if (wideFormatEnabled && data.length > 0) {
        const { classifyDataset } = await import('../lib/wideFormat/classifyDataset.js');
        const { meltDataset } = await import('../lib/wideFormat/meltDataset.js');
        const headers = Object.keys(data[0] || {});
        const classification = classifyDataset(headers);
        if (classification.isWide) {
          const melted = meltDataset(data, classification);
          data = melted.rows;
          wideFormatTransform = {
            detected: true,
            shape: melted.summary.shape,
            idColumns: melted.summary.idColumns,
            meltedColumns: melted.summary.meltedColumns,
            periodCount: melted.summary.periodCount,
            periodColumn: melted.summary.periodColumn,
            periodIsoColumn: melted.summary.periodIsoColumn,
            periodKindColumn: melted.summary.periodKindColumn,
            valueColumn: melted.summary.valueColumn,
            metricColumn: melted.summary.metricColumn,
            detectedCurrencySymbol: melted.summary.detectedCurrencySymbol,
          };
          logger.log(
            `[upload:${job.sessionId}] wide-format auto-melt → shape=${melted.summary.shape}, ` +
              `${melted.summary.periodCount} period cols → ${data.length} long rows ` +
              `(${classification.reason})`
          );
        }
      }

      // Decorator: stamp wide-format metadata + Value-column currency
      // onto every DataSummary built from the (now long) data.
      const { applyWideFormatTransformToSummary } = await import(
        '../lib/wideFormat/applyWideFormatToSummary.js'
      );
      const decorateSummaryWithWideFormat = (
        summary: ReturnType<typeof createDataSummary>
      ): void => {
        if (!wideFormatTransform) return;
        applyWideFormatTransformToSummary(summary, wideFormatTransform);
      };

      // Options for applyTemporalFacetColumns: for melted wide-format data the
      // Period column's grain facets must derive from PeriodIso, not from
      // date-casting the human label. undefined for tidy datasets.
      const facetOptsForUpload = (): { periodDimension: { periodCol: string; isoCol: string } } | undefined =>
        wideFormatTransform
          ? {
              periodDimension: {
                periodCol: wideFormatTransform.periodColumn,
                isoCol: wideFormatTransform.periodIsoColumn,
              },
            }
          : undefined;

      const columnOrderBeforeClean = Object.keys(data[0] || {});

      const skipUploadLlm =
        process.env.DISABLE_UPLOAD_INITIAL_ANALYSIS === 'true' ||
        process.env.DISABLE_UPLOAD_INITIAL_ANALYSIS === '1';

      // Preview checkpoint: heuristic summary + 50 sample rows (no LLM).
      // Date columns for enrichment are chosen by the upload LLM; do not canonicalize preview on heuristics.
      const previewSummary = createDataSummary(data);
      decorateSummaryWithWideFormat(previewSummary);
      if (!skipUploadLlm) {
        previewSummary.dateColumns = [];
      }
      const previewSample = data.slice(0, 50).map((row) => {
        const serializedRow: Record<string, any> = {};
        for (const [key, value] of Object.entries(row)) {
          if (value instanceof Date) {
            serializedRow[key] = value.toISOString();
          } else {
            serializedRow[key] = value;
          }
        }
        return serializedRow;
      });
      const previewDateCols =
        skipUploadLlm && !skipDateEnrichmentForSuspiciousCsv ? previewSummary.dateColumns : [];
      canonicalizeDateColumnValues(previewSample, previewDateCols);
      if (previewDateCols.length > 0) {
        const { applyTemporalFacetColumns } = await import('../lib/temporalFacetColumns.js');
        applyTemporalFacetColumns(previewSample, previewDateCols, facetOptsForUpload());
      }
      warnSuspiciousDuplicateRowIdInSample(previewSample, `upload_preview:${job.sessionId}`);

      const previewDoc = await ensureChatDocumentForUploadJob({
        sessionId: job.sessionId,
        username: job.username,
        fileName: job.fileName,
        fileSize: job.fileBuffer?.length ?? 0,
        blobInfo: job.blobInfo,
      });
      await updateChatDocument({
        ...previewDoc,
        dataSummary: previewSummary,
        sampleRows: previewSample,
        selectedSheetName: job.sheetName,
        enrichmentStatus: 'in_progress' as const,
        lastUpdatedAt: Date.now(),
      });
      job.status = 'preview_ready';
      job.progress = Math.max(job.progress, 32);

      let sessionAnalysisContext: SessionAnalysisContext;
      if (skipUploadLlm) {
        job.enrichmentStep = 'persisting';
        const { emptySessionAnalysisContext } = await import('../lib/sessionAnalysisContext.js');
        const { suggestedFollowUpsFromDataSummary } = await import(
          '../lib/suggestedFollowUpsFromSummary.js'
        );
        datasetProfile = emptyDatasetProfile();
        if (skipDateEnrichmentForSuspiciousCsv) {
          summary = createDataSummary(data);
        } else {
          const finalPrep = applyUploadPipelineWithProfile(data, datasetProfile);
          data = finalPrep.data;
          summary = finalPrep.summary;
        }
        decorateSummaryWithWideFormat(summary);
        const derivedFollowUps = suggestedFollowUpsFromDataSummary(summary, {
          fileLabel: job.fileName,
        });
        const shortDesc =
          job.fileName?.trim() ||
          `${summary.columnCount} columns, ${summary.rowCount.toLocaleString()} rows`;
        datasetProfile = {
          ...emptyDatasetProfile(),
          shortDescription: shortDesc,
          dateColumns: [...summary.dateColumns],
          suggestedQuestions: derivedFollowUps.slice(0, 5),
        };
        const baseCtx = emptySessionAnalysisContext();
        sessionAnalysisContext = {
          ...baseCtx,
          suggestedFollowUps: derivedFollowUps.slice(0, 12),
          dataset: {
            ...baseCtx.dataset,
            shortDescription: shortDesc,
          },
        };
      } else {
        job.enrichmentStep = 'inferring_profile';
        // Build a preliminary summary (and decorate with wide-format
        // metadata) so the LLM sees `ambiguousCurrencyColumns` and can
        // pick a 3-letter ISO code. WF8.
        const interimSummary = createDataSummary(data);
        decorateSummaryWithWideFormat(interimSummary);
        // Wave B5 · Surface user-context + domain-context so the LLM can
        // (a) disambiguate currency for symbols like "$" / "kr" / "¥",
        // (b) describe the dataset in the user's own terms, (c) suggest
        // questions that align with FMCG/Marico vocabulary. The chat
        // doc may already have `permanentContext` if the user uploads
        // to an existing session with notes; the domain context is
        // process-memoised and cheap.
        let datasetProfilePermanentContext: string | undefined;
        let datasetProfileDomainContext: string | undefined;
        try {
          const existing = await getChatBySessionIdEfficient(job.sessionId);
          datasetProfilePermanentContext = existing?.permanentContext;
        } catch {
          /* not fatal — fall through with undefined */
        }
        try {
          const { loadEnabledDomainContext } = await import(
            '../lib/domainContext/loadEnabledDomainContext.js'
          );
          const dc = await loadEnabledDomainContext();
          datasetProfileDomainContext = dc.text || undefined;
        } catch (err) {
          const msg = errorMessage(err);
          logger.warn(`B5 · domain context load for dataset profile failed: ${msg}`);
        }
        // Wave W-DPC1 · The profiling LLM call is the dominant upload-critical-path
        // cost. Re-uploads of the same workbook shape (same column names+types and
        // unchanged permanent/domain context) reuse the cached profile and skip the
        // call entirely. Only the DatasetProfile is cached — the pipeline below
        // still runs on fresh data, so temporal facets / cleaning are unchanged.
        const profileFingerprint = fingerprintFromSummary(interimSummary);
        const profileContextHash = computeContextHash(
          datasetProfilePermanentContext,
          datasetProfileDomainContext
        );
        const cachedProfile = job.username
          ? await readCachedProfile(job.username, profileFingerprint, profileContextHash)
          : null;
        if (cachedProfile) {
          logger.log(
            `⚡ dataset-profile cache HIT (${job.username} / ${profileFingerprint}) — skipping inferDatasetProfile`
          );
          datasetProfile = cachedProfile;
        } else {
          datasetProfile = await inferDatasetProfile(data, {
            fileName: job.fileName,
            dataSummary: interimSummary,
            permanentContext: datasetProfilePermanentContext,
            domainContext: datasetProfileDomainContext,
          });
          // Cache only a real LLM profile — never the empty/timeout fallback (it
          // has no shortDescription and the heuristic path already handles it).
          if (job.username && datasetProfile.shortDescription?.trim()) {
            void writeCachedProfile(
              job.username,
              profileFingerprint,
              profileContextHash,
              datasetProfile
            );
          }
        }
        const enableDirtyDateLlm =
          process.env.ENABLE_DIRTY_DATE_LLM === 'true' ||
          process.env.ENABLE_DIRTY_DATE_LLM === '1';
        if (enableDirtyDateLlm) {
          const { enrichDirtyStringDateColumns } = await import('../lib/dirtyDateEnrichment.js');
          job.enrichmentStep = 'dirty_date_enrichment';
          await enrichDirtyStringDateColumns(data, datasetProfile, columnOrderBeforeClean, {
            fileName: job.fileName,
          });
        }
        job.enrichmentStep = 'building_context';
        if (skipDateEnrichmentForSuspiciousCsv) {
          summary = createDataSummary(data);
        } else {
          const finalPrep = applyUploadPipelineWithProfile(data, datasetProfile, {
            columnOrderBeforeClean,
          });
          data = finalPrep.data;
          summary = finalPrep.summary;
        }
        decorateSummaryWithWideFormat(summary);
        // Apply LLM currency overrides — only on columns that already
        // carry a heuristic currency tag (we won't invent one).
        if (datasetProfile.currencyOverrides && datasetProfile.currencyOverrides.length > 0) {
          for (const ov of datasetProfile.currencyOverrides) {
            const col = summary.columns.find((c) => c.name === ov.columnName);
            if (col?.currency) {
              col.currency.isoCode = ov.isoCode;
              col.currency.confidence = Math.max(col.currency.confidence, 0.95);
            }
          }
        }
        // Always build heuristic context immediately so the understanding checkpoint
        // can unblock chat without waiting for the LLM seed round-trips.
        const { emptySessionAnalysisContext, seedSessionAnalysisContextLLM } = await import(
          '../lib/sessionAnalysisContext.js'
        );
        const { suggestedFollowUpsFromDataSummary } = await import(
          '../lib/suggestedFollowUpsFromSummary.js'
        );
        const derivedFollowUps = suggestedFollowUpsFromDataSummary(summary, {
          fileLabel: job.fileName,
        });
        // LLM-generated questions win; hardcoded template list only used if LLM
        // output is empty (fast-path / failure fallback).
        const mergedFollowUps = mergeSuggestedQuestions(
          datasetProfile.suggestedQuestions,
          derivedFollowUps
        );
        const baseCtx = emptySessionAnalysisContext();
        const caveats: string[] = [];
        if (datasetProfile.notes?.trim()) {
          caveats.push(datasetProfile.notes.trim().slice(0, 500));
        }
        sessionAnalysisContext = {
          ...baseCtx,
          suggestedFollowUps: mergedFollowUps.slice(0, 12),
          dataset: {
            ...baseCtx.dataset,
            shortDescription: datasetProfile.shortDescription || '',
            grainGuess: datasetProfile.grainGuess,
            columnRoles: [],
            caveats,
          },
          lastUpdated: { reason: 'seed', at: new Date().toISOString() },
        };

        const fastUploadCtx =
          process.env.FAST_UPLOAD_SESSION_CONTEXT === 'true' ||
          process.env.FAST_UPLOAD_SESSION_CONTEXT === '1';
        if (!fastUploadCtx) {
          // Fire-and-forget: upgrade stored context via LLM seed after chat is already unblocked.
          void (async () => {
            try {
              const seededCtx = await seedSessionAnalysisContextLLM({
                datasetProfile,
                dataSummary: summary,
              });
              // AD1 · auto-detect dimension rollup rows (a single value in a
              // dimension column that aggregates the rest — e.g. FEMALE SHOWER
              // GEL totalling MARICO+PURITE+OLIV+LASHE in the Marico-VN data).
              // Stamped with `source: "auto"` so the user can override via chat.
              // The H2 immutability guard preserves both user and auto entries
              // across subsequent assistant merges.
              try {
                const { detectRollupHierarchies } = await import(
                  '../lib/detectRollupHierarchies.js'
                );
                const detected = detectRollupHierarchies({
                  data,
                  summary,
                  datasetProfile,
                });
                if (detected.length > 0) {
                  seededCtx.dataset.dimensionHierarchies = detected;
                  logger.log(
                    `📐 detectRollupHierarchies: ${detected
                      .map((h) => `${h.column}="${h.rollupValue}"`)
                      .join(', ')}`
                  );
                }
              } catch (err) {
                logger.warn('⚠️ detectRollupHierarchies skipped:', err);
              }
              // SU-DT1 · auto-detect (date column, time-of-day column) pairs
              // so the agent can compose a combined datetime via SU-DT2's
              // add_computed_columns.datetimeConcat. Persisted on the
              // DataSummary so the planner-prompt block (context.ts) and
              // the SU-UX1 banner can read it.
              try {
                const { detectDateTimePairs } = await import(
                  '../lib/detectDateTimePairs.js'
                );
                const pairs = detectDateTimePairs({ data, summary });
                if (pairs.length > 0) {
                  summary.dateTimeColumnPairs = pairs;
                  logger.log(
                    `📐 detectDateTimePairs: ${pairs
                      .map((p) => `${p.timeColumn}↔${p.dateColumn}`)
                      .join(', ')}`
                  );
                }
              } catch (err) {
                logger.warn('⚠️ detectDateTimePairs skipped:', err);
              }
              // SU-IC1 · auto-detect pre-computed "indicator" columns
              // (Yes/No/Absent shaped, e.g. "Clock-In <09:30") so the
              // planner can prefer them when a question matches a column's
              // pre-computed answer shape — faster + more accurate than
              // deriving from raw values. Stamped via applyIndicatorsToSummary
              // so the per-column metadata flows through every downstream
              // surface (planner prompt, schema-binding, UI badge).
              try {
                const { detectIndicatorColumns, applyIndicatorsToSummary } =
                  await import('../lib/detectIndicatorColumns.js');
                const indicators = detectIndicatorColumns({ data, summary });
                if (indicators.length > 0) {
                  applyIndicatorsToSummary(summary, indicators);
                  logger.log(
                    `📐 detectIndicatorColumns: ${indicators
                      .map((i) => `${i.column}(${i.kind})`)
                      .join(', ')}`
                  );
                  // Valid-measurement-universe inference: a boolean metric like
                  // "PJP Adherence" is only meaningful on its planned-context
                  // rows (Market Working) — other rows are structural zeros.
                  // Stamps `indicator.applicabilityScope` so rate steps scope
                  // their denominator, degenerate breakdowns are skipped, and
                  // the headline/narrative use the valid universe.
                  try {
                    const {
                      inferMetricApplicability,
                      applyMetricApplicabilityToSummary,
                    } = await import('../lib/inferMetricApplicability.js');
                    const gates = inferMetricApplicability(summary, data);
                    if (gates.size > 0) {
                      applyMetricApplicabilityToSummary(summary, gates);
                      logger.log(
                        `📐 inferMetricApplicability: ${[...gates.entries()]
                          .map(([m, g]) => `${m}⟂${g[0]?.gateColumn}`)
                          .join(', ')}`
                      );
                    }
                  } catch (scopeErr) {
                    logger.warn('⚠️ inferMetricApplicability skipped:', scopeErr);
                  }
                  // SU-IC2 · LLM enrichment for the indicator columns
                  // SU-IC1 just flagged. Adds answersQuestions per column +
                  // adjudicates positive/negative polarity when the heuristic
                  // dictionary couldn't. Fire-and-forget — failure leaves
                  // the heuristic-only state intact.
                  try {
                    const { enrichIndicatorColumns } = await import(
                      '../lib/enrichIndicatorColumns.js'
                    );
                    const { enriched } = await enrichIndicatorColumns(summary, {
                      shortDescription: datasetProfile?.shortDescription,
                    });
                    if (enriched > 0) {
                      logger.log(
                        `📐 enrichIndicatorColumns: ${enriched} indicator(s) annotated with answersQuestions`
                      );
                    }
                  } catch (enrichErr) {
                    logger.warn(
                      '⚠️ enrichIndicatorColumns skipped:',
                      enrichErr
                    );
                  }
                }
              } catch (err) {
                logger.warn('⚠️ detectIndicatorColumns skipped:', err);
              }
              const doc = await getChatBySessionIdEfficient(job.sessionId);
              if (!doc) return;
              // If the user already saved context while we were seeding, their merged
              // sessionAnalysisContext is authoritative — do not clobber it.
              if (doc.permanentContext?.trim()) {
                return;
              }
              // The seed runs after the welcome message is already persisted with
              // heuristic-fallback bullets. If the LLM populated the manager-facing
              // bullet arrays, re-render the welcome message in place so the
              // authority shifts from heuristic to LLM (mirrors the W5 onlyInitial
              // pattern in chat.model.ts after permanentContext save).
              const seedAddedBullets =
                (seededCtx.dataset.keyHighlights?.length ?? 0) > 0 ||
                (seededCtx.dataset.whatYouCanAnalyze?.length ?? 0) > 0;
              let messages = doc.messages ?? [];
              const onlyInitial =
                messages.length === 1 && messages[0]?.role === 'assistant';
              if (seedAddedBullets && onlyInitial) {
                const { buildInitialAssistantContentFromContext } = await import(
                  '../lib/sessionAnalysisContext.js'
                );
                const newContent = buildInitialAssistantContentFromContext(
                  summary,
                  seededCtx
                );
                messages = [{ ...messages[0]!, content: newContent }];
              }
              await updateChatDocument({
                ...doc,
                sessionAnalysisContext: seededCtx,
                messages,
                lastUpdatedAt: Date.now(),
              });
            } catch {
              // best-effort — heuristic context already persisted
            }
          })();
        }
      }

      const mergedSuggestedQuestions = mergeSuggestedQuestions(
        sessionAnalysisContext.suggestedFollowUps,
        datasetProfile.suggestedQuestions
      );

      // Understanding checkpoint: make summary/context available immediately for UX,
      // while non-critical finalization work continues in this job.
      try {
        const { buildInitialAssistantContentFromContext } = await import('../lib/sessionAnalysisContext.js');
        const existingDoc = (await getChatBySessionIdEfficient(job.sessionId)) || previewDoc;
        // If the user saved context while we were enriching, their merged
        // sessionAnalysisContext is authoritative — preserve it over the local heuristic one.
        const ctxForInitial =
          existingDoc?.permanentContext?.trim() && existingDoc?.sessionAnalysisContext
            ? existingDoc.sessionAnalysisContext
            : sessionAnalysisContext;
        const initialContent = buildInitialAssistantContentFromContext(summary, ctxForInitial);
        const initialMessage = {
          role: 'assistant' as const,
          content: initialContent,
          timestamp: Date.now(),
          suggestedQuestions: ctxForInitial.suggestedFollowUps.slice(0, 5),
        };
        const existingMessages = existingDoc?.messages ?? [];
        const messages = existingMessages.length === 0 ? [initialMessage] : existingMessages;

        // Wave W57 · build the initial SemanticModel from the dataset
        // summary + LLM profile. Pure function, fast (no I/O); persisted
        // alongside `datasetProfile` so the compiler (W58) and admin UI
        // (W61) can pick it up on the next read. Best-effort: failure
        // here doesn't block the understanding checkpoint.
        let semanticModel: SemanticModel | undefined;
        try {
          const { inferModel } = await import("../lib/semantic/inferModel.js");
          semanticModel = inferModel({
            summary,
            datasetProfile,
            modelName: `Model for ${job.fileName || "dataset"}`,
          });
        } catch (semanticErr) {
          logger.warn(
            "W57 · semanticModel inference failed (non-fatal):",
            semanticErr,
          );
        }

        await updateChatDocument({
          ...existingDoc,
          dataSummary: summary,
          datasetProfile,
          ...(semanticModel ? { semanticModel } : {}),
          sessionAnalysisContext: ctxForInitial,
          messages,
          enrichmentStatus: "complete" as const,
          lastUpdatedAt: Date.now(),
        });
        job.understandingReady = true;
        job.understandingReadyAt = Date.now();
        job.suggestedQuestions = mergedSuggestedQuestions;

        // W59 · record `enrichment_complete` in the durable Memory journal.
        // W68 · skip when username is missing so schema validation passes.
        const enrichUsername = existingDoc?.username?.trim();
        if (enrichUsername) {
          void (async () => {
            try {
              const { buildEnrichmentCompleteEntry, scheduleLifecycleMemory } =
                await import(
                  "../lib/agents/runtime/memoryLifecycleBuilders.js"
                );
              scheduleLifecycleMemory(
                buildEnrichmentCompleteEntry({
                  sessionId: job.sessionId,
                  username: enrichUsername,
                  rowCount: summary.rowCount ?? 0,
                  columnCount: summary.columnCount ?? 0,
                  suggestedQuestions: mergedSuggestedQuestions,
                  createdAt: Date.now(),
                })
              );
            } catch (e) {
              logger.warn(
                "⚠️ analysisMemory enrichment_complete hook failed:",
                e
              );
            }
          })();
        }
      } catch (understandingPersistError) {
        logger.warn("⚠️ Failed to persist understanding-ready checkpoint:", understandingPersistError);
      }

      // No upload-time chart/insight generation; first assistant turn uses session context + chat only.
      job.status = 'analyzing';
      job.progress = 40;
      job.enrichmentStep = 'persisting';
      const charts: ChartSpec[] = [];
      const insights: Insight[] = [];

      // Step 4: Suggestions — rolling session context (LLM seed); no hardcoded lists
      job.progress = 60;
      const suggestions: string[] = mergedSuggestedQuestions.length > 0 ? [...mergedSuggestedQuestions] : [];

      // Step 5: Sanitize charts (with memory optimization for large datasets)
      job.progress = 70;
      const MAX_CHART_DATA_POINTS = 50000; // Limit chart data to prevent memory issues
      
      const sanitizedCharts = charts.map((chart) => {
        const convertValueForSchema = (value: any): string | number | null => {
          if (value === null || value === undefined) return null;
          if (value instanceof Date) return value.toISOString();
          if (typeof value === 'number') return isNaN(value) || !isFinite(value) ? null : value;
          if (typeof value === 'string') return value;
          return String(value);
        };
        
        let chartData = chart.data || [];
        
        // Limit data size for memory efficiency
        if (chartData.length > MAX_CHART_DATA_POINTS) {
          logger.log(`⚠️ Chart "${chart.title}" has ${chartData.length} data points, limiting to ${MAX_CHART_DATA_POINTS} for memory efficiency`);
          chartData = capChartDataPoints(chartData, chart.type, MAX_CHART_DATA_POINTS);
        }
        
        // Process in batches to avoid memory spikes
        const BATCH_SIZE = 10000;
        const sanitizedData: Record<string, any>[] = [];
        
        for (let i = 0; i < chartData.length; i += BATCH_SIZE) {
          const batch = chartData.slice(i, i + BATCH_SIZE);
          const sanitizedBatch = batch.map(row => {
            const sanitizedRow: Record<string, any> = {};
            for (const [key, value] of Object.entries(row)) {
              sanitizedRow[key] = convertValueForSchema(value);
            }
            return sanitizedRow;
          }).filter(row => {
            return !Object.values(row).some(value => typeof value === 'number' && isNaN(value));
          });
          
          sanitizedData.push(...sanitizedBatch);
        }
        
        return {
          ...chart,
          data: sanitizedData
        };
      });

      // RAG initialization removed

      // Step 7: Generate column statistics
      job.progress = 80;
      const columnStatistics = generateColumnStatistics(data, summary.numericColumns);
      
      // Step 7.5: Compute detailed data summary statistics (for Data Summary modal)
      // NOTE: This step can be expensive for large files because it calls into the
      // Python service and scans up to 50k rows. To keep initial upload time low,
      // it's guarded by a feature flag and disabled by default. The Data Summary
      // modal can still compute these statistics on-demand when opened.
      let dataSummaryStatistics: any = undefined;
      if (this.ENABLE_UPLOAD_DATA_SUMMARY_STATS) {
        try {
          const { getDataSummary } = await import('../lib/dataOps/pythonService.js');
          
          // Sample data if too large (same logic as in endpoint)
          let dataForSummary = data;
          const MAX_ROWS_FOR_SUMMARY = 50000;
          if (data.length > MAX_ROWS_FOR_SUMMARY) {
            logger.log(`📊 Computing data summary: sampling ${MAX_ROWS_FOR_SUMMARY} rows from ${data.length} total rows`);
            const step = Math.floor(data.length / MAX_ROWS_FOR_SUMMARY);
            const sampledData: Record<string, any>[] = [];
            for (let i = 0; i < data.length && sampledData.length < MAX_ROWS_FOR_SUMMARY; i += step) {
              sampledData.push(data[i]!);
            }
            dataForSummary = sampledData;
          }
          
          logger.log(`📊 Computing detailed data summary statistics...`);
          const summaryResponse = await getDataSummary(dataForSummary);
          
          // Calculate quality score
          const fullDataRowCount = summary.rowCount;
          const totalCells = summaryResponse.summary.reduce((sum, col) => sum + fullDataRowCount, 0);
          const totalNulls = summaryResponse.summary.reduce((sum, col) => {
            const nullPercentage = col.total_values > 0 ? col.null_values / col.total_values : 0;
            return sum + Math.round(nullPercentage * fullDataRowCount);
          }, 0);
          const nullPercentage = totalCells > 0 ? (totalNulls / totalCells) * 100 : 0;
          const qualityScore = Math.max(0, Math.round(100 - nullPercentage));
          
          // Scale summary statistics to full dataset size
          const scaledSummary = summaryResponse.summary.map(col => {
            const nullPercentage = col.total_values > 0 ? col.null_values / col.total_values : 0;
            const scaledNulls = Math.round(nullPercentage * fullDataRowCount);
            return {
              ...col,
              total_values: fullDataRowCount,
              null_values: scaledNulls,
              non_null_values: fullDataRowCount - scaledNulls,
            };
          });
          
          dataSummaryStatistics = {
            summary: scaledSummary,
            qualityScore,
            computedAt: Date.now(),
          };
          
          logger.log(`✅ Data summary statistics computed successfully (quality score: ${qualityScore})`);
        } catch (summaryError) {
          logger.error('⚠️ Failed to compute data summary statistics during upload:', summaryError);
          // Don't fail the upload - this is optional
        }
      }
      
      // Step 8: Prepare sample rows
      // For large files, sampleRows are already provided from columnar storage
      // For small files, slice from in-memory data
      let sampleRows: Record<string, any>[];
      if (useLargeFileProcessing) {
        // Get fresh sample from columnar storage
        sampleRows = await getDataForAnalysis(job.sessionId, undefined, 50);
      } else {
        sampleRows = data.slice(0, 50).map(row => {
          const serializedRow: Record<string, any> = {};
          for (const [key, value] of Object.entries(row)) {
            if (value instanceof Date) {
              serializedRow[key] = value.toISOString();
            } else {
              serializedRow[key] = value;
            }
          }
          return serializedRow;
        });
      }
      canonicalizeDateColumnValues(sampleRows, summary.dateColumns);
      if (summary.dateColumns.length > 0) {
        const { applyTemporalFacetColumns } = await import('../lib/temporalFacetColumns.js');
        applyTemporalFacetColumns(sampleRows, summary.dateColumns, facetOptsForUpload());
      }
      warnSuspiciousDuplicateRowIdInSample(sampleRows, `upload_final:${job.sessionId}`);

      // Step 9: Materialize authoritative DuckDB table for all upload paths.
      // Apply temporal facet columns to the FULL data so the authoritative DuckDB
      // `data` table physically carries Month · X, Year · X, Quarter · X, etc.
      //
      // This MUST run for large files too. `processLargeFile` only applies facets
      // to `sampleRows` (to build the summary); the full `data` it returns is the
      // raw read_csv_auto shape. Previously an `&& !useLargeFileProcessing` guard
      // skipped this step for large files, so their materialized `data` table was
      // missing every facet column that `dataSummary` (and the UI column panel)
      // advertise — and any pivot/chart GROUP BY on a facet returned empty/zero
      // measures while dimension labels still rendered. `data` is already fully
      // in memory here for every path (large files loaded ALL rows via
      // getDataForAnalysis above), so applying facets in-memory adds no new
      // materialization cost. (Deriving facets in DuckDB SQL is the Phase-2
      // streaming follow-up.)
      if (summary.dateColumns.length > 0) {
        const { applyTemporalFacetColumns: applyFacets } = await import('../lib/temporalFacetColumns.js');
        applyFacets(data, summary.dateColumns, facetOptsForUpload());
      }
      job.status = 'saving';
      job.progress = 88;
      let columnarReadyMarker: string | undefined;
      try {
        const storage = new ColumnarStorageService({ sessionId: job.sessionId });
        await storage.initialize();
        try {
          await storage.materializeAuthoritativeDataTable(data, { tableName: 'data' });
          columnarReadyMarker = storagePath || `materialized:${job.sessionId}`;

          // Durability · persist a durable, enrichment-exact copy of the
          // authoritative `data` rows (post-melt, temporal-faceted, numeric-
          // coerced — same array just materialized to DuckDB) as the session's
          // currentDataBlob, so a cold /tmp (session revisit / server restart /
          // serverless cold start) rematerializes from these EXACT rows via
          // loadLatestData Priority 1 (currentDataBlob, JSON branch) instead of
          // the fragile original-blob re-parse that loses enrichment.
          //
          // ONLY when there is no OTHER durable full-fidelity rematerialize
          // source. loadLatestData(authoritativeRematerialize) prefers, in
          // order: chunked storage (Priority 0, used in ALL modes) → currentDataBlob
          // (Priority 1) → rawData (Priority 2). So for CHUNKED uploads the chunks
          // already reload the full dataset, and for small uploads rawData is
          // persisted inline — in both cases this copy is redundant. Writing it
          // unconditionally adds a large JSON blob upload (~50 MB for a 10k-row
          // wide dataset) to the critical upload path, stalling startup for no
          // benefit. Gate on `!chunkIndexBlob`: non-chunked uploads are <10 MB
          // (the chunking threshold), so the copy is cheap there, and that is
          // exactly the band (>10k rows, no chunks, rawData not stored) whose
          // rematerialize would otherwise hit the fragile re-parse.
          // NON-FATAL: a write failure must never fail the upload.
          if (!chunkIndexBlob) {
            try {
              const { updateProcessedDataBlob } = await import('../lib/blobStorage.js');
              const enriched = await updateProcessedDataBlob(job.sessionId, data, 1, job.username);
              enrichedDataBlobInfo = {
                blobUrl: enriched.blobUrl,
                blobName: enriched.blobName,
                version: 1,
                lastUpdated: Date.now(),
              };
              logger.log(
                `💾 Wrote durable enriched currentDataBlob (${data.length} rows) for ${job.sessionId}: ${enriched.blobName}`,
              );
            } catch (enrichedErr) {
              logger.warn(
                `⚠️ Enriched currentDataBlob write skipped (non-fatal): ${errorMessage(enrichedErr)}`,
              );
            }
          } else {
            logger.log(
              `↩️ Skipping durable currentDataBlob write for ${job.sessionId}: chunked upload already has a full-fidelity rematerialize source (chunkIndexBlob).`,
            );
          }
          // Phase 2 (W2.0) · flag-gated · write the authoritative `data` table to a
          // durable Parquet in blob so the Phase 1 read path can open it next
          // request instead of rehydrating all rows. Non-fatal: a failure here must
          // never fail the upload (rematerialize remains the fallback). Default OFF.
          if (isParquetReadPathEnabled()) {
            try {
              const blobName = await writeAndUploadSessionParquet(storage, {
                username: job.username,
                sessionId: job.sessionId,
                version: 0,
              });
              parquetBlobInfo = { blobName, version: 0, rowCount: summary.rowCount };
            } catch (pqErr) {
              logger.warn(
                `⚠️ Parquet write skipped (non-fatal): ${errorMessage(pqErr)}`,
              );
            }
          }
        } finally {
          await storage.close();
        }
      } catch (materializeError) {
        const errorMsg =
          errorMessage(materializeError);
        throw new Error(`Failed to materialize session DuckDB data table: ${errorMsg}`);
      }

      // Step 10: Save to database
      job.status = 'saving';
      job.progress = 90;
      job.enrichmentStep = 'persisting';
      queryCache.invalidateSession(job.sessionId);
      
      const processingTime = Date.now() - (job.startedAt || Date.now());
      
      let chatDocument;
      try {
        // Check if a placeholder session already exists (created during upload)
        const existingSession = await getChatBySessionIdEfficient(job.sessionId);
        
        if (existingSession) {
          // Update existing placeholder session with full data
          logger.log(`🔄 Updating existing placeholder session: ${job.sessionId}`);
          
          // Handle chart storage (same logic as createChatDocument)
          let chartsToStore = sanitizedCharts;
          let chartReferences = existingSession.chartReferences || [];
          
          if (sanitizedCharts && sanitizedCharts.length > 0) {
            const shouldStoreChartsInBlob = sanitizedCharts.some(chart => {
              const chartSize = JSON.stringify(chart).length;
              const hasLargeData = chart.data && Array.isArray(chart.data) && chart.data.length > 1000;
              return chartSize > 100000 || hasLargeData;
            });
            
            if (shouldStoreChartsInBlob) {
              logger.log(`📊 Charts have large data arrays. Storing in blob storage...`);
              try {
                chartReferences = await saveChartsToBlob(job.sessionId, sanitizedCharts, job.username);
                chartsToStore = sanitizedCharts.map(chart => ({
                  ...chart,
                  data: undefined, // Remove data array - stored in blob
                })) as any;
                logger.log(`✅ Saved ${chartReferences.length} charts to blob storage`);
              } catch (blobError) {
                logger.error('⚠️ Failed to save charts to blob, storing in CosmosDB:', blobError);
                chartsToStore = sanitizedCharts; // Fallback
              }
            }
          }
          
          // Estimate rawData size and decide if we should store it
          // For large files processed with columnar storage, never store raw data
          const estimatedSize = useLargeFileProcessing ? Infinity : JSON.stringify(data).length;
          const MAX_DOCUMENT_SIZE = 3 * 1024 * 1024; // 3MB safety margin
          const shouldStoreRawData = !useLargeFileProcessing && estimatedSize < MAX_DOCUMENT_SIZE && data.length < 10000;
          
          if (useLargeFileProcessing) {
            logger.log(`📊 Large file: Data stored in columnar format at ${storagePath}. Only sampleRows stored in CosmosDB.`);
          } else if (!shouldStoreRawData) {
            logger.log(`ℹ️ Large dataset (${data.length} rows, ~${(estimatedSize / 1024 / 1024).toFixed(2)}MB): full data materialized to DuckDB columnar storage; CosmosDB holds sampleRows only (CosmosDB 4 MB limit).`);
          }
          
          chatDocument = {
            ...existingSession,
            dataSummary: summary,
            charts: chartsToStore,
            chartReferences: chartReferences.length > 0 ? chartReferences : undefined,
            rawData: shouldStoreRawData ? data : [],
            sampleRows,
            datasetProfile,
            selectedSheetName: job.sheetName ?? existingSession.selectedSheetName,
            columnarStoragePath: columnarReadyMarker,
            // Durable enriched copy (upload baseline v1) so cold-/tmp reload is
            // exact. Conditional spread: never clobber an existing currentDataBlob
            // with undefined if the enriched-blob write failed (non-fatal).
            ...(enrichedDataBlobInfo ? { currentDataBlob: enrichedDataBlobInfo } : {}),
            chunkIndexBlob: chunkIndexBlob,
            columnStatistics,
            dataSummaryStatistics,
            insights,
            sessionAnalysisContext,
            enrichmentStatus: 'complete' as const,
            analysisMetadata: {
              totalProcessingTime: processingTime,
              aiModelUsed: 'gpt-4o',
              fileSize: job.fileBuffer?.length ?? 0,
              analysisVersion: '1.0.0'
            },
            blobInfo: job.blobInfo || existingSession.blobInfo,
            lastUpdatedAt: Date.now(),
          };
          chatDocument = await updateChatDocument(chatDocument);
          logger.log(`✅ Updated session with processed data: ${chatDocument.id}`);
        } else {
          logger.log(`📝 No placeholder found, creating new session: ${job.sessionId}`);
          chatDocument = await createChatDocument(
            job.username,
            job.fileName,
            job.sessionId,
            summary,
            sanitizedCharts,
            data,
            sampleRows,
            columnStatistics,
            job.blobInfo,
            {
              totalProcessingTime: processingTime,
              aiModelUsed: 'gpt-4o',
              fileSize: job.fileBuffer?.length ?? 0,
              analysisVersion: '1.0.0'
            },
            insights,
            dataSummaryStatistics,
            datasetProfile,
            sessionAnalysisContext
          );
          chatDocument = await updateChatDocument({
            ...chatDocument,
            enrichmentStatus: 'complete' as const,
            selectedSheetName: job.sheetName,
            columnarStoragePath: columnarReadyMarker,
            // Durable enriched copy (upload baseline v1) so cold-/tmp reload is exact.
            ...(enrichedDataBlobInfo ? { currentDataBlob: enrichedDataBlobInfo } : {}),
            lastUpdatedAt: Date.now(),
          });
        }
      } catch (cosmosError) {
        const errorMsg = errorMessage(cosmosError);
        logger.error("Failed to save chat document:", cosmosError);
        
        // Provide more helpful error messages for common issues
        if (errorMsg.includes('RequestEntityTooLarge') || errorMsg.includes('413') || errorMsg.includes('too large')) {
          throw new Error('File or analysis results are too large to save. Please try with a smaller file or fewer columns.');
        } else if (errorMsg.includes('timeout') || errorMsg.includes('TIMEOUT') || errorMsg.includes('ETIMEDOUT')) {
          throw new Error('Database connection timeout. The file may be too large. Please try with a smaller file.');
        } else if (errorMsg.includes('ECONNREFUSED') || errorMsg.includes('connection')) {
          throw new Error('Database connection failed. Please check your connection and try again.');
        }
        // If it's not a critical error, continue - the document might still be partially saved
      }

      if (chatDocument?.sessionId) {
        const { postEnrichmentFlush } = await import('../services/chat/chat.service.js');
        try {
          await postEnrichmentFlush(job.sessionId, job.username);
        } catch (flushErr) {
          logger.error('⚠️ postEnrichmentFlush failed:', flushErr);
        }
      }

      // Phase 2 (W2.0) · flag-gated · persist the Parquet pointer onto the chat
      // doc so the read path (ensureAuthoritativeDataTable) can open it. Only set
      // when the Parquet was written above; otherwise a no-op (flag-off path is
      // byte-identical). Non-fatal — a failed pointer write must not fail upload.
      if (parquetBlobInfo && chatDocument) {
        try {
          chatDocument = await updateChatDocument({ ...chatDocument, parquetBlob: parquetBlobInfo });
        } catch (pqDocErr) {
          logger.warn(
            `⚠️ Failed to persist parquetBlob pointer (non-fatal): ${errorMessage(pqDocErr)}`,
          );
        }
      }

      if (chatDocument?.sessionId) {
        const { scheduleIndexSessionRag } = await import("../lib/rag/indexSession.js");
        scheduleIndexSessionRag(job.sessionId);
      }

      // Wave QL6 · Eagerly materialize the DuckDB `data` table at upload
      // completion so the very first chat turn finds it ready. Without this,
      // materialization happens lazily on the first analytical query — which
      // adds 0.5–2s of latency and, more importantly, sets up the silent
      // fallback to in-memory execution when materialization races with the
      // first turn. Eager materialization is the architectural counterpart
      // to the user's "DuckDB always, never Cosmos for aggregations"
      // contract: by the time a user can type a question, the analytical
      // table is ready.
      //
      // Fire-and-forget. Failures are logged but never block the response
      // (the lazy path remains as a safety net for the analytical tools).
      // Tests can hook the `__onEagerMaterializeAttempt` callback below.
      if (chatDocument?.sessionId) {
        const sessionIdForMaterialize = chatDocument.sessionId;
        const chatDocForMaterialize = chatDocument;
        void (async () => {
          try {
            const { ColumnarStorageService } = await import("../lib/columnarStorage.js");
            const { ensureAuthoritativeDataTable } = await import(
              "../lib/ensureSessionDuckdbMaterialized.js"
            );
            const storage = new ColumnarStorageService({
              sessionId: sessionIdForMaterialize,
            });
            await storage.initialize();
            await ensureAuthoritativeDataTable(storage, chatDocForMaterialize);
            logger.log(
              `🟢 eager DuckDB materialization complete for session ${sessionIdForMaterialize}`
            );
          } catch (materializeErr) {
            const msg =
              errorMessage(materializeErr);
            logger.warn(
              `⚠️ eager DuckDB materialization failed for ${sessionIdForMaterialize}: ${msg.slice(0, 300)}`
            );
          }
        })();
      }

      // Step 10: Complete
      job.status = 'completed';
      job.progress = 100;
      job.completedAt = Date.now();
      job.result = {
        sessionId: job.sessionId,
        summary,
        charts: sanitizedCharts,
        insights,
        sampleRows,
        suggestions: suggestions.length > 0 ? suggestions : undefined,
        sessionAnalysisContext,
        chatId: chatDocument?.id,
        blobInfo: job.blobInfo,
        warnings: job.warnings?.length ? job.warnings : undefined,
      };

      // Phase 0 · emit one structured telemetry line for scale baselining.
      // Wrapped so instrumentation can never fail an otherwise-successful upload.
      try {
        const telemetryPath: UploadPath = job.snowflakeImport
          ? 'snowflake'
          : useChunking
            ? 'chunking'
            : useLargeFileProcessing
              ? 'large-file'
              : 'in-memory';
        logUploadTelemetry({
          sessionId: job.sessionId,
          jobId: job.jobId,
          source: job.snowflakeImport ? 'snowflake' : 'file',
          path: telemetryPath,
          rowCount: summary.rowCount,
          columnCount: summary.columnCount,
          fileBytes: job.fileBuffer?.length,
          durationMs: Date.now() - (job.startedAt || job.createdAt),
          rssMb: currentRssMb(),
          warnings: job.warnings?.length ?? 0,
        });
      } catch {
        /* never break an upload on telemetry */
      }

      // Clean up file buffer from memory after processing (file uploads only)
      if (job.fileBuffer) {
        delete (job as any).fileBuffer;
      }
      
      // Clear timeout on successful completion
      clearTimeout(timeoutId);

    } catch (error) {
      job.status = 'failed';
      job.error = error instanceof Error ? error.message : 'Unknown error occurred';
      job.completedAt = Date.now();
      logger.error(`Upload job ${job.jobId} failed:`, error);
      try {
        const { getChatBySessionIdEfficient, updateChatDocument } = await import('../models/chat.model.js');
        const doc = await getChatBySessionIdEfficient(job.sessionId);
        if (doc) {
          await updateChatDocument({
            ...doc,
            enrichmentStatus: 'failed' as const,
            lastUpdatedAt: Date.now(),
          });
        }
      } catch {
        /* ignore */
      }
      
      // Clear timeout on error
      clearTimeout(timeoutId);
      
      // If it's a memory or timeout error, provide more helpful message
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('timeout') || errorMessage.includes('TIMEOUT')) {
        job.error = 'Processing timeout: The file is too large or processing took too long. Please try with a smaller file or split your data into multiple files.';
      } else if (errorMessage.includes('memory') || errorMessage.includes('Memory') || errorMessage.includes('heap')) {
        job.error = 'Memory error: The file is too large to process. Please try with a smaller file or reduce the number of rows/columns.';
      }
    }
  }

  /**
   * Clean up old completed/failed jobs (older than 1 hour)
   */
  cleanup(): void {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    for (const [jobId, job] of this.jobs.entries()) {
      if (
        (job.status === 'completed' || job.status === 'failed') &&
        job.completedAt &&
        job.completedAt < oneHourAgo
      ) {
        this.jobs.delete(jobId);
      }
    }
  }

  /**
   * Get queue statistics
   */
  getStats() {
    const jobs = Array.from(this.jobs.values());
    return {
      total: jobs.length,
      pending: jobs.filter(j => j.status === 'pending').length,
      processing: jobs.filter(j =>
        ['uploading', 'parsing', 'preview_ready', 'analyzing', 'saving'].includes(j.status)
      ).length,
      completed: jobs.filter(j => j.status === 'completed').length,
      failed: jobs.filter(j => j.status === 'failed').length,
      active: this.processing.size,
    };
  }
}

// Singleton instance
export const uploadQueue = new UploadQueue();

// Cleanup old jobs every 30 minutes
setInterval(() => {
  uploadQueue.cleanup();
}, 30 * 60 * 1000);

