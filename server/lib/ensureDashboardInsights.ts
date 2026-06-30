/**
 * ensureDashboardInsights — on-demand, self-healing per-chart insights for a
 * PERSISTED dashboard.
 *
 * The in-turn "born-insighted" pass (`applyEnrichedChartsToDashboard` →
 * `patchDashboardChartInsights`) is best-effort, async, and single-shot: it
 * silently no-ops on a race, a wrong/late dashboard id, or a signature miss, so
 * a saved dashboard can end up with bare chart tiles ("No insight yet …") even
 * though the same charts carry insights in chat. This orchestrator repairs ANY
 * such dashboard on demand (e.g. when its page loads):
 *
 *   1. REUSE (free, exact "same as chat") — copy `keyInsight` / commentary from
 *      the linked chat session's charts onto matching dashboard charts by axis
 *      signature (no LLM).
 *   2. GENERATE THE GAPS (once) — any bare chart with no chat twin (sweep / gap-
 *      fill tiles) is routed through the shared idempotent `generateInsightForCharts`
 *      seam, grounded on the chart's OWN frozen `data` (dashboard charts persist
 *      their data; the enrichment row resolver returns embedded data as-is).
 *   3. PERSIST — through the existing mutex-serialised `patchDashboardChartInsights`,
 *      so insights land on both the flat `charts[]` and every `sheets[].charts[]`
 *      and survive reload.
 *
 * Idempotent: charts that already carry a usable insight are skipped, so a
 * re-run patches nothing. Best-effort: each phase is isolated; a failure leaves
 * whatever was already healed and never throws.
 *
 * Deps are injectable so the orchestrator is unit-testable without a live Cosmos
 * / LLM. Defaults bind the real model + seams via lazy import (mirrors
 * `patchDashboardChartInsights`).
 */
import type { ChartSpec, Dashboard, DataSummary } from "../shared/schema.js";
import type { ChartEnrichmentContext, InsightEnrichmentDeps } from "./generateInsightForCharts.js";
import { chartAxisSignature } from "./agents/runtime/chartFromTable.js";
import { logger } from "./logger.js";

/** Minimal chat-doc surface the orchestrator reads (charts carry keyInsight). */
type ChatLike = {
  charts?: ChartSpec[];
  messages?: Array<{ charts?: ChartSpec[] }>;
  dataSummary?: DataSummary;
  sessionAnalysisContext?: ChartEnrichmentContext["sessionAnalysisContext"];
};

export type EnsureDashboardInsightsDeps = {
  getDashboardById: (id: string, username: string) => Promise<Dashboard | null>;
  getChatBySessionIdForUser: (sessionId: string, requesterEmail: string) => Promise<ChatLike | null>;
  patchDashboardChartInsights: (params: {
    dashboardId: string;
    username: string;
    charts: ChartSpec[];
  }) => Promise<{ ok: boolean; reason?: string; patchedCount?: number }>;
  generateInsightForCharts: (charts: ChartSpec[], deps: InsightEnrichmentDeps) => Promise<ChartSpec[]>;
  /**
   * Recompose the tenant FMCG/Marico domain pack for orphan-tile generation, so
   * a page-load-healed tile gets the SAME domain framing as the chat path
   * (context parity). Tenant-level (zero-arg loader), safe to recompose here.
   * Optional + injectable: absent in older callers/tests → orphan generation
   * simply omits domain framing (prior behaviour).
   */
  loadDomainContext?: () => Promise<string | undefined>;
};

export type EnsureDashboardInsightsResult = {
  patchedCount: number;
  dashboard: Dashboard | null;
  reason?: string;
};

function hasText(s: unknown): s is string {
  return typeof s === "string" && s.trim().length > 0;
}

function hasUsableInsight(c: ChartSpec): boolean {
  return hasText(c.keyInsight) || hasText((c as { insight?: { default?: string } }).insight?.default);
}

/** Every chart on a dashboard (flat + per-sheet), de-duped by axis signature. */
function allDashboardCharts(dashboard: Dashboard): ChartSpec[] {
  const flat = Array.isArray(dashboard.charts) ? dashboard.charts : [];
  const sheeted = Array.isArray(dashboard.sheets)
    ? dashboard.sheets.flatMap((s) => (Array.isArray(s.charts) ? s.charts : []))
    : [];
  const bySig = new Map<string, ChartSpec>();
  for (const c of [...flat, ...sheeted]) {
    const sig = chartAxisSignature(c);
    if (!bySig.has(sig)) bySig.set(sig, c);
  }
  return [...bySig.values()];
}

async function realDeps(): Promise<EnsureDashboardInsightsDeps> {
  const [dashboardModel, chatModel, patchMod, genMod, domainMod] = await Promise.all([
    import("../models/dashboard.model.js"),
    import("../models/chat.model.js"),
    import("./patchDashboardChartInsights.js"),
    import("./generateInsightForCharts.js"),
    import("./domainContext/loadEnabledDomainContext.js"),
  ]);
  return {
    getDashboardById: dashboardModel.getDashboardById,
    getChatBySessionIdForUser: chatModel.getChatBySessionIdForUser,
    patchDashboardChartInsights: patchMod.patchDashboardChartInsights,
    generateInsightForCharts: genMod.generateInsightForCharts,
    loadDomainContext: async () => {
      try {
        const { text } = await domainMod.loadEnabledDomainContext();
        return text?.trim() ? text : undefined;
      } catch (err) {
        logger.warn("ensureDashboardInsights · domain context load failed:", err);
        return undefined;
      }
    },
  };
}

export async function ensureDashboardInsights(params: {
  dashboardId: string;
  username: string;
  deps?: EnsureDashboardInsightsDeps;
}): Promise<EnsureDashboardInsightsResult> {
  const deps = params.deps ?? (await realDeps());
  const { dashboardId, username } = params;

  const dashboard = await deps.getDashboardById(dashboardId, username);
  if (!dashboard) return { patchedCount: 0, dashboard: null, reason: "dashboard_not_found" };

  const bare = allDashboardCharts(dashboard).filter((c) => !hasUsableInsight(c));
  if (bare.length === 0) return { patchedCount: 0, dashboard, reason: "already_insighted" };

  // Pool of INSIGHTED charts to copy onto the dashboard by signature.
  const pool: ChartSpec[] = [];
  let chat: ChatLike | null = null;

  // ── 1) REUSE from the linked chat session (free, exact same as chat) ──────
  if (hasText(dashboard.sessionId)) {
    try {
      chat = await deps.getChatBySessionIdForUser(dashboard.sessionId, username);
      if (chat) {
        const chatCharts = [
          ...(chat.charts ?? []),
          ...((chat.messages ?? []).flatMap((m) => m.charts ?? [])),
        ];
        for (const c of chatCharts) if (hasUsableInsight(c)) pool.push(c);
      }
    } catch (err) {
      logger.warn("ensureDashboardInsights · chat reuse load failed:", err);
    }
  }

  // ── 2) GENERATE the gaps (charts with no insighted chat twin) ─────────────
  const reusableSigs = new Set(pool.map((c) => chartAxisSignature(c)));
  const orphans = bare.filter((c) => !reusableSigs.has(chartAxisSignature(c)));
  if (orphans.length > 0) {
    try {
      // Context parity with the chat path (chatResponse.service.ts:50). Without
      // the originating question + the FMCG/Marico domain pack the insight model
      // has nothing concrete to anchor a DO on and falls back to meta-advice
      // ("build a dashboard to track this"); feeding both makes a healed orphan
      // tile read like chat — a real managerial action. `dashboard.name` is the
      // question-derived title (best available question steer at page-load time).
      const domainContext = deps.loadDomainContext
        ? await deps.loadDomainContext()
        : undefined;
      const generated = await deps.generateInsightForCharts(orphans, {
        // Dashboard charts carry their own frozen `data`; the row resolver
        // returns embedded data as-is, so no session rows are needed.
        filteredRawData: [],
        dataSummary: chat?.dataSummary,
        context: {
          userQuestion: hasText(dashboard.name) ? dashboard.name : undefined,
          sessionAnalysisContext: chat?.sessionAnalysisContext,
          domainContext,
        },
        // Insight-only: never re-attach data onto the dashboard's frozen charts.
        attachData: false,
      });
      for (const c of generated) if (hasUsableInsight(c)) pool.push(c);
    } catch (err) {
      logger.warn("ensureDashboardInsights · orphan generation failed:", err);
    }
  }

  if (pool.length === 0) return { patchedCount: 0, dashboard, reason: "no_insights_available" };

  // ── 3) PERSIST by signature (mutex-serialised) ────────────────────────────
  const res = await deps.patchDashboardChartInsights({ dashboardId, username, charts: pool });
  const patchedCount = res.patchedCount ?? 0;
  if (!res.ok) logger.warn(`ensureDashboardInsights · patch skipped: ${res.reason}`);

  // Return the healed doc so the caller can swap it in without a second fetch.
  const healed = patchedCount > 0 ? await deps.getDashboardById(dashboardId, username) : dashboard;
  return { patchedCount, dashboard: healed, reason: res.ok ? undefined : res.reason };
}
