/**
 * Wave WR10 (incremental refresh) · user-initiated rollback ("undo the last
 * refresh").
 *
 * The newest `messageVersions` entry is a COMPLETE snapshot of the session as it
 * was BEFORE the last refresh: the prior messages + charts (captured by the
 * overwrite truncation, WR1) AND the prior data-side state (patched on by
 * `refreshSession`, WR10). Rollback restores all of it together — data + answers
 * + dashboard — so the session is coherent, then pops the snapshot. The new data
 * version's blob is left in storage (a re-refresh can re-create it); we simply
 * point `currentDataBlob` back.
 */

import type { ChatDocument } from "../../models/chat.model.js";
import {
  getChatDocument,
  mutateChatDocument,
  acquireTurnLease,
  releaseTurnLease,
} from "../../models/chat.model.js";
import { reversionDashboardForRefresh } from "./reversionDashboard.js";
import { scheduleIndexSessionRag } from "../rag/indexSession.js";
import { logger } from "../logger.js";
import { errorMessage } from "../../utils/errorMessage.js";

export interface RollbackResult {
  ok: boolean;
  busy?: boolean;
  error?: string;
  restoredToVersion?: number;
  restoredLabel?: string;
  dashboardId?: string;
}

/** Read-only view of what a rollback would restore to (for the badge/menu). */
export interface RefreshHistoryView {
  canRollback: boolean;
  currentVersion?: number;
  currentLabel?: string;
  priorVersion?: number;
  priorLabel?: string;
  /** Whether this analysis is Snowflake-connected (gates the SF menu items). */
  hasSnowflakeSource: boolean;
  /** Whether an auto-refresh schedule is currently enabled. */
  scheduleEnabled: boolean;
}

/** Derive the version/label info the "Data: as of …" badge renders. */
export function buildRefreshHistoryView(chat: ChatDocument): RefreshHistoryView {
  const currentVersion = chat.currentDataBlob?.version;
  const currentLabel = chat.dataVersions?.find(
    (v) => v.versionId === `v${currentVersion}`
  )?.label;
  const snapshot = chat.messageVersions?.[0];
  const priorVersion = snapshot?.priorDataBlob?.version;
  return {
    canRollback: Boolean(snapshot),
    currentVersion,
    currentLabel,
    priorVersion,
    priorLabel: snapshot?.label,
    hasSnowflakeSource: Boolean(chat.snowflakeSource),
    scheduleEnabled: chat.refreshSchedule?.enabled === true,
  };
}

export async function rollbackLastRefresh(
  sessionId: string,
  username: string
): Promise<RollbackResult> {
  const chat = await getChatDocument(sessionId, username);
  if (!chat) return { ok: false, error: "Session not found" };

  const snapshot = chat.messageVersions?.[0];
  if (!snapshot) {
    return { ok: false, error: "There's no prior version to roll back to." };
  }

  const turnId = `rollback_${sessionId}_${Date.now()}`;
  const lease = await acquireTurnLease(sessionId, turnId);
  if (lease === false) {
    return {
      ok: false,
      busy: true,
      error:
        "A question or refresh is already running on this analysis. Finish or stop it first.",
    };
  }

  try {
    await mutateChatDocument(sessionId, (doc) => {
      const snap = doc.messageVersions?.[0];
      if (!snap) return false;
      // Restore the conversation + charts.
      doc.messages = snap.messages;
      doc.charts = snap.charts ?? [];
      doc.chartReferences = snap.chartReferences ?? [];
      // Restore the data-side state (when the snapshot carries it — pre-WR10
      // snapshots roll back messages only).
      if (snap.priorDataBlob) doc.currentDataBlob = snap.priorDataBlob;
      if (snap.priorDataSummary) doc.dataSummary = snap.priorDataSummary;
      if (snap.priorSampleRows) doc.sampleRows = snap.priorSampleRows;
      if (snap.priorColumnStatistics)
        doc.columnStatistics = snap.priorColumnStatistics;
      // Force `loadLatestData` to read the restored blob (don't trust a stale
      // inline rawData from the rolled-forward version).
      doc.rawData = [];
      // Pop the restored snapshot — a second rollback would target the one before.
      doc.messageVersions = (doc.messageVersions ?? []).slice(1);
      doc.refreshState = { status: "complete", lastRefreshedAt: Date.now() };
    });

    // Re-index RAG against the restored data version + re-version the dashboard
    // in place from the restored conversation's draft.
    scheduleIndexSessionRag(sessionId);
    const reversion = await reversionDashboardForRefresh({
      sessionId,
      username,
      policy: "replace",
      toDataVersion: snapshot.priorDataBlob?.version,
      versionLabel: snapshot.label,
    });

    logger.log(
      `[refresh] rolled back ${sessionId} to v${snapshot.priorDataBlob?.version ?? "?"}`
    );
    return {
      ok: true,
      restoredToVersion: snapshot.priorDataBlob?.version,
      restoredLabel: snapshot.label,
      dashboardId: reversion.dashboardId,
    };
  } catch (err) {
    const error = errorMessage(err);
    logger.error(`[refresh] rollback failed for ${sessionId}:`, err);
    return { ok: false, error };
  } finally {
    await releaseTurnLease(sessionId, turnId);
  }
}
