/**
 * Wave WR4 (incremental refresh) · dashboard re-versioning.
 *
 * After an overwrite replay regenerates the analysis on the new data, the last
 * replayed turn's `dashboardDraft` carries the rebound dashboard spec (charts
 * refilled with the new numbers). Because a refresh runs entirely server-side
 * (no client round-trip to `/dashboards/from-spec`), the refresh service must
 * persist the dashboard itself.
 *
 * Strategy: UPDATE THE EXISTING dashboard IN PLACE (same id) — overwrite its
 * sheets/charts/envelope from the regenerated spec and stamp `dataRefreshSource`
 * with the new "as of …" label. Same id means the user stays on the same
 * dashboard URL and a refetch shows it updated to the new data. The DATA history
 * (prior version blobs + the chat's prior messages) is retained on the chat
 * side for rollback, so the refresh is reversible without a duplicate board.
 * When the analysis has no dashboard yet, one is created.
 *
 * Best-effort: a failure here never fails the refresh — the regenerated answers
 * are already persisted; only the dashboard mirror is affected.
 */

import {
  createDashboardFromSpec,
  getDashboardById,
  getDashboardsBySessionId,
  updateDashboard,
} from "../../models/dashboard.model.js";
import { mutateChatDocument, getChatDocument } from "../../models/chat.model.js";
import {
  dashboardSpecSchema,
  type ChartSpec,
  type Dashboard,
  type DashboardSheet,
  type DashboardSpec,
} from "../../shared/schema.js";
import type { Message } from "../../shared/schema.js";
import { logger } from "../logger.js";

export interface ReversionArgs {
  sessionId: string;
  username: string;
  policy: "replace" | "append";
  fromDataVersion?: number;
  toDataVersion?: number;
  versionLabel?: string;
}

export interface ReversionResult {
  /** The dashboard that now reflects the new data (updated in place or created). */
  dashboardId?: string;
  /** No dashboard existed in the analysis — nothing to re-version. */
  skipped?: boolean;
}

/**
 * Pull the regenerated dashboard spec off the last assistant message that
 * carries one. Validates the loose `dashboardDraft` record against
 * `dashboardSpecSchema` (the draft is a DashboardSpec produced by
 * `buildDashboardFromTurn`). Returns undefined when the analysis built no
 * dashboard or the draft no longer validates.
 */
export const extractRegeneratedDashboardSpec = (
  messages: Message[]
): DashboardSpec | undefined => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "assistant" || !m.dashboardDraft) continue;
    const parsed = dashboardSpecSchema.safeParse(m.dashboardDraft);
    if (parsed.success) return parsed.data;
  }
  return undefined;
};

/** Map a regenerated DashboardSpec's sheets/charts onto an existing Dashboard
 *  doc IN PLACE (mirrors the sheet materialisation in `createDashboardFromSpec`,
 *  so an updated board looks identical to a freshly-created one). */
function applySpecToDashboard(dashboard: Dashboard, spec: DashboardSpec): void {
  const sheets: DashboardSheet[] = spec.sheets.map((s, idx) => ({
    id: s.id || `sheet_${idx}`,
    name: s.name,
    charts: s.charts ? [...s.charts] : [],
    ...(s.pivots && s.pivots.length > 0 ? { pivots: [...s.pivots] } : {}),
    ...(s.tables && s.tables.length > 0 ? { tables: [...s.tables] } : {}),
    ...(s.narrativeBlocks && s.narrativeBlocks.length > 0
      ? { narrativeBlocks: [...s.narrativeBlocks] }
      : {}),
    ...(s.gridLayout ? { gridLayout: s.gridLayout } : {}),
    order: typeof s.order === "number" ? s.order : idx,
  }));
  const unionCharts: ChartSpec[] = [];
  for (const s of sheets) if (Array.isArray(s.charts)) unionCharts.push(...s.charts);

  dashboard.sheets = sheets;
  dashboard.charts = unionCharts;
  if (spec.answerEnvelope) dashboard.answerEnvelope = spec.answerEnvelope;
  if (spec.businessActions?.length) dashboard.businessActions = spec.businessActions;
  if (spec.followUpPrompts?.length) dashboard.followUpPrompts = spec.followUpPrompts;
  if (spec.investigationSummary) dashboard.investigationSummary = spec.investigationSummary;
  if (spec.attentionAreas?.length) dashboard.attentionAreas = spec.attentionAreas;
}

/**
 * Re-version the session's dashboard from the regenerated spec. Call AFTER a
 * successful overwrite replay. Updates the existing board in place (same id),
 * or creates one when the analysis has none yet.
 */
export async function reversionDashboardForRefresh(
  args: ReversionArgs
): Promise<ReversionResult> {
  const { sessionId, username } = args;
  try {
    const chat = await getChatDocument(sessionId, username);
    if (!chat) return { skipped: true };

    const spec = extractRegeneratedDashboardSpec((chat.messages ?? []) as Message[]);
    if (!spec) return { skipped: true };

    const refreshMeta = {
      policy: args.policy,
      fromDataVersion: args.fromDataVersion,
      toDataVersion: args.toDataVersion,
      versionLabel: args.versionLabel,
      refreshedAt: Date.now(),
    };

    // Resolve the existing dashboard: the session's last-created pointer first,
    // else the newest dashboard backlinked to this session.
    let targetId = chat.lastCreatedDashboardId;
    if (!targetId) {
      const bySession = await getDashboardsBySessionId(sessionId, username);
      targetId = bySession[0]?.id;
    }

    if (targetId) {
      const existing = await getDashboardById(targetId, username);
      if (existing) {
        // WR12 · snapshot the PRIOR charts (with data) onto the newest message
        // version so the April-vs-May compare can diff them. Best-effort.
        const priorCharts = [...(existing.charts ?? [])];
        applySpecToDashboard(existing, spec);
        existing.dataRefreshSource = refreshMeta;
        existing.updatedAt = Date.now();
        await updateDashboard(existing);
        if (priorCharts.length > 0) {
          await mutateChatDocument(sessionId, (doc) => {
            const entry = doc.messageVersions?.[0];
            if (!entry) return false;
            entry.priorDashboardCharts = priorCharts;
          });
        }
        logger.log(`[refresh] updated dashboard ${existing.id} in place (${sessionId})`);
        return { dashboardId: existing.id };
      }
    }

    // No existing dashboard — create the first one for this analysis.
    const created = await createDashboardFromSpec(username, spec, sessionId);
    created.dataRefreshSource = refreshMeta;
    await updateDashboard(created);
    await mutateChatDocument(sessionId, (doc) => {
      doc.lastCreatedDashboardId = created.id;
    });
    logger.log(`[refresh] created dashboard ${created.id} (${sessionId})`);
    return { dashboardId: created.id };
  } catch (err) {
    logger.warn(`[refresh] dashboard re-version failed (${sessionId}):`, err);
    return {};
  }
}
