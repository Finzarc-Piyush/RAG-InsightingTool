/**
 * Wave I3 / A3 · make auto-created dashboards born-insighted.
 *
 * The dashboard is assembled inside `answerQuestion` BEFORE `enrichCharts`
 * runs, so its charts are bare. This helper runs AFTER chart enrichment and:
 *
 *   1. REUSE — copies the chat answer's per-chart `keyInsight` /
 *      `businessCommentary` onto the dashboard charts by axis signature (no LLM;
 *      same chart → same insight as chat, so the two surfaces never disagree).
 *   2. GENERATE THE GAPS — any dashboard chart STILL bare after the copy is a
 *      sweep / gap-fill tile with no chat twin. Those are routed through the
 *      shared `generateInsightForCharts` seam so NO dashboard chart ever ships
 *      without an insight. (Reuse-first keeps the added LLM calls to the true
 *      orphans only.)
 *
 * It patches BOTH:
 *   (a) the in-memory draft (`response.dashboardDraft.sheets[].charts`) — so the
 *       persisted message and the offer-track "Build Dashboard" inherit them, and
 *   (b) the already-persisted auto-created dashboard (`response.createdDashboardId`).
 *
 * Best-effort / non-throwing so it is safe to call inside a
 * `Promise.allSettled(...)` (streaming path) or to `await` inline (non-streaming
 * path). On failure it `logger.warn`s with the caller-supplied label and returns
 * — a failed/late pass just leaves the dashboard with the chat-copied insights
 * (or bare), never breaks the turn.
 *
 * Generation is opt-in via the `generation` bundle: callers that can supply rows
 * (`resolveRows`, called lazily ONLY when orphans exist) get gap-filling; callers
 * that omit it keep the original copy-only behavior.
 */
import type { ChartSpec, DataSummary } from "../shared/schema.js";
import type { ChartEnrichmentContext } from "./generateInsightForCharts.js";
import { applyChartInsightsBySignature } from "./applyChartInsightsBySignature.js";
import { chartAxisSignature } from "./agents/runtime/chartFromTable.js";
import { logger } from "./logger.js";

/** Minimal structural shape the helper reads off the response object. */
type ChartInsightResponse = {
  charts?: ChartSpec[];
  dashboardDraft?: { sheets?: Array<{ charts?: ChartSpec[] }> };
  createdDashboardId?: string;
};

/** Inputs needed to GENERATE insights for orphan dashboard charts. */
export type DashboardInsightGeneration = {
  /**
   * Lazily resolve the rows to ground orphan insights on (the active-filtered
   * slice). Called at most ONCE, and only when there is ≥1 orphan — so the
   * common "every dashboard chart has a chat twin" case pays nothing.
   */
  resolveRows: () => Record<string, unknown>[] | Promise<Record<string, unknown>[]>;
  dataSummary?: DataSummary;
  context?: ChartEnrichmentContext;
};

function hasText(s: unknown): s is string {
  return typeof s === "string" && s.trim().length > 0;
}

/**
 * Apply the response's enriched per-chart insights to its dashboard draft and
 * any persisted auto-created dashboard, generating insights for orphan charts.
 * Best-effort; never throws.
 *
 * @param response   The answer/transformed response object (carries `charts`,
 *                   `dashboardDraft`, `createdDashboardId`).
 * @param username   Owner username — required to patch the persisted dashboard.
 * @param logLabel   Qualifier appended to the failure warn message so each call
 *                   site keeps its distinct log line (e.g. "(non-streaming) ").
 * @param generation When set, dashboard charts left bare after the by-signature
 *                   copy are routed through `generateInsightForCharts`.
 */
export async function applyEnrichedChartsToDashboard({
  response,
  username,
  logLabel = "",
  generation,
}: {
  response: ChartInsightResponse;
  username?: string;
  logLabel?: string;
  generation?: DashboardInsightGeneration;
}): Promise<void> {
  try {
    const enrichedCharts = (response.charts ?? []) as ChartSpec[];

    // ── Reuse-first, then generate the gaps ──────────────────────────────
    // `pool` is the set of charts (with insights) we copy onto the dashboard.
    // It starts as the chat answer's enriched charts and gains generated
    // insights for any orphan dashboard chart with no chat twin.
    let pool = enrichedCharts;
    if (generation) {
      const generated = await generateOrphanInsights(
        response.dashboardDraft,
        enrichedCharts,
        generation,
      );
      if (generated.length > 0) pool = [...enrichedCharts, ...generated];
    }

    if (pool.length === 0) return;

    // (a) in-memory draft sheets
    const draft = response.dashboardDraft;
    if (draft?.sheets?.length) {
      for (const sheet of draft.sheets) {
        if (Array.isArray(sheet.charts) && sheet.charts.length > 0) {
          sheet.charts = applyChartInsightsBySignature(sheet.charts, pool).charts;
        }
      }
    }

    // (b) the already-persisted auto-created dashboard
    const createdId = response.createdDashboardId;
    if (createdId && username) {
      const { patchDashboardChartInsights } = await import(
        "./patchDashboardChartInsights.js"
      );
      const res = await patchDashboardChartInsights({
        dashboardId: createdId,
        username,
        charts: pool,
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

/**
 * Identify dashboard charts that stay bare after the by-signature copy (sweep /
 * gap-fill tiles with no chat twin), de-dup them by axis signature (a chart can
 * appear on more than one sheet), and generate an insight for each via the
 * shared idempotent seam. Returns the freshly-insighted charts to fold into the
 * copy `pool`. Never throws — on any failure it returns [].
 */
async function generateOrphanInsights(
  dashboardDraft: ChartInsightResponse["dashboardDraft"],
  enrichedCharts: ChartSpec[],
  generation: DashboardInsightGeneration,
): Promise<ChartSpec[]> {
  try {
    const draftCharts = (dashboardDraft?.sheets ?? []).flatMap((s) => s.charts ?? []);
    if (draftCharts.length === 0) return [];

    // Reuse chat insights first, then find what is still bare.
    const afterCopy = applyChartInsightsBySignature(draftCharts, enrichedCharts).charts;
    const orphansBySig = new Map<string, ChartSpec>();
    for (const c of afterCopy) {
      if (!hasText(c.keyInsight) && !hasText((c as { insight?: { default?: string } }).insight?.default)) {
        const sig = chartAxisSignature(c);
        if (!orphansBySig.has(sig)) orphansBySig.set(sig, c);
      }
    }
    const orphans = [...orphansBySig.values()];
    if (orphans.length === 0) return [];

    const filteredRawData = await generation.resolveRows();
    const { generateInsightForCharts } = await import("./generateInsightForCharts.js");
    const generated = await generateInsightForCharts(orphans, {
      filteredRawData,
      dataSummary: generation.dataSummary,
      context: generation.context,
      // Insight-only: dashboard charts keep their own (frozen) data.
      attachData: false,
    });
    return (generated as ChartSpec[]).filter((c) => hasText(c?.keyInsight));
  } catch (err) {
    logger.warn("A3 · orphan dashboard-insight generation failed:", err);
    return [];
  }
}
