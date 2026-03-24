import { Request, Response } from "express";
import multer from "multer";
import { uploadQueue } from "../utils/uploadQueue.js";
import { requireUsername, AuthenticationError } from "../utils/auth.helper.js";

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

    // Enqueue immediately; placeholder/blob best-effort work happens in queue worker
    const jobId = await uploadQueue.enqueue(
      sessionId,
      username,
      req.file.originalname,
      req.file.buffer,
      req.file.mimetype
    );

    console.log(`📤 Upload job enqueued: ${jobId} for session ${sessionId}`);

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
    console.error('Upload error:', error);
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
    const { jobId } = req.params;
    
    if (!jobId) {
      return res.status(400).json({ error: 'Job ID is required' });
    }

    const job = uploadQueue.getJob(jobId);
    
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const response: any = {
      jobId: job.jobId,
      sessionId: job.sessionId,
      status: job.status,
      progress: job.progress,
      createdAt: job.createdAt,
    };
    const phaseByStatus: Record<string, { phase: string; message: string }> = {
      pending: { phase: "queued", message: "Waiting for a worker slot." },
      uploading: { phase: "queued", message: "Upload accepted and queued for processing." },
      parsing: { phase: "preparing_preview", message: "Preparing dataset preview." },
      preview_ready: { phase: "preparing_preview", message: "Preview is ready." },
      analyzing: { phase: "enriching", message: "Enriching dataset context." },
      saving: { phase: "finalizing", message: "Finalizing and saving analysis." },
      completed: { phase: "completed", message: "Upload processing complete." },
      failed: { phase: "failed", message: "Upload processing failed." },
    };
    const phaseInfo = phaseByStatus[job.status] || { phase: "queued", message: "Processing upload." };
    response.phase = phaseInfo.phase;
    response.phaseMessage = phaseInfo.message;

    if (job.startedAt) {
      response.startedAt = job.startedAt;
    }

    if (job.completedAt) {
      response.completedAt = job.completedAt;
    }

    if (job.error) {
      response.error = job.error;
    }

    if (job.enrichmentStep) {
      response.enrichmentStep = job.enrichmentStep;
    }
    if (job.warnings && job.warnings.length > 0) {
      response.warnings = job.warnings;
    }

    if (job.status === 'completed' && job.result) {
      response.result = job.result;
    }

    // Preview rows + summary are persisted at preview_ready; the job then moves through
    // analyzing/saving before completed. Clients poll this endpoint — treat all post-preview
    // phases as preview-ready so the UI does not miss the narrow preview_ready window.
    response.previewReady =
      job.status === "preview_ready" ||
      job.status === "analyzing" ||
      job.status === "saving" ||
      job.status === "completed";
    response.previewPayloadState = "none";

    try {
      const { getChatBySessionIdEfficient } = await import("../models/chat.model.js");
      const session = await getChatBySessionIdEfficient(job.sessionId);
      if (session?.enrichmentStatus) {
        response.enrichmentStatus = session.enrichmentStatus;
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
    } catch {
      /* ignore */
    }

    if (response.previewReady) {
      console.log(
        `[uploadStatus] job=${job.jobId} status=${job.status} previewPayloadState=${response.previewPayloadState} rows=${response.previewSampleRows?.length ?? 0}`
      );
    }

    res.json(response);
  } catch (error) {
    console.error('Get upload status error:', error);
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
    console.error('Get queue stats error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get queue stats',
    });
  }
};
