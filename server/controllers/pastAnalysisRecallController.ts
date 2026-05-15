/**
 * AMR3c · GET /api/past-analyses/:sessionId/:turnId/pivot/:artifactId
 *
 * Fetches the aggregated row data for a `PastAnalysisPivotArtifact` whose
 * `storage.kind === "blob"`. Used by the cache-hit recall path: the
 * cache-hit response carries pivot metadata (artifactId, headers,
 * rowCount, pivotDefaults) on the message, but blob-offloaded rows are
 * fetched on-demand when the user opens the pivot tab.
 *
 * Authz: the doc's `userId` must match the authenticated email — never
 * serve another user's prior analysis. `sessionId` + deterministic
 * `${sessionId}__${turnId}` doc id make this a single point-read; no
 * cross-partition query needed.
 *
 * Inline artifacts return their `rows` array unchanged (no blob round-trip).
 * Unknown artifactId, mismatched user, missing blob → 404 (don't leak
 * whether a doc exists for a different user).
 */

import type { Request, Response } from "express";
import { getAuthenticatedEmail } from "../utils/auth.helper.js";
import { getPastAnalysisDoc } from "../models/pastAnalysis.model.js";
import { getFileFromBlob } from "../lib/blobStorage.js";

export async function pastAnalysisRecallPivotController(
  req: Request,
  res: Response
) {
  const userEmail = getAuthenticatedEmail(req);
  if (!userEmail) {
    return res
      .status(401)
      .json({ error: "Missing authenticated user email." });
  }

  const { sessionId, turnId, artifactId } = req.params as {
    sessionId?: string;
    turnId?: string;
    artifactId?: string;
  };
  if (!sessionId || !turnId || !artifactId) {
    return res
      .status(400)
      .json({ error: "Missing sessionId / turnId / artifactId." });
  }

  const docId = `${sessionId}__${turnId}`;
  let doc;
  try {
    doc = await getPastAnalysisDoc(sessionId, docId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`⚠️ pastAnalysisRecall: getPastAnalysisDoc failed (${msg})`);
    return res.status(500).json({ error: "lookup_failed" });
  }
  if (!doc) {
    return res.status(404).json({ error: "not_found" });
  }
  // Authz: only the original user can recall their own pivot rows.
  if (doc.userId.toLowerCase() !== userEmail.toLowerCase()) {
    return res.status(404).json({ error: "not_found" });
  }

  const artifact = (doc.pivotArtifacts ?? []).find(
    (a) => a.artifactId === artifactId
  );
  if (!artifact) {
    return res.status(404).json({ error: "not_found" });
  }

  if (artifact.storage.kind === "inline") {
    return res.json({
      artifactId,
      rowCount: artifact.rowCount,
      rows: artifact.storage.rows,
    });
  }

  // Blob path — download + parse.
  try {
    const buf = await getFileFromBlob(artifact.storage.blobName);
    const parsed = JSON.parse(buf.toString("utf8")) as Record<string, unknown>[];
    return res.json({
      artifactId,
      rowCount: artifact.rowCount,
      rows: parsed,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `⚠️ pastAnalysisRecall: blob fetch failed for ${artifact.storage.blobName} (${msg})`
    );
    return res.status(502).json({ error: "blob_fetch_failed" });
  }
}
