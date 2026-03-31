/**
 * Upload Processing Queue
 * Handles async processing of large file uploads to prevent blocking
 */

import type { ChartSpec, Insight, SessionAnalysisContext } from '../shared/schema.js';
import { mergeSuggestedQuestions } from '../lib/suggestedQuestions.js';
import { ColumnarStorageService } from '../lib/columnarStorage.js';

export interface SnowflakeImportConfig {
  tableName: string;
  database?: string;
  schema?: string;
  account?: string;
  username?: string;
  password?: string;
  warehouse?: string;
  role?: string;
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

    const jobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
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
    const jobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
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
    const JOB_TIMEOUT = 30 * 60 * 1000; // 30 minutes timeout for large files
    const timeoutId = setTimeout(() => {
      if (job.status !== 'completed' && job.status !== 'failed') {
        job.status = 'failed';
        job.error = 'Processing timeout: File processing took too long. Please try with a smaller file or contact support.';
        job.completedAt = Date.now();
        console.error(`⏱️ Upload job ${job.jobId} timed out after ${JOB_TIMEOUT / 1000 / 60} minutes`);
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
      const { processLargeFile, shouldUseLargeFileProcessing, getDataForAnalysis } = await import('../lib/largeFileProcessor.js');
      const {
        createChatDocument,
        generateColumnStatistics,
        getChatBySessionIdEfficient,
        updateChatDocument,
        ensureChatDocumentForUploadJob,
        createPlaceholderSession,
      } = await import('../models/chat.model.js');
      const { saveChartsToBlob, uploadFileToBlob } = await import('../lib/blobStorage.js');
      const queryCache = (await import('../lib/cache.js')).default;

      let data: Record<string, any>[];
      let summary: ReturnType<typeof createDataSummary>;
      let datasetProfile: ReturnType<typeof emptyDatasetProfile>;
      let storagePath: string | undefined;
      let chunkIndexBlob: { blobName: string; totalChunks: number; totalRows: number } | undefined;
      let useLargeFileProcessing = false;
      let useChunking = false;
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
          console.warn("⚠️ Queue blob upload failed; continuing without blobInfo:", blobError);
        }
      } else if (job.blobInfo) {
        job.blobPersisted = true;
      }

      // Best-effort early placeholder creation for smoother session UX.
      try {
        await createPlaceholderSession(
          job.username,
          job.fileName,
          job.sessionId,
          job.fileBuffer?.length ?? 0,
          job.blobInfo
        );
      } catch (placeholderError: any) {
        console.warn("⚠️ Queue placeholder creation skipped (will self-heal later):", {
          sessionId: job.sessionId,
          error: placeholderError?.message || String(placeholderError),
        });
      }

      // Snowflake import: fetch raw rows (enrichment applies profile after preview checkpoint)
      if (job.snowflakeImport) {
        job.status = 'parsing';
        job.progress = 10;
        const { fetchTableData } = await import('../lib/snowflakeService.js');
        data = await fetchTableData(job.snowflakeImport);
        if (!data || data.length === 0) {
          throw new Error('No data found in Snowflake table');
        }
        job.progress = 40;
      } else if (job.fileBuffer) {
        // File upload path
        useLargeFileProcessing = shouldUseLargeFileProcessing(job.fileBuffer.length);
        useChunking = job.fileBuffer.length >= 10 * 1024 * 1024; // 10MB threshold for chunking

      // Try chunking first for files >= 10MB (faster upload and query)
      if (useChunking) {
        try {
          const { chunkFile } = await import('../lib/chunkingService.js');
          console.log(`📦 File is ${(job.fileBuffer.length / 1024 / 1024).toFixed(2)}MB. Using chunking for faster processing...`);
          
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
                console.log(`  ${progress.message}`);
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
          const MAX_ROWS_FOR_AI = 100000; // Load max 100K rows for AI analysis
          const shouldSampleChunks = chunkIndex.totalRows > MAX_ROWS_FOR_AI;
          
          if (shouldSampleChunks) {
            // Load chunks proportionally to get ~100K rows
            const targetChunks = Math.ceil((MAX_ROWS_FOR_AI / chunkIndex.totalRows) * chunkIndex.totalChunks);
            const chunksToLoad = Math.min(targetChunks, chunkIndex.totalChunks);
            const step = Math.floor(chunkIndex.totalChunks / chunksToLoad);
            const sampledChunks = chunkIndex.chunks.filter((_, idx) => idx % step === 0).slice(0, chunksToLoad);
            console.log(`📦 Loading ${sampledChunks.length} of ${chunkIndex.totalChunks} chunks (sampled from ${chunkIndex.totalRows} rows) for faster AI analysis...`);
            data = await loadChunkData(sampledChunks);
            console.log(`✅ Loaded ${data.length} rows (sampled) from ${chunkIndex.totalChunks} chunks (${chunkIndex.totalRows} rows total) for AI analysis`);
          } else {
            console.log(`📦 Loading ALL ${chunkIndex.totalChunks} chunks for full data analysis (${chunkIndex.totalRows} rows total)...`);
            data = await loadChunkData(chunkIndex.chunks); // Load ALL chunks for smaller files
            console.log(`✅ File chunked into ${chunkIndex.totalChunks} chunks (${chunkIndex.totalRows} rows total), loaded ${data.length} rows for AI analysis`);
          }
          job.progress = 40;
        } catch (chunkError) {
          console.warn('⚠️ Chunking failed, falling back to standard processing:', chunkError);
          // Fall through to standard processing
          useChunking = false;
        }
      }

      if (!useChunking && useLargeFileProcessing) {
        // Use streaming and columnar storage for large files
        console.log(`📦 Large file detected (${(job.fileBuffer.length / 1024 / 1024).toFixed(2)}MB). Using streaming pipeline...`);
        
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
                console.log(`  ${progress.message}`);
              }
            }
          );
          
          storagePath = result.storagePath;

          console.log(`📊 Loading ALL ${result.rowCount} rows for enrichment...`);
          data = await getDataForAnalysis(job.sessionId, undefined, undefined);
          console.log(`✅ Large file processed: ${result.rowCount} rows, using ALL ${data.length} rows in memory`);
        } catch (largeFileError) {
          const errorMsg = largeFileError instanceof Error ? largeFileError.message : String(largeFileError);
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
              console.warn(
                `⚠️ Skipping date enrichment due to suspicious CSV parse quality (${(parseDiagnostics.mismatchRatio * 100).toFixed(2)}% mismatched rows).`
              );
            }
          }
        } catch (parseError) {
          const errorMsg = parseError instanceof Error ? parseError.message : String(parseError);
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

      const columnOrderBeforeClean = Object.keys(data[0] || {});

      const skipUploadLlm =
        process.env.DISABLE_UPLOAD_INITIAL_ANALYSIS === 'true' ||
        process.env.DISABLE_UPLOAD_INITIAL_ANALYSIS === '1';

      // Preview checkpoint: heuristic summary + 50 sample rows (no LLM).
      // Date columns for enrichment are chosen by the upload LLM; do not canonicalize preview on heuristics.
      const previewSummary = createDataSummary(data);
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
        applyTemporalFacetColumns(previewSample, previewDateCols);
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
        enrichmentStatus: 'in_progress',
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
          suggestedQuestions: derivedFollowUps.slice(0, 8),
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
        datasetProfile = await inferDatasetProfile(data, {
          fileName: job.fileName,
        });
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
        const fastUploadCtx =
          process.env.FAST_UPLOAD_SESSION_CONTEXT === 'true' ||
          process.env.FAST_UPLOAD_SESSION_CONTEXT === '1';
        if (fastUploadCtx) {
          const { emptySessionAnalysisContext } = await import('../lib/sessionAnalysisContext.js');
          const { suggestedFollowUpsFromDataSummary } = await import(
            '../lib/suggestedFollowUpsFromSummary.js'
          );
          const derivedFollowUps = suggestedFollowUpsFromDataSummary(summary, {
            fileLabel: job.fileName,
          });
          const mergedFollowUps = mergeSuggestedQuestions(
            derivedFollowUps,
            datasetProfile.suggestedQuestions
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
        } else {
          const { seedSessionAnalysisContextLLM } = await import('../lib/sessionAnalysisContext.js');
          sessionAnalysisContext = await seedSessionAnalysisContextLLM({
            datasetProfile,
            dataSummary: summary,
          });
        }
      }

      const mergedSuggestedQuestions = mergeSuggestedQuestions(
        sessionAnalysisContext.suggestedFollowUps,
        datasetProfile.suggestedQuestions
      );

      // Understanding checkpoint: make summary/context available immediately for UX,
      // while non-critical finalization work continues in this job.
      try {
        const existingDoc = (await getChatBySessionIdEfficient(job.sessionId)) || previewDoc;
        await updateChatDocument({
          ...existingDoc,
          dataSummary: summary,
          datasetProfile,
          sessionAnalysisContext,
          enrichmentStatus: "complete",
          lastUpdatedAt: Date.now(),
        });
        job.understandingReady = true;
        job.understandingReadyAt = Date.now();
        job.suggestedQuestions = mergedSuggestedQuestions;
      } catch (understandingPersistError) {
        console.warn("⚠️ Failed to persist understanding-ready checkpoint:", understandingPersistError);
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
          console.log(`⚠️ Chart "${chart.title}" has ${chartData.length} data points, limiting to ${MAX_CHART_DATA_POINTS} for memory efficiency`);
          // For line/area charts, sample evenly; for others, take first N
          if (chart.type === 'line' || chart.type === 'area') {
            const step = Math.ceil(chartData.length / MAX_CHART_DATA_POINTS);
            chartData = chartData.filter((_: any, idx: number) => idx % step === 0).slice(0, MAX_CHART_DATA_POINTS);
          } else {
            chartData = chartData.slice(0, MAX_CHART_DATA_POINTS);
          }
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
            console.log(`📊 Computing data summary: sampling ${MAX_ROWS_FOR_SUMMARY} rows from ${data.length} total rows`);
            const step = Math.floor(data.length / MAX_ROWS_FOR_SUMMARY);
            const sampledData: Record<string, any>[] = [];
            for (let i = 0; i < data.length && sampledData.length < MAX_ROWS_FOR_SUMMARY; i += step) {
              sampledData.push(data[i]);
            }
            dataForSummary = sampledData;
          }
          
          console.log(`📊 Computing detailed data summary statistics...`);
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
          
          console.log(`✅ Data summary statistics computed successfully (quality score: ${qualityScore})`);
        } catch (summaryError) {
          console.error('⚠️ Failed to compute data summary statistics during upload:', summaryError);
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
        applyTemporalFacetColumns(sampleRows, summary.dateColumns);
      }
      warnSuspiciousDuplicateRowIdInSample(sampleRows, `upload_final:${job.sessionId}`);

      // Step 9: Materialize authoritative DuckDB table for all upload paths.
      job.status = 'saving';
      job.progress = 88;
      let columnarReadyMarker: string | undefined;
      try {
        const storage = new ColumnarStorageService({ sessionId: job.sessionId });
        await storage.initialize();
        try {
          await storage.materializeAuthoritativeDataTable(data, { tableName: 'data' });
          columnarReadyMarker = storagePath || `materialized:${job.sessionId}`;
        } finally {
          await storage.close();
        }
      } catch (materializeError) {
        const errorMsg =
          materializeError instanceof Error ? materializeError.message : String(materializeError);
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
          console.log(`🔄 Updating existing placeholder session: ${job.sessionId}`);
          
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
              console.log(`📊 Charts have large data arrays. Storing in blob storage...`);
              try {
                chartReferences = await saveChartsToBlob(job.sessionId, sanitizedCharts, job.username);
                chartsToStore = sanitizedCharts.map(chart => ({
                  ...chart,
                  data: undefined, // Remove data array - stored in blob
                })) as any;
                console.log(`✅ Saved ${chartReferences.length} charts to blob storage`);
              } catch (blobError) {
                console.error('⚠️ Failed to save charts to blob, storing in CosmosDB:', blobError);
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
            console.log(`📊 Large file: Data stored in columnar format at ${storagePath}. Only sampleRows stored in CosmosDB.`);
          } else if (!shouldStoreRawData) {
            console.log(`⚠️ Large dataset detected (${data.length} rows, ~${(estimatedSize / 1024 / 1024).toFixed(2)}MB). Storing only sampleRows in CosmosDB.`);
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
            chunkIndexBlob: chunkIndexBlob,
            columnStatistics,
            dataSummaryStatistics,
            insights,
            sessionAnalysisContext,
            enrichmentStatus: 'complete',
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
          console.log(`✅ Updated session with processed data: ${chatDocument.id}`);
        } else {
          console.log(`📝 No placeholder found, creating new session: ${job.sessionId}`);
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
            enrichmentStatus: 'complete',
            selectedSheetName: job.sheetName,
            columnarStoragePath: columnarReadyMarker,
            lastUpdatedAt: Date.now(),
          });
        }
      } catch (cosmosError) {
        const errorMsg = cosmosError instanceof Error ? cosmosError.message : String(cosmosError);
        console.error("Failed to save chat document:", cosmosError);
        
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
          console.error('⚠️ postEnrichmentFlush failed:', flushErr);
        }
      }

      if (chatDocument?.sessionId) {
        const { scheduleIndexSessionRag } = await import("../lib/rag/indexSession.js");
        scheduleIndexSessionRag(job.sessionId);
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
      console.error(`Upload job ${job.jobId} failed:`, error);
      try {
        const { getChatBySessionIdEfficient, updateChatDocument } = await import('../models/chat.model.js');
        const doc = await getChatBySessionIdEfficient(job.sessionId);
        if (doc) {
          await updateChatDocument({
            ...doc,
            enrichmentStatus: 'failed',
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

