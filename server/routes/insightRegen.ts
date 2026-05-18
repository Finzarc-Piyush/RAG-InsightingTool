/**
 * Wave WI2-server · POST /api/insight/regen
 *
 * Per-tile dashboard insight regeneration. The client calls this on
 * cache miss from its WI2-cache LRU+TTL store; the response shape
 * matches `InsightRegenEntry` so the client can write the cache
 * verbatim.
 *
 * Body: { tileId, spec, filteredData, domainContext?, datasetContextHint? }
 * Response: { text, citations?, regeneratedAt, confidenceTier }
 *
 * Bound to the existing authenticated route surface via
 * `routes/index.ts`. Auth check via `getAuthenticatedEmail` matches
 * every other write route on this server.
 */

import { Router, type Request, type Response } from "express";
import { getAuthenticatedEmail } from "../utils/auth.helper.js";
import { agentLog } from "../lib/agents/runtime/agentLogger.js";
import {
  regenInsightForFilteredView,
  regenInsightRequestSchema,
} from "../lib/insightRegen.js";

const router = Router();

export async function insightRegenController(req: Request, res: Response) {
  const userEmail = getAuthenticatedEmail(req);
  if (!userEmail) {
    return res.status(401).json({ error: "Missing authenticated user email." });
  }

  const parsed = regenInsightRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid request body.",
      details: parsed.error.flatten(),
    });
  }

  try {
    const response = await regenInsightForFilteredView(parsed.data);
    agentLog("insight_regen.done", {
      tileId: parsed.data.tileId,
      rowCount: parsed.data.filteredData.length,
      confidenceTier: response.confidenceTier,
      citationCount: response.citations?.length ?? 0,
    });
    return res.status(200).json(response);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    agentLog("insight_regen.error", {
      tileId: parsed.data.tileId,
      error: message.slice(0, 200),
    });
    return res.status(500).json({ error: "insight_regen_failed" });
  }
}

router.post("/insight/regen", insightRegenController);

export default router;
