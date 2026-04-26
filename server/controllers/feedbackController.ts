/**
 * W5.5 · Thumbs up/down feedback for past analyses.
 *
 * Endpoint: POST /api/feedback
 * Body: { sessionId: string, turnId: string, feedback: "up" | "down" | "none" }
 *
 * Effect:
 *   1. Updates the source-of-truth `past_analyses` Cosmos doc via
 *      `setPastAnalysisFeedback`.
 *   2. Re-pushes the doc to AI Search so the cache lookup filter
 *      `feedback ne 'down'` immediately stops serving down-voted answers.
 *
 * The two writes run sequentially. AI Search is best-effort — if it fails the
 * Cosmos record still reflects the user's vote and a later re-index will pick
 * it up. We never roll back the Cosmos write because that would silently
 * discard user feedback.
 */

import type { Request, Response } from "express";
import { z } from "zod";
import { getAuthenticatedEmail } from "../utils/auth.helper.js";
import {
  setPastAnalysisFeedback,
  getPastAnalysisDoc,
} from "../models/pastAnalysis.model.js";
import { mergeFeedbackInPastAnalysisIndex } from "../lib/rag/pastAnalysesStore.js";
import {
  pastAnalysisFeedbackSchema,
  pastAnalysisFeedbackReasonSchema,
} from "../shared/schema.js";

const feedbackBodySchema = z.object({
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  feedback: pastAnalysisFeedbackSchema,
  // W9 · structured reasons (closed enum) + optional free-text comment.
  // Both fields are optional for backwards compat with W5.5b clients.
  reasons: z.array(pastAnalysisFeedbackReasonSchema).max(7).optional(),
  comment: z.string().max(500).optional(),
});

export async function feedbackController(req: Request, res: Response) {
  const userEmail = getAuthenticatedEmail(req);
  if (!userEmail) {
    return res.status(401).json({ error: "Missing authenticated user email." });
  }

  const parsed = feedbackBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid request body.",
      details: parsed.error.flatten(),
    });
  }
  const { sessionId, turnId, feedback, reasons, comment } = parsed.data;
  const docId = `${sessionId}__${turnId}`;

  // Authz: refuse to mutate another user's row. The userId on the doc is
  // normalized email and so is `userEmail` from the AAD token.
  let existing;
  try {
    existing = await getPastAnalysisDoc(sessionId, docId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`⚠️ feedback: getPastAnalysisDoc failed (${msg})`);
    return res.status(500).json({ error: "feedback_lookup_failed" });
  }
  if (!existing) {
    return res.status(404).json({ error: "past_analysis_not_found" });
  }
  if (existing.userId.toLowerCase() !== userEmail.toLowerCase()) {
    return res.status(403).json({ error: "not_owner" });
  }

  // Source-of-truth write first. W9 · clear reasons/comment on up-vote or
  // retraction so the doc never carries stale "why I disliked it" data after
  // a thumbs-up.
  const effectiveReasons = feedback === "down" ? reasons ?? [] : [];
  const effectiveComment = feedback === "down" ? comment : undefined;
  try {
    await setPastAnalysisFeedback(sessionId, docId, feedback, effectiveReasons, effectiveComment);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`⚠️ feedback: setPastAnalysisFeedback failed (${msg})`);
    return res.status(500).json({ error: "feedback_persist_failed" });
  }

  // Re-push to AI Search so the cache filter sees the new feedback immediately.
  // Best-effort — log + continue if it fails.
  try {
    await mergeFeedbackInPastAnalysisIndex(docId, feedback);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `⚠️ feedback: AI Search merge failed for ${docId} (Cosmos updated, index will catch up later): ${msg}`
    );
  }

  return res.json({
    ok: true,
    docId,
    feedback,
  });
}
