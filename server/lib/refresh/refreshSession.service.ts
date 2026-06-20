/**
 * Wave WR3 (incremental refresh) · in-place refresh orchestrator.
 *
 * One call = re-ingest new data into an EXISTING session and faithfully
 * regenerate every answer + dashboard against it. Sequencing matters:
 *
 *   1. Take the session turn lease — refresh mutates the dataset under the
 *      agent, so it must be EXCLUSIVE (reject if a live turn / another refresh
 *      is running).
 *   2. Snapshot the pre-refresh state in memory (data blob + summary + messages
 *      + charts) so a failure rolls the whole session back to April.
 *   3. Build the recipe from the chat AS IT STANDS (April schema + Q&A) — this
 *      MUST happen BEFORE ingest so `expectedSchema` and the plan-step column
 *      refs are April's, letting the column mapping map April→May correctly.
 *   4. Ingest the new data version (WR2 replace; WR7 adds append).
 *   5. Replay the recipe in OVERWRITE mode against the swapped data (WR1).
 *   6. On success mark `refreshState: complete`; on any failure roll back and
 *      mark `failed`. Always release the lease.
 *
 * Dashboard re-versioning (WR4) is invoked by the caller after a successful
 * replay (it needs the regenerated dashboard draft from the last turn).
 */

import type { ChatDocument } from "../../models/chat.model.js";
import {
  getChatDocument,
  mutateChatDocument,
  acquireTurnLease,
  releaseTurnLease,
} from "../../models/chat.model.js";
import { buildRecipeFromChat } from "../automations/buildRecipeFromChat.js";
import {
  replayRecipe,
  type RecipeSource,
  type ReplaySseEmit,
  type ReplayAutomationResult,
} from "../automations/replayLoop.service.js";
import { ingestReplaceFromRows, type RefreshPolicy } from "./ingestNewVersion.js";
import { ingestAppendFromRows } from "./unionAppend.js";
import { reversionDashboardForRefresh } from "./reversionDashboard.js";
import { discoverNewInsights } from "./discoverNewInsights.js";
import { logger } from "../logger.js";
import { errorMessage } from "../../utils/errorMessage.js";

export interface RefreshSessionArgs {
  sessionId: string;
  username: string;
  /** Already-parsed incoming rows (file parse / Snowflake fetch is the caller's job). */
  rows: Record<string, unknown>[];
  /** WR3 ships `replace`; `append` lands in WR7. */
  policy: RefreshPolicy;
  /** User-confirmed column mapping from the preflight (April → new names). */
  columnMapping?: Record<string, string>;
  /** Append-mode business key (overrides the inferred key). */
  appendKey?: string[];
  /** WR11 · also run a fresh-planner discovery pass after the faithful replay. */
  discover?: boolean;
  /** Human label for the new data version (e.g. "as of May 2026"). */
  versionLabel?: string;
  emit: ReplaySseEmit;
  abortSignal?: AbortSignal;
}

export interface RefreshSessionResult extends ReplayAutomationResult {
  fromDataVersion?: number;
  toDataVersion?: number;
  /** True when a second turn/refresh already held the lease (controller → 409). */
  busy?: boolean;
  /** The dashboard updated in place (WR4), when the analysis had/created one. */
  dashboardId?: string;
  /** WR11 · number of net-new discovery turns appended. */
  discovered?: number;
}

/** The session fields a refresh mutates — snapshotted for rollback. */
type PriorState = Pick<
  ChatDocument,
  | "currentDataBlob"
  | "dataSummary"
  | "sampleRows"
  | "columnStatistics"
  | "rawData"
  | "messages"
  | "charts"
  | "chartReferences"
>;

export async function refreshSession(
  args: RefreshSessionArgs
): Promise<RefreshSessionResult> {
  const { sessionId, username, rows, emit, abortSignal } = args;
  const turnId = `refresh_${sessionId}_${Date.now()}`;

  const chat = await getChatDocument(sessionId, username);
  if (!chat) {
    return { ok: false, questionsReplayed: 0, dashboardsCreated: 0, error: "Session not found" };
  }

  // Exclusivity — a refresh must not run while a live turn or another refresh
  // is in flight (it swaps the dataset out from under them).
  const lease = await acquireTurnLease(sessionId, turnId);
  if (lease === false) {
    return {
      ok: false,
      busy: true,
      questionsReplayed: 0,
      dashboardsCreated: 0,
      error:
        "A question or another refresh is already running on this analysis. Finish or stop it first.",
    };
  }

  const prior: PriorState = {
    currentDataBlob: chat.currentDataBlob,
    dataSummary: chat.dataSummary,
    sampleRows: chat.sampleRows,
    columnStatistics: chat.columnStatistics,
    rawData: chat.rawData,
    messages: chat.messages,
    charts: chat.charts,
    chartReferences: chat.chartReferences,
  };
  const fromVersion = chat.currentDataBlob?.version ?? 0;

  try {
    // 1. Capture the recipe from the CURRENT (pre-ingest) chat so expectedSchema
    //    + plan-step column refs are April's.
    const { draft } = buildRecipeFromChat(
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
    if (draft.recipe.length === 0) {
      await releaseTurnLease(sessionId, turnId);
      return {
        ok: false,
        questionsReplayed: 0,
        dashboardsCreated: 0,
        error:
          "This analysis has no answered questions to regenerate yet. Ask at least one question first.",
      };
    }
    const source: RecipeSource = {
      recipe: draft.recipe,
      expectedSchema: draft.expectedSchema,
      sessionTransformations: draft.sessionTransformations,
      name: draft.name,
      sourceId: turnId,
    };

    await setRefreshState(sessionId, {
      status: "running",
      policy: args.policy,
      startedAt: Date.now(),
      fromDataVersion: fromVersion,
    });

    // 2. Ingest the new data version (swaps currentDataBlob). Replace = the new
    //    rows become the dataset; Append = union onto the existing rows and run
    //    on the FULL combined dataset.
    emit({
      type: "automation_progress",
      phase: "preparing_dataset",
      step: 1,
      total: 1,
      detail:
        args.policy === "append"
          ? "Combining with your existing data…"
          : "Loading the new data…",
    });
    const ingest =
      args.policy === "append"
        ? await ingestAppendFromRows(chat, rows, {
            versionLabel: args.versionLabel,
            keyColumns: args.appendKey,
          })
        : await ingestReplaceFromRows(chat, rows, {
            versionLabel: args.versionLabel,
          });

    // 3. Replay the recipe in overwrite mode against the swapped data.
    const result = await replayRecipe({
      sessionId,
      source,
      username,
      columnMapping: args.columnMapping,
      mode: "overwrite",
      emit,
      abortSignal,
    });

    if (!result.ok) {
      await rollbackRefresh(sessionId, prior, result.error ?? "Refresh failed");
      return { ...result, fromDataVersion: fromVersion, toDataVersion: ingest.toVersion };
    }

    // WR10 · enrich the newest message snapshot (written by the overwrite
    // truncation) with the PRE-refresh data-side state, so a later user-initiated
    // rollback restores data + messages + dashboard together. Best-effort.
    await patchRollbackData(sessionId, prior);

    // Re-version the dashboard from the regenerated draft (best-effort — the
    // answers are already persisted; a dashboard-mirror failure never fails
    // the refresh).
    const reversion = await reversionDashboardForRefresh({
      sessionId,
      username,
      policy: args.policy,
      fromDataVersion: fromVersion,
      toDataVersion: ingest.toVersion,
      versionLabel: args.versionLabel,
    });

    // WR11 · optional fresh-planner discovery pass on the combined data. Runs
    // inside the same exclusive lease; never fails the refresh.
    let discovered = 0;
    if (args.discover) {
      const fresh = await getChatDocument(sessionId, username);
      if (fresh) {
        const d = await discoverNewInsights({
          sessionId,
          username,
          chat: fresh,
          emit,
          abortSignal,
        });
        discovered = d.discovered;
      }
    }

    await setRefreshState(sessionId, {
      status: "complete",
      policy: args.policy,
      lastRefreshedAt: Date.now(),
      fromDataVersion: fromVersion,
      toDataVersion: ingest.toVersion,
    });
    return {
      ...result,
      fromDataVersion: fromVersion,
      toDataVersion: ingest.toVersion,
      dashboardId: reversion.dashboardId,
      discovered,
    };
  } catch (err) {
    const error = errorMessage(err);
    logger.error(`[refresh] failed for ${sessionId}:`, err);
    await rollbackRefresh(sessionId, prior, error).catch(() => {});
    emit({ type: "automation_halted", ordinal: 0, error });
    return { ok: false, questionsReplayed: 0, dashboardsCreated: 0, error };
  } finally {
    await releaseTurnLease(sessionId, turnId);
  }
}

/**
 * WR10 · stamp the pre-refresh data-side state onto the newest `messageVersions`
 * entry (the overwrite truncation already captured the prior messages+charts
 * there). Makes that entry a COMPLETE rollback snapshot.
 */
async function patchRollbackData(
  sessionId: string,
  prior: PriorState
): Promise<void> {
  try {
    await mutateChatDocument(sessionId, (doc) => {
      const entry = doc.messageVersions?.[0];
      if (!entry) return false; // nothing to enrich
      entry.priorDataBlob = prior.currentDataBlob;
      entry.priorDataSummary = prior.dataSummary;
      entry.priorSampleRows = prior.sampleRows;
      entry.priorColumnStatistics = prior.columnStatistics;
    });
  } catch (err) {
    logger.warn(`[refresh] patchRollbackData failed (${sessionId}):`, err);
  }
}

/** Patch `refreshState` through the lock + ETag seam. */
async function setRefreshState(
  sessionId: string,
  state: NonNullable<ChatDocument["refreshState"]>
): Promise<void> {
  try {
    await mutateChatDocument(sessionId, (doc) => {
      doc.refreshState = state;
    });
  } catch (err) {
    logger.warn(`[refresh] setRefreshState failed (${sessionId}):`, err);
  }
}

/**
 * Restore the session to its pre-refresh state (data blob + summary + messages
 * + charts) so a failed refresh leaves April fully intact. Best-effort — logs
 * but never throws (the caller has already emitted the halt).
 */
async function rollbackRefresh(
  sessionId: string,
  prior: PriorState,
  error: string
): Promise<void> {
  try {
    await mutateChatDocument(sessionId, (doc) => {
      doc.currentDataBlob = prior.currentDataBlob;
      doc.dataSummary = prior.dataSummary;
      doc.sampleRows = prior.sampleRows;
      doc.columnStatistics = prior.columnStatistics;
      doc.rawData = prior.rawData;
      doc.messages = prior.messages;
      doc.charts = prior.charts;
      doc.chartReferences = prior.chartReferences;
      doc.refreshState = {
        status: "failed",
        lastRefreshedAt: Date.now(),
        error: error.slice(0, 500),
      };
    });
    logger.log(`[refresh] rolled back ${sessionId} to pre-refresh state`);
  } catch (err) {
    logger.warn(`[refresh] rollback failed (${sessionId}):`, err);
  }
}
