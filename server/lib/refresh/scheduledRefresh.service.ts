/**
 * Wave WR13 (incremental refresh) · scheduled Snowflake auto-refresh.
 *
 * A Vercel-cron-driven job (`POST /api/cron/refresh`) calls
 * `runDueScheduledRefreshes`: it scans for Snowflake-sourced sessions whose
 * schedule is due, re-queries each table, and regenerates — the same
 * `refreshSession` path the manual "Fetch latest" uses, just with a no-op SSE
 * emitter. Each run advances `nextRunAt` by the interval (even on failure, so a
 * broken session doesn't get hammered every minute).
 */

import {
  getChatDocument,
  mutateChatDocument,
  findDueScheduledRefreshes,
} from "../../models/chat.model.js";
import { fetchSnowflakeRefreshRows } from "./ingestNewVersion.js";
import { refreshSession } from "./refreshSession.service.js";
import { logger } from "../logger.js";
import { errorMessage } from "../../utils/errorMessage.js";

const HOUR_MS = 3_600_000;
const MIN_INTERVAL_HOURS = 1;
const MAX_INTERVAL_HOURS = 24 * 30; // a month
const noopEmit = () => {};

export interface ScheduledRunResult {
  due: number;
  refreshed: number;
  failed: number;
}

/** Compute the next run time from now + interval. */
const nextRun = (nowMs: number, intervalHours: number): number =>
  nowMs + Math.max(MIN_INTERVAL_HOURS, intervalHours) * HOUR_MS;

/** Advance a session's schedule after a run (records the outcome). */
async function advanceSchedule(
  sessionId: string,
  nowMs: number,
  error?: string
): Promise<void> {
  try {
    await mutateChatDocument(sessionId, (doc) => {
      if (!doc.refreshSchedule) return false;
      doc.refreshSchedule.lastRunAt = nowMs;
      doc.refreshSchedule.lastError = error;
      doc.refreshSchedule.nextRunAt = nextRun(nowMs, doc.refreshSchedule.intervalHours);
    });
  } catch (err) {
    logger.warn(`[refresh] advanceSchedule failed (${sessionId}):`, err);
  }
}

/**
 * Set/clear a session's auto-refresh schedule. `intervalHours <= 0` or
 * `enabled:false` disables it.
 */
export async function setRefreshSchedule(
  sessionId: string,
  username: string,
  input: { enabled: boolean; intervalHours?: number }
): Promise<{ ok: boolean; error?: string }> {
  const chat = await getChatDocument(sessionId, username);
  if (!chat) return { ok: false, error: "Session not found" };
  if (input.enabled && !chat.snowflakeSource) {
    return {
      ok: false,
      error: "Auto-refresh is only available for Snowflake-connected analyses.",
    };
  }
  const interval = Math.min(
    MAX_INTERVAL_HOURS,
    Math.max(MIN_INTERVAL_HOURS, Math.round(input.intervalHours ?? 24))
  );
  const now = Date.now();
  await mutateChatDocument(sessionId, (doc) => {
    doc.refreshSchedule = {
      enabled: input.enabled,
      intervalHours: interval,
      nextRunAt: input.enabled ? nextRun(now, interval) : undefined,
      lastRunAt: doc.refreshSchedule?.lastRunAt,
    };
  });
  return { ok: true };
}

/** Run every due scheduled refresh. Called by the cron endpoint. */
export async function runDueScheduledRefreshes(
  nowMs: number = Date.now(),
  limit: number = 25
): Promise<ScheduledRunResult> {
  const due = await findDueScheduledRefreshes(nowMs, limit);
  let refreshed = 0;
  let failed = 0;

  for (const { sessionId, username } of due) {
    try {
      const chat = await getChatDocument(sessionId, username);
      if (!chat?.snowflakeSource) {
        await advanceSchedule(sessionId, nowMs, "No Snowflake source on session.");
        failed += 1;
        continue;
      }
      const { rows } = await fetchSnowflakeRefreshRows(chat);
      const result = await refreshSession({
        sessionId,
        username,
        rows,
        policy: "replace",
        versionLabel: `auto-refresh ${new Date(nowMs).toISOString().slice(0, 10)}`,
        emit: noopEmit,
      });
      if (result.ok) {
        refreshed += 1;
        await advanceSchedule(sessionId, nowMs, undefined);
      } else {
        failed += 1;
        // `busy` (a user turn was running) or a real error — retry next interval.
        await advanceSchedule(sessionId, nowMs, result.error);
      }
    } catch (err) {
      failed += 1;
      await advanceSchedule(sessionId, nowMs, errorMessage(err));
    }
  }

  logger.log(
    `[refresh] scheduled run: ${due.length} due, ${refreshed} refreshed, ${failed} failed`
  );
  return { due: due.length, refreshed, failed };
}
