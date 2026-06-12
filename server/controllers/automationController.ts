/**
 * Wave A4 · Automation capture/list/get/delete endpoints.
 *
 * Run + dry-run (replay-side) endpoints land in Wave A8 — this file holds
 * only the capture-direction surfaces.
 */

import type { Request, Response } from "express";
import { requireUsername } from "../utils/auth.helper.js";
import { getChatDocument } from "../models/chat.model.js";
import {
  createAutomation,
  deleteAutomation,
  getAutomationById,
  listAutomationSummariesByUser,
} from "../models/automation.model.js";
import { buildRecipeFromChat } from "../lib/automations/buildRecipeFromChat.js";
import { computeAutomationColumnRemap } from "../lib/agents/runtime/automationRemap.js";
import {
  replayAutomation,
  type ReplaySseEvent,
} from "../lib/automations/replayLoop.service.js";
import {
  automationSchema,
  createAutomationRequestSchema,
  runAutomationRequestSchema,
} from "../shared/schema.js";
import { sendSSE, setSSEHeaders, startSseKeepalive } from "../utils/sse.helper.js";
import { z } from "zod";
import { logger } from "../lib/logger.js";

const handleError = (res: Response, error: unknown, fallback: number = 500) => {
  if (error instanceof Error) {
    logger.error("[automationController]", error);
    if (error.name === "AuthenticationError") {
      return res.status(401).json({ message: "Authentication required" });
    }
    if (error.message.includes("already exists")) {
      return res.status(409).json({ message: error.message });
    }
    return res.status(fallback).json({ message: error.message });
  }
  logger.error("[automationController] non-Error thrown:", error);
  return res.status(fallback).json({ message: "Internal server error" });
};

/**
 * POST /api/automations
 * Body: { sessionId, name, description? }
 *
 * Captures the current chat session as a re-runnable Automation.
 */
export const createAutomationController = async (
  req: Request,
  res: Response
) => {
  try {
    const username = requireUsername(req);
    const parsed = createAutomationRequestSchema.parse(req.body);

    const chat = await getChatDocument(parsed.sessionId, username);
    if (!chat) {
      return res.status(404).json({ message: "Chat session not found" });
    }
    if (chat.username?.toLowerCase() !== username.toLowerCase()) {
      // Defence in depth — getChatDocument already filters, but be explicit.
      return res.status(403).json({ message: "Not your session" });
    }

    const { draft, stats } = buildRecipeFromChat(
      {
        id: chat.id,
        sessionId: chat.sessionId,
        username,
        fileName: chat.fileName,
        messages: (chat.messages ?? []) as never,
        dataSummary: chat.dataSummary,
        permanentContext: chat.permanentContext,
        sessionAnalysisContext: chat.sessionAnalysisContext as
          | Record<string, unknown>
          | undefined,
      },
      { name: parsed.name, description: parsed.description }
    );

    if (draft.recipe.length === 0) {
      return res.status(400).json({
        message:
          "This chat has no completed analytical turns to capture yet. Ask at least one question and wait for the answer before saving.",
      });
    }

    // Validate the body against the schema before sending to Cosmos so we
    // surface validation errors at request time, not at persist time.
    automationSchema
      .omit({ id: true, createdAt: true, runCount: true, lastRunAt: true })
      .parse(draft);

    const automation = await createAutomation(draft);

    return res.status(201).json({
      id: automation.id,
      name: automation.name,
      stats,
    });
  } catch (error) {
    return handleError(res, error, 400);
  }
};

/**
 * GET /api/automations
 * Lists summaries (cheap shape) for the current user, newest first.
 */
export const listAutomationsController = async (
  req: Request,
  res: Response
) => {
  try {
    const username = requireUsername(req);
    const summaries = await listAutomationSummariesByUser(username);
    return res.json({ automations: summaries });
  } catch (error) {
    return handleError(res, error);
  }
};

/**
 * GET /api/automations/:id
 * Returns the full automation document (recipe + transformations + schema).
 */
export const getAutomationController = async (req: Request, res: Response) => {
  try {
    const username = requireUsername(req);
    const id = req.params.id;
    if (!id) return res.status(400).json({ message: "Missing automation id" });
    const automation = await getAutomationById(id, username);
    if (!automation) {
      return res.status(404).json({ message: "Automation not found" });
    }
    return res.json({ automation });
  } catch (error) {
    return handleError(res, error);
  }
};

/**
 * POST /api/automations/:id/dry-run
 * Body: { sessionId }
 *
 * Computes the column-mapping diff between the automation's expected
 * schema and the new session's dataSummary. Returns
 * `AutomationDryRunResult` (exactMatches + proposedMappings + unmatchable).
 */
const dryRunRequestSchema = z.object({
  sessionId: z.string().min(1).max(200),
});

export const dryRunAutomationController = async (
  req: Request,
  res: Response
) => {
  try {
    const username = requireUsername(req);
    const id = req.params.id;
    if (!id) return res.status(400).json({ message: "Missing automation id" });
    const { sessionId } = dryRunRequestSchema.parse(req.body);

    const automation = await getAutomationById(id, username);
    if (!automation) {
      return res.status(404).json({ message: "Automation not found" });
    }
    const chat = await getChatDocument(sessionId, username);
    if (!chat) {
      return res.status(404).json({ message: "Target chat session not found" });
    }
    const newColumns =
      chat.dataSummary?.columns?.map((c) => ({
        name: c.name,
        type: c.type,
        sampleValues: c.sampleValues?.slice(0, 6),
      })) ?? [];

    const result = await computeAutomationColumnRemap(
      automation.expectedSchema.finalColumns,
      newColumns,
      { turnId: `automation_${id}_dryrun` }
    );

    return res.json(result);
  } catch (error) {
    return handleError(res, error, 400);
  }
};

/**
 * POST /api/automations/:id/run    (Server-Sent Events)
 * Body: { sessionId, columnMapping? }
 *
 * Replays the saved automation against `sessionId`. Streams progress
 * via SSE: `automation_started`, `automation_progress`,
 * `automation_halted`, `automation_complete` events.
 */
export const runAutomationController = async (req: Request, res: Response) => {
  let stopKeepalive: (() => void) | null = null;
  const abortController = new AbortController();

  try {
    const username = requireUsername(req);
    const id = req.params.id;
    if (!id) return res.status(400).json({ message: "Missing automation id" });
    const parsed = runAutomationRequestSchema.parse(req.body);
    const resumeFromOrdinal =
      typeof (req.body as { resumeFromOrdinal?: unknown }).resumeFromOrdinal ===
      "number"
        ? (req.body as { resumeFromOrdinal: number }).resumeFromOrdinal
        : undefined;

    // SSE plumbing — uses the shared helper so we get:
    //   • X-Accel-Buffering: no (defeats Vercel/nginx response buffering)
    //   • Cache-Control: no-cache + Connection: keep-alive
    //   • centralized closed-connection tracking via WeakSet<Response>
    setSSEHeaders(res);
    res.flushHeaders?.();
    // 15s keepalive ping prevents the proxy idle-timeout from closing the
    // connection silently mid-replay. Critical for replays > 30s.
    stopKeepalive = startSseKeepalive(res);

    // Abort the replay loop when the client disconnects. The chat-stream
    // service uses the same pattern — see services/chat/chatStream.service.ts.
    // Without this, server keeps running every remaining turn after the
    // browser tab closes (LLM budget burn + orphan persists).
    req.on("close", () => {
      abortController.abort();
    });

    const emit = (event: ReplaySseEvent) => {
      sendSSE(res, event.type, event);
    };

    const result = await replayAutomation({
      sessionId: parsed.sessionId,
      automationId: id,
      username,
      columnMapping: parsed.columnMapping,
      resumeFromOrdinal,
      emit,
      abortSignal: abortController.signal,
    });

    // Final marker so the client knows the SSE stream is closing.
    sendSSE(res, "stream_end", { ok: result.ok });
    stopKeepalive?.();
    res.end();
  } catch (error) {
    stopKeepalive?.();
    if (!res.headersSent) {
      return handleError(res, error, 400);
    }
    sendSSE(res, "automation_halted", {
      ordinal: 0,
      error: error instanceof Error ? error.message : String(error),
    });
    try {
      res.end();
    } catch {
      /* connection already gone */
    }
  }
};

/**
 * DELETE /api/automations/:id
 */
export const deleteAutomationController = async (
  req: Request,
  res: Response
) => {
  try {
    const username = requireUsername(req);
    const id = req.params.id;
    if (!id) return res.status(400).json({ message: "Missing automation id" });
    await deleteAutomation(id, username);
    return res.status(204).end();
  } catch (error) {
    return handleError(res, error);
  }
};
