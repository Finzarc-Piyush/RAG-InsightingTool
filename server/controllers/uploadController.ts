import { Request, Response } from "express";
import multer from "multer";
import {
  uploadQueue,
  deriveStatusFromEnrichment,
  type UploadJobStatusView,
} from "../utils/uploadQueue.js";
import { requireUsername, AuthenticationError } from "../utils/auth.helper.js";
import { isSuperadminRequest } from "../lib/superadmin.js";
import { mergeSuggestedQuestions } from "../lib/suggestedQuestions.js";
import { getExcelSheetNames } from "../lib/fileParser.js";
import { createPlaceholderSession } from "../models/chat.model.js";
import { logger } from "../lib/logger.js";

/**
 * Upload file endpoint - now uses async queue processing
 * Returns immediately with jobId for status tracking
 */
export const uploadFile = async (
  req: Request & { file?: Express.Multer.File },
  res: Response
) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    let username: string;
    try {
      username = requireUsername(req);
    } catch (e) {
      if (e instanceof AuthenticationError) {
        return res.status(401).json({ error: e.message });
      }
      throw e;
    }

    // Generate a unique session ID for this upload
    const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const requestedSheetName =
      typeof req.body?.sheetName === "string" ? req.body.sheetName.trim() : undefined;
    const ext = req.file.originalname.split(".").pop()?.toLowerCase();
    const isExcel = ext === "xlsx" || ext === "xls";

    if (isExcel) {
      const sheetNames = await getExcelSheetNames(req.file.buffer);
      if (sheetNames.length > 1 && !requestedSheetName) {
        return res.status(400).json({
          error: "This workbook has multiple sheets. Please select a sheet before upload.",
          code: "SHEET_SELECTION_REQUIRED",
          sheetNames,
        });
      }
      if (requestedSheetName && !sheetNames.includes(requestedSheetName)) {
        return res.status(400).json({
          error: `Selected sheet "${requestedSheetName}" does not exist in workbook.`,
          code: "INVALID_SHEET_NAME",
          sheetNames,
        });
      }
    }

    // Wave QL10 · Create the placeholder chat document BEFORE enqueueing
    // the background job, so the sessionId we return in the 202 response
    // is GUARANTEED to be queryable by the client's immediate polls. Mirrors
    // the existing pattern in `snowflakeController.ts` (which has always
    // done this and so never hit the "No chat document found" race). Without
    // this, the queue worker creates the placeholder ~500ms–2s after the
    // 202 response (after dynamic imports + Azure blob upload finish), and
    // the client polls land in that gap with "No chat document found".
    try {
      await createPlaceholderSession(
        username,
        req.file.originalname,
        sessionId,
        req.file.size,
        undefined
      );
    } catch (placeholderErr) {
      logger.error(
        "❌ Failed to create placeholder session for upload:",
        placeholderErr
      );
      return res.status(500).json({
        error:
          "Failed to create session record. Please retry the upload.",
      });
    }

    // Enqueue the heavy work; the worker's idempotent re-check at L246–260
    // of uploadQueue.ts short-circuits because we just created the row.
    const jobId = await uploadQueue.enqueue(
      sessionId,
      username,
      req.file.originalname,
      req.file.buffer,
      req.file.mimetype,
      requestedSheetName
    );

    logger.log(`📤 Upload job enqueued: ${jobId} for session ${sessionId}`);

    // Return immediately with job ID and session ID
    res.status(202).json({
      jobId,
      sessionId,
      fileName: req.file.originalname,
      status: 'processing',
      message: 'File upload accepted. Processing in background. Use /api/upload/status/:jobId to check progress.',
    });
  } catch (error) {
    if (error instanceof AuthenticationError) {
      res.status(401).json({ error: error.message });
      return;
    }
    logger.error('Upload error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to process file',
    });
  }
};

/**
 * Get upload job status
 */
export const getUploadStatus = async (req: Request, res: Response) => {
  try {
    let email: string;
    try {
      email = requireUsername(req);
    } catch (e) {
      if (e instanceof AuthenticationError) {
        return res.status(401).json({ error: e.message });
      }
      throw e;
    }

    const { jobId } = req.params;

    if (!jobId) {
      return res.status(400).json({ error: 'Job ID is required' });
    }

    // DATA-2 · the client tracks both jobId and sessionId; it passes the
    // sessionId so a poll that lands on a NON-owning instance (or after a
    // cold start) can resolve from the durable Cosmos doc instead of the
    // instance-pinned in-memory Map.
    const sessionIdHint =
      typeof req.query?.sessionId === "string" ? req.query.sessionId.trim() : undefined;

    const requesterEmail = email.trim().toLowerCase();

    // DATA-2 · the durable Cosmos doc, read once and reused. It is the
    // cross-instance status source (persisted `enrichmentStatus`) AND the
    // source of preview/suggested-questions detail layered on below. We read
    // it lazily: the Map fast path needs it for the detail block; the doc
    // fallback needs it for the status itself.
    const { getChatBySessionIdEfficient } = await import(
      "../models/chat.model.js"
    );

    // Fast path: in-memory job on the owning instance (write-through cache).
    const job = uploadQueue.getJob(jobId);

    // Resolve the status source — Map first, then the persisted doc.
    let source: UploadJobStatusView | null = job;
    let session: Awaited<ReturnType<typeof getChatBySessionIdEfficient>> | null =
      null;

    if (!source) {
      // DATA-2 · cross-instance fallback. Without a sessionId hint we cannot
      // map jobId → doc (the Map is the only jobId index), so a true cold
      // poll without the hint still 404s — but the client always supplies it.
      if (!sessionIdHint) {
        return res.status(404).json({ error: 'Job not found' });
      }
      try {
        session = await getChatBySessionIdEfficient(sessionIdHint);
      } catch {
        session = null;
      }
      if (!session?.enrichmentStatus) {
        // No durable status to report — behave as before (existence-hiding).
        return res.status(404).json({ error: 'Job not found' });
      }
      const docSuggestedQuestions = mergeSuggestedQuestions(
        session.sessionAnalysisContext?.suggestedFollowUps,
        session.datasetProfile?.suggestedQuestions
      );
      source = deriveStatusFromEnrichment({
        jobId,
        sessionId: sessionIdHint,
        username: session.username ?? "",
        enrichmentStatus: session.enrichmentStatus,
        createdAt: session.createdAt,
        lastUpdatedAt: session.lastUpdatedAt,
        suggestedQuestions: docSuggestedQuestions,
      });
    }

    // SEC-1: tenant-isolation check. The status source carries the owner's
    // email (from the Map job or the doc); a requester may only poll their
    // own job (superadmins may shadow-view). Respond 404 (not 403) on
    // mismatch so the endpoint does not confirm the existence of another
    // tenant's job to an attacker enumerating ids.
    const ownerEmail = (source.username ?? "").trim().toLowerCase();
    if (ownerEmail !== requesterEmail && !isSuperadminRequest(req)) {
      logger.warn(
        `⚠️ [uploadStatus] cross-tenant access blocked: requester=${requesterEmail} owner=${ownerEmail} job=${jobId}`
      );
      return res.status(404).json({ error: 'Job not found' });
    }

    const response: any = {
      jobId: source.jobId,
      sessionId: source.sessionId,
      status: source.status,
      progress: source.progress,
      createdAt: source.createdAt,
    };
    const phaseByStatus: Record<string, { phase: string; message: string }> = {
      pending: { phase: "queued", message: "Waiting for a worker slot." },
      uploading: { phase: "queued", message: "Upload accepted and queued for processing." },
      parsing: { phase: "preparing_preview", message: "Preparing dataset preview." },
      preview_ready: { phase: "preparing_preview", message: "Preview is ready." },
      analyzing: { phase: "enriching", message: "Enriching data understanding and preparing suggested analysis questions." },
      saving: { phase: "finalizing", message: "Finalizing and saving analysis." },
      completed: { phase: "completed", message: "Upload processing complete." },
      failed: { phase: "failed", message: "Upload processing failed." },
    };
    const phaseInfo = phaseByStatus[source.status] || { phase: "queued", message: "Processing upload." };
    response.phase = phaseInfo.phase;
    response.phaseMessage = phaseInfo.message;

    if (source.startedAt) {
      response.startedAt = source.startedAt;
    }

    if (source.completedAt) {
      response.completedAt = source.completedAt;
    }

    if (source.error) {
      response.error = source.error;
    }

    if (source.enrichmentStep) {
      response.enrichmentStep = source.enrichmentStep;
    }
    if (source.understandingReady) {
      response.understandingReady = true;
      response.understandingReadyAt = source.understandingReadyAt;
      if (Array.isArray(source.suggestedQuestions) && source.suggestedQuestions.length > 0) {
        response.suggestedQuestions = source.suggestedQuestions;
      }
    }
    if (source.warnings && source.warnings.length > 0) {
      response.warnings = source.warnings;
    }

    // `result` lives only in the Map (it is not persisted on the doc); when
    // the fast-path job is present and completed, surface it. The doc
    // fallback recovers the same client-facing completion via
    // enrichmentStatus + previewReady + suggestedQuestions below.
    if (job?.status === 'completed' && job.result) {
      response.result = job.result;
    }

    // Preview rows + summary are persisted at preview_ready; the job then moves through
    // analyzing/saving before completed. Clients poll this endpoint — treat all post-preview
    // phases as preview-ready so the UI does not miss the narrow preview_ready window.
    response.previewReady =
      source.status === "preview_ready" ||
      source.status === "analyzing" ||
      source.status === "saving" ||
      source.status === "completed";
    response.previewPayloadState = "none";

    try {
      // Reuse the doc already read on the fallback path; otherwise read it now
      // for the Map fast path (preview/suggested-questions detail).
      if (!session) {
        session = await getChatBySessionIdEfficient(source.sessionId);
      }
      if (session?.enrichmentStatus) {
        response.enrichmentStatus = session.enrichmentStatus;
      }
      const mergedSuggestedQuestions = mergeSuggestedQuestions(
        session?.sessionAnalysisContext?.suggestedFollowUps,
        session?.datasetProfile?.suggestedQuestions
      );
      if (mergedSuggestedQuestions.length > 0) {
        response.suggestedQuestions = mergedSuggestedQuestions;
      }
      if (
        session?.dataSummary &&
        session.dataSummary.rowCount > 0 &&
        (session.enrichmentStatus === "pending" ||
          session.enrichmentStatus === "in_progress")
      ) {
        response.enrichmentPhase =
          session.enrichmentStatus === "in_progress" ? "enriching" : "waiting";
      }
      if (
        response.previewReady &&
        session?.dataSummary?.columns &&
        Array.isArray(session.dataSummary.columns)
      ) {
        response.previewSummary = {
          rowCount: session.dataSummary.rowCount ?? 0,
          columnCount: session.dataSummary.columnCount ?? 0,
          columns: session.dataSummary.columns.map((c: any) => ({
            name: c.name,
            type: c.type,
          })),
          numericColumns: session.dataSummary.numericColumns || [],
          dateColumns: session.dataSummary.dateColumns || [],
        };
        response.previewSampleRows = Array.isArray(session.sampleRows)
          ? session.sampleRows.slice(0, 50)
          : [];
        response.previewPayloadState =
          response.previewSampleRows.length > 0 ? "full" : "summary_only";
      } else if (response.previewReady) {
        response.previewPayloadState = "none";
      }
      if (session?.enrichmentStatus === "complete") {
        response.understandingReady = true;
      }
    } catch {
      /* ignore */
    }

    if (response.previewReady) {
      logger.log(
        `[uploadStatus] job=${source.jobId} status=${source.status} src=${source.fromDoc ? "doc" : "map"} previewPayloadState=${response.previewPayloadState} rows=${response.previewSampleRows?.length ?? 0}`
      );
    }

    res.json(response);
  } catch (error) {
    logger.error('Get upload status error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get upload status',
    });
  }
};

/**
 * Get queue statistics (admin endpoint)
 */
export const getQueueStats = async (req: Request, res: Response) => {
  try {
    requireUsername(req);
    const stats = uploadQueue.getStats();
    res.json(stats);
  } catch (error) {
    if (error instanceof AuthenticationError) {
      res.status(401).json({ error: error.message });
      return;
    }
    logger.error('Get queue stats error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get queue stats',
    });
  }
};
