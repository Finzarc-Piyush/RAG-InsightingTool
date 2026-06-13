/**
 * Wave I3 · mirror the chat answer's per-chart insights onto the dashboard.
 *
 * The dashboard is assembled inside `answerQuestion` BEFORE `enrichCharts`
 * runs, so its charts are bare. Once the response's `charts` carry the enriched
 * `keyInsight` / `businessCommentary`, copy the SAME ones onto:
 *   (a) the in-memory draft (`response.dashboardDraft.sheets[].charts`) — so the
 *       persisted message and the offer-track "Build Dashboard" inherit them, and
 *   (b) the already-persisted auto-created dashboard (`response.createdDashboardId`).
 *
 * No new LLM calls. Best-effort / non-throwing so it is safe to call inside a
 * `Promise.allSettled(...)` (streaming path) or to `await` inline (non-streaming
 * path). On failure it `logger.warn`s with the caller-supplied label and returns.
 *
 * The two imports (`applyChartInsightsBySignature`, `patchDashboardChartInsights`)
 * are intentionally kept as dynamic `import()`s — same as the original inline
 * blocks this helper replaces.
 */
import type { ChartSpec } from "../shared/schema.js";
import { logger } from "./logger.js";

/** Minimal structural shape the helper reads off the response object. */
type ChartInsightResponse = {
  charts?: ChartSpec[];
  dashboardDraft?: { sheets?: Array<{ charts?: ChartSpec[] }> };
  createdDashboardId?: string;
};

/**
 * Apply the response's enriched per-chart insights to its dashboard draft and
 * any persisted auto-created dashboard. Best-effort; never throws.
 *
 * @param response  The answer/transformed response object (carries `charts`,
 *                   `dashboardDraft`, `createdDashboardId`).
 * @param username  Owner username — required to patch the persisted dashboard.
 * @param logLabel  Qualifier appended to the failure warn message so each call
 *                   site keeps its distinct log line (e.g. "(non-streaming) ").
 */
export async function applyEnrichedChartsToDashboard({
  response,
  username,
  logLabel = "",
}: {
  response: ChartInsightResponse;
  username?: string;
  logLabel?: string;
}): Promise<void> {
  try {
    const enrichedCharts = (response.charts ?? []) as ChartSpec[];
    if (enrichedCharts.length === 0) return;

    const { applyChartInsightsBySignature } = await import(
      "./applyChartInsightsBySignature.js"
    );
    const draft = response.dashboardDraft;
    if (draft?.sheets?.length) {
      for (const sheet of draft.sheets) {
        if (Array.isArray(sheet.charts) && sheet.charts.length > 0) {
          sheet.charts = applyChartInsightsBySignature(
            sheet.charts,
            enrichedCharts
          ).charts;
        }
      }
    }

    const createdId = response.createdDashboardId;
    if (createdId && username) {
      const { patchDashboardChartInsights } = await import(
        "./patchDashboardChartInsights.js"
      );
      const res = await patchDashboardChartInsights({
        dashboardId: createdId,
        username,
        charts: enrichedCharts,
      });
      if (!res.ok) {
        logger.warn(`I3 · dashboard chart-insight patch skipped: ${res.reason}`);
      }
    }
  } catch (insightPatchErr) {
    logger.warn(
      `⚠️ dashboard chart-insight patch ${logLabel}failed:`,
      insightPatchErr
    );
  }
}
