/**
 * Wave WR3 (incremental refresh) · refresh endpoints.
 *
 *   POST /api/sessions/:sessionId/refresh/preflight   (multipart, JSON reply)
 *     Parses the incoming file, returns the diff (rows/cols before→after), the
 *     column-mapping dry-run (reusing the automation remap engine), and a
 *     recipe summary — NO mutation. The client renders the preview + (if
 *     columns drifted) the AutomationRemapDialog before committing.
 *
 *   POST /api/sessions/:sessionId/refresh                (multipart, SSE reply)
 *     Commits the refresh: ingest new data + replay in overwrite mode. Streams
 *     the same `automation_*` SSE events the AutomationReplayBanner renders.
 *
 * Gated by INCREMENTAL_REFRESH_ENABLED (404 when off — feature is invisible).
 */

import type { Request, Response } from "express";
import { requireUsername } from "../utils/auth.helper.js";
import { getChatDocument, TURN_LEASE_TTL_MS } from "../models/chat.model.js";
import { isIncrementalRefreshEnabled } from "../lib/envFlags.js";
import { parseFile, createDataSummary } from "../lib/fileParser.js";
import { buildRecipeFromChat } from "../lib/automations/buildRecipeFromChat.js";
import { computeAutomationColumnRemap } from "../lib/agents/runtime/automationRemap.js";
import { fetchSnowflakeRefreshRows } from "../lib/refresh/ingestNewVersion.js";
import { inferBusinessKey } from "../lib/refresh/unionAppend.js";
import {
  rollbackLastRefresh,
  buildRefreshHistoryView,
} from "../lib/refresh/rollbackRefresh.service.js";
import { buildRefreshCompare } from "../lib/refresh/compareVersions.js";
import { getDashboardById } from "../models/dashboard.model.js";
import {
  runDueScheduledRefreshes,
  setRefreshSchedule,
} from "../lib/refresh/scheduledRefresh.service.js";
import {
  refreshSession,
  type RefreshSessionArgs,
} from "../lib/refresh/refreshSession.service.js";
import type { ReplaySseEvent } from "../lib/automations/replayLoop.service.js";
import type { AutomationColumnInfo } from "../shared/schema.js";
import { sendSSE, setSSEHeaders, startSseKeepalive } from "../utils/sse.helper.js";
import { logger } from "../lib/logger.js";
import { errorMessage } from "../utils/errorMessage.js";

const handleError = (res: Response, error: unknown, fallback = 500) => {
  logger.error("[refreshController]", error);
  const msg = error instanceof Error ? error.message : "Internal server error";
  return res.status(fallback).json({ message: msg });
};

const featureOff = (res: Response) =>
  res.status(404).json({ message: "Not found" });

/** Parse the uploaded file into rows (CSV/Excel), honouring an optional sheet. */
async function parseRequestFile(
  req: Request
): Promise<Record<string, unknown>[]> {
  const file = (req as Request & { file?: Express.Multer.File }).file;
  if (!file) throw new Error("No file uploaded.");
  const sheetName =
    typeof req.body?.sheetName === "string" ? req.body.sheetName.trim() : undefined;
  return parseFile(file.buffer, file.originalname, { sheetName });
}

const toColumnInfo = (
  columns: { name: string; type: string }[]
): AutomationColumnInfo[] =>
  columns.map((c) => ({ name: c.name, type: c.type }));

/**
 * POST /api/sessions/:sessionId/refresh/preflight
 * Returns { diff, columnMapping, recipe } — no mutation.
 */
export const refreshPreflightController = async (
  req: Request,
  res: Response
) => {
  if (!isIncrementalRefreshEnabled()) return featureOff(res);
  try {
    const username = requireUsername(req);
    const sessionId = req.params.sessionId;
    if (!sessionId) return res.status(400).json({ message: "Missing sessionId" });

    const chat = await getChatDocument(sessionId, username);
    if (!chat) return res.status(404).json({ message: "Session not found" });

    const newRows = await parseRequestFile(req);
    if (newRows.length === 0) {
      return res.status(400).json({ message: "The file has no data rows." });
    }
    const newSummary = createDataSummary(newRows as Record<string, any>[]);

    // Recipe (built from the CURRENT chat → April schema/Q&A) drives both the
    // drift diff (April finalColumns vs the new file's columns) and the summary.
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
      { name: chat.fileName }
    );

    const columnMapping = await computeAutomationColumnRemap(
      draft.expectedSchema.finalColumns,
      toColumnInfo(newSummary.columns),
      { turnId: `refresh_${sessionId}_preflight` }
    );

    const rowsBefore = chat.dataSummary?.rowCount ?? 0;
    return res.json({
      diff: {
        rowsBefore,
        // replace = the new file's rows become the dataset; append (WR7) adds.
        rowsAfterReplace: newRows.length,
        rowsAfterAppend: rowsBefore + newRows.length,
        columnsBefore: chat.dataSummary?.columns?.length ?? 0,
        columnsAfter: newSummary.columns.length,
      },
      columnMapping,
      // New dataset column names (for the remap dialog's autocomplete).
      newColumns: newSummary.columns.map((c) => c.name),
      // Inferred dedup key for APPEND mode — surfaced so the UI can show + let
      // the user confirm/override which columns identify a row.
      appendKey: inferBusinessKey(chat.dataSummary),
      recipe: {
        turns: stats.capturedTurns,
        charts: stats.chartCount,
        dashboards: stats.dashboardCount,
        empty: draft.recipe.length === 0,
      },
    });
  } catch (error) {
    return handleError(res, error, 400);
  }
};

const parseColumnMapping = (
  raw: unknown
): Record<string, string> | undefined => {
  if (!raw) return undefined;
  try {
    const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (obj && typeof obj === "object") return obj as Record<string, string>;
  } catch {
    /* ignore malformed mapping — treated as no mapping */
  }
  return undefined;
};

/** Parse a JSON / already-array string-list field from multipart form data. */
const parseStringArray = (raw: unknown): string[] | undefined => {
  if (!raw) return undefined;
  try {
    const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (Array.isArray(arr)) return arr.filter((x): x is string => typeof x === "string");
  } catch {
    /* ignore malformed list */
  }
  return undefined;
};

/**
 * Shared SSE run for both the file and Snowflake refresh routes. Headers are
 * not yet sent on entry; callers have already done flag/auth/session/409
 * pre-checks and resolved the incoming `rows`.
 */
async function streamRefresh(
  req: Request,
  res: Response,
  base: Omit<RefreshSessionArgs, "emit" | "abortSignal">
): Promise<void> {
  let stopKeepalive: (() => void) | null = null;
  const abortController = new AbortController();
  try {
    setSSEHeaders(res);
    res.flushHeaders?.();
    stopKeepalive = startSseKeepalive(res);
    req.on("close", () => abortController.abort());

    const emit = (event: ReplaySseEvent) => sendSSE(res, event.type, event);
    const result = await refreshSession({
      ...base,
      emit,
      abortSignal: abortController.signal,
    });

    if (result.busy) {
      sendSSE(res, "automation_halted", { ordinal: 0, error: result.error });
    }
    sendSSE(res, "refresh_complete", {
      ok: result.ok,
      fromDataVersion: result.fromDataVersion,
      toDataVersion: result.toDataVersion,
      questionsReplayed: result.questionsReplayed,
      dashboardId: result.dashboardId,
      discovered: result.discovered,
    });
    sendSSE(res, "stream_end", { ok: result.ok });
    stopKeepalive?.();
    res.end();
  } catch (error) {
    stopKeepalive?.();
    if (!res.headersSent) {
      handleError(res, error, 400);
      return;
    }
    sendSSE(res, "automation_halted", { ordinal: 0, error: errorMessage(error) });
    try {
      res.end();
    } catch {
      /* connection already gone */
    }
  }
}

/** Shared pre-SSE guard: returns the chat, or sends an error response + null. */
async function refreshPreChecks(
  req: Request,
  res: Response
): Promise<{ username: string; sessionId: string } | null> {
  const username = requireUsername(req);
  const sessionId = req.params.sessionId;
  if (!sessionId) {
    res.status(400).json({ message: "Missing sessionId" });
    return null;
  }
  const chat = await getChatDocument(sessionId, username);
  if (!chat) {
    res.status(404).json({ message: "Session not found" });
    return null;
  }
  if (
    chat.turnInProgress &&
    Date.now() - chat.turnInProgress.startedAt < TURN_LEASE_TTL_MS
  ) {
    res.status(409).json({
      message:
        "A question or refresh is already running on this analysis. Finish or stop it first.",
    });
    return null;
  }
  return { username, sessionId };
}

/**
 * POST /api/sessions/:sessionId/refresh    (file source, Server-Sent Events)
 */
export const refreshController = async (req: Request, res: Response) => {
  if (!isIncrementalRefreshEnabled()) return featureOff(res);
  try {
    const pre = await refreshPreChecks(req, res);
    if (!pre) return;

    const policy = req.body?.policy === "append" ? "append" : "replace";
    const columnMapping = parseColumnMapping(req.body?.columnMapping);
    const appendKey = parseStringArray(req.body?.appendKey);
    const discover = req.body?.discover === "true" || req.body?.discover === true;
    const versionLabel =
      typeof req.body?.versionLabel === "string"
        ? req.body.versionLabel.trim().slice(0, 120)
        : undefined;

    // Parse the file before opening the stream so a parse error is a clean 400.
    const rows = await parseRequestFile(req);
    if (rows.length === 0) {
      return res.status(400).json({ message: "The file has no data rows." });
    }

    await streamRefresh(req, res, {
      sessionId: pre.sessionId,
      username: pre.username,
      rows,
      policy,
      columnMapping,
      appendKey,
      versionLabel,
      discover,
    });
  } catch (error) {
    if (!res.headersSent) return handleError(res, error, 400);
  }
};

/**
 * GET /api/sessions/:sessionId/refresh/history
 * Returns the version/label info the "Data: as of …" badge renders + whether a
 * rollback target exists. No mutation.
 */
export const refreshHistoryController = async (req: Request, res: Response) => {
  if (!isIncrementalRefreshEnabled()) return featureOff(res);
  try {
    const username = requireUsername(req);
    const sessionId = req.params.sessionId;
    if (!sessionId) return res.status(400).json({ message: "Missing sessionId" });
    const chat = await getChatDocument(sessionId, username);
    if (!chat) return res.status(404).json({ message: "Session not found" });
    return res.json(buildRefreshHistoryView(chat));
  } catch (error) {
    return handleError(res, error, 400);
  }
};

/**
 * PUT /api/sessions/:sessionId/refresh/schedule
 * Body: { enabled, intervalHours? } — set/clear the Snowflake auto-refresh.
 */
export const setRefreshScheduleController = async (
  req: Request,
  res: Response
) => {
  if (!isIncrementalRefreshEnabled()) return featureOff(res);
  try {
    const username = requireUsername(req);
    const sessionId = req.params.sessionId;
    if (!sessionId) return res.status(400).json({ message: "Missing sessionId" });
    const enabled = req.body?.enabled === true;
    const intervalHours =
      typeof req.body?.intervalHours === "number" ? req.body.intervalHours : undefined;
    const result = await setRefreshSchedule(sessionId, username, {
      enabled,
      intervalHours,
    });
    if (!result.ok) return res.status(400).json({ message: result.error });
    return res.json({ ok: true });
  } catch (error) {
    return handleError(res, error, 400);
  }
};

/**
 * POST /api/cron/refresh
 * Vercel-cron entry. Secured by `CRON_SECRET` (Authorization: Bearer …). Runs
 * every due scheduled Snowflake refresh. Not user-scoped.
 */
export const cronRefreshController = async (req: Request, res: Response) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return res.status(503).json({ message: "Cron is not configured (CRON_SECRET unset)." });
  }
  const auth = req.headers.authorization;
  const provided = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
  if (provided !== secret) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  if (!isIncrementalRefreshEnabled()) {
    return res.json({ due: 0, refreshed: 0, failed: 0, skipped: "feature disabled" });
  }
  try {
    const result = await runDueScheduledRefreshes();
    return res.json(result);
  } catch (error) {
    return handleError(res, error, 500);
  }
};

/**
 * GET /api/sessions/:sessionId/refresh/compare
 * Diffs the prior dashboard charts against the current ones (per-chart totals +
 * % change). Returns { available:false } when there's no prior to compare.
 */
export const refreshCompareController = async (req: Request, res: Response) => {
  if (!isIncrementalRefreshEnabled()) return featureOff(res);
  try {
    const username = requireUsername(req);
    const sessionId = req.params.sessionId;
    if (!sessionId) return res.status(400).json({ message: "Missing sessionId" });
    const chat = await getChatDocument(sessionId, username);
    if (!chat) return res.status(404).json({ message: "Session not found" });

    const snapshot = chat.messageVersions?.[0];
    const priorCharts = snapshot?.priorDashboardCharts;
    let currentCharts = chat.charts;
    if (chat.lastCreatedDashboardId) {
      const dash = await getDashboardById(chat.lastCreatedDashboardId, username);
      if (dash?.charts?.length) currentCharts = dash.charts;
    }
    const currentLabel = chat.dataVersions?.find(
      (v) => v.versionId === `v${chat.currentDataBlob?.version}`
    )?.label;

    return res.json(
      buildRefreshCompare(priorCharts, currentCharts, {
        priorLabel: snapshot?.label,
        currentLabel,
      })
    );
  } catch (error) {
    return handleError(res, error, 400);
  }
};

/**
 * POST /api/sessions/:sessionId/refresh/rollback
 * Undo the last refresh — restore the prior data + answers + dashboard.
 */
export const refreshRollbackController = async (req: Request, res: Response) => {
  if (!isIncrementalRefreshEnabled()) return featureOff(res);
  try {
    const username = requireUsername(req);
    const sessionId = req.params.sessionId;
    if (!sessionId) return res.status(400).json({ message: "Missing sessionId" });
    const result = await rollbackLastRefresh(sessionId, username);
    if (result.busy) return res.status(409).json({ message: result.error });
    if (!result.ok) return res.status(400).json({ message: result.error });
    return res.json(result);
  } catch (error) {
    return handleError(res, error, 400);
  }
};

/**
 * POST /api/sessions/:sessionId/refresh/snowflake    (Snowflake re-query, SSE)
 * One-click "Fetch latest": re-queries the persisted `snowflakeSource` table
 * (a full re-query = Replace) and regenerates. No file, no column mapping.
 */
export const refreshSnowflakeController = async (req: Request, res: Response) => {
  if (!isIncrementalRefreshEnabled()) return featureOff(res);
  try {
    const pre = await refreshPreChecks(req, res);
    if (!pre) return;

    // Re-query before opening the stream so a Snowflake/config error is a clean 400.
    const chat = await getChatDocument(pre.sessionId, pre.username);
    if (!chat) return res.status(404).json({ message: "Session not found" });
    if (!chat.snowflakeSource) {
      return res.status(400).json({
        message:
          "This analysis isn't connected to Snowflake — upload a file to update it instead.",
      });
    }
    const { rows } = await fetchSnowflakeRefreshRows(chat);

    const versionLabel =
      typeof req.body?.versionLabel === "string"
        ? req.body.versionLabel.trim().slice(0, 120)
        : undefined;

    await streamRefresh(req, res, {
      sessionId: pre.sessionId,
      username: pre.username,
      rows,
      policy: "replace", // a full table re-query supersedes the prior data
      versionLabel,
    });
  } catch (error) {
    if (!res.headersSent) return handleError(res, error, 400);
  }
};
