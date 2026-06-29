import { Request, Response } from "express";
import { requireUsername, AuthenticationError } from "../utils/auth.helper.js";
import { getChatBySessionIdForUser } from "../models/chat.model.js";
import { getFileFromBlob } from "../lib/blobStorage.js";
import { uploadQueue } from "../utils/uploadQueue.js";
import { tableRegionOverrideSchema } from "../shared/schema.js";
import { logger } from "../lib/logger.js";

function mimeForFile(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase();
  if (ext === "csv") return "text/csv";
  if (ext === "xls") return "application/vnd.ms-excel";
  return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
}

/**
 * POST /api/sessions/:sessionId/retable
 *
 * User correction of a wrong main-table detection. Re-parses the ORIGINAL file
 * (from blob storage) with the user-chosen header/table region and regenerates
 * the whole analysis by re-running the upload pipeline (`processJob`) on the
 * existing session — so columns, summary, profile, and suggested questions all
 * refresh in place. The client re-polls the existing upload-status flow with
 * the returned jobId, exactly like a fresh upload. Non-blocking: this is a
 * user-triggered regeneration, never a startup gate.
 */
export const retableSessionEndpoint = async (req: Request, res: Response) => {
  try {
    let username: string;
    try {
      username = requireUsername(req);
    } catch (e) {
      if (e instanceof AuthenticationError) return res.status(401).json({ error: e.message });
      throw e;
    }

    const { sessionId } = req.params;
    if (!sessionId) return res.status(400).json({ error: "Missing sessionId" });

    // Body may be the override directly or wrapped as { tableRegion }.
    const parsed = tableRegionOverrideSchema.safeParse(req.body?.tableRegion ?? req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: "Invalid table region", details: parsed.error.flatten() });
    }

    const doc = await getChatBySessionIdForUser(sessionId, username);
    if (!doc) return res.status(404).json({ error: "Analysis not found" });

    const blobName = doc.blobInfo?.blobName;
    if (!blobName) {
      return res.status(409).json({
        error:
          "The original file is no longer available, so the table can't be re-read. Please re-upload to change the header.",
        code: "ORIGINAL_FILE_UNAVAILABLE",
      });
    }

    let buffer: Buffer;
    try {
      buffer = await getFileFromBlob(blobName);
    } catch (e) {
      logger.error("retable: original blob fetch failed", e);
      return res.status(409).json({
        error: "Could not read the original file. Please re-upload to change the header.",
        code: "ORIGINAL_FILE_UNAVAILABLE",
      });
    }

    const fileName = doc.fileName || "data.xlsx";
    const jobId = await uploadQueue.enqueue(
      sessionId,
      username,
      fileName,
      buffer,
      mimeForFile(fileName),
      doc.selectedSheetName,
      doc.blobInfo,
      parsed.data,
    );

    logger.log(
      `🔁 Retable job ${jobId} for session ${sessionId} (header → row ${parsed.data.headerRow + 1})`,
    );
    return res.status(202).json({ jobId, sessionId, status: "processing" });
  } catch (error) {
    if (error instanceof AuthenticationError) return res.status(401).json({ error: error.message });
    logger.error("retable error:", error);
    return res
      .status(500)
      .json({ error: error instanceof Error ? error.message : "Failed to re-read the table" });
  }
};
