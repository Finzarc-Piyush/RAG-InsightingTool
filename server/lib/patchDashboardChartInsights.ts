/**
 * Patch a persisted dashboard's per-chart insights from the chat answer's
 * already-enriched charts. Mirrors `patchDashboardBusinessActions` (DPF2): the
 * auto-create dashboard fires synchronously inside `runAgentTurn` BEFORE chart
 * enrichment (`enrichCharts` in chatResponse.service.ts) runs, so the persisted
 * dashboard captures the BARE charts. After enrichment lands we copy the SAME
 * `keyInsight` / `businessCommentary` the chat answer shows onto the dashboard's
 * charts (flat `charts` array + every `sheets[].charts[]`), matched by axis
 * signature. No new LLM calls — this is the "same chart + same insight as chat"
 * path the user asked for.
 *
 * Per-dashboard in-process mutex serialises the read-modify-write (single-
 * instance correctness only — parity with the businessActions patcher).
 * Failure isolation: a failed/late patch just leaves the dashboard without
 * per-chart insights; the chat answer is unaffected.
 */

import type { ChartSpec, Dashboard } from "../shared/schema.js";
import { applyChartInsightsBySignature } from "./applyChartInsightsBySignature.js";
import { serializePerDashboard } from "./dashboardPatchMutex.js";

/** Minimal model surface — injectable so the patcher is unit-testable
 *  without a live Cosmos container. Defaults to the real dashboard.model. */
export type DashboardInsightPatchDeps = {
  getDashboardById: (id: string, username: string) => Promise<Dashboard | null>;
  updateDashboard: (dashboard: Dashboard) => Promise<Dashboard>;
};

export async function patchDashboardChartInsights(params: {
  dashboardId: string;
  username: string;
  charts: ChartSpec[];
  deps?: DashboardInsightPatchDeps;
}): Promise<{ ok: boolean; reason?: string; patchedCount?: number }> {
  if (!params.charts?.length) return { ok: true, reason: "empty" };

  return serializePerDashboard(`chartInsights:${params.dashboardId}`, () =>
    doPatch(params)
  );
}

async function doPatch(params: {
  dashboardId: string;
  username: string;
  charts: ChartSpec[];
  deps?: DashboardInsightPatchDeps;
}): Promise<{ ok: boolean; reason?: string; patchedCount?: number }> {
  const { getDashboardById, updateDashboard } =
    params.deps ?? (await import("../models/dashboard.model.js"));
  const dashboard = await getDashboardById(params.dashboardId, params.username);
  if (!dashboard) return { ok: false, reason: "dashboard_not_found" };

  let patchedCount = 0;

  if (Array.isArray(dashboard.charts) && dashboard.charts.length > 0) {
    const res = applyChartInsightsBySignature(dashboard.charts, params.charts);
    dashboard.charts = res.charts;
    patchedCount += res.patchedCount;
  }

  if (Array.isArray(dashboard.sheets)) {
    for (const sheet of dashboard.sheets) {
      if (!Array.isArray(sheet.charts) || sheet.charts.length === 0) continue;
      const res = applyChartInsightsBySignature(sheet.charts, params.charts);
      sheet.charts = res.charts;
      patchedCount += res.patchedCount;
    }
  }

  if (patchedCount === 0) return { ok: true, reason: "nothing_to_patch", patchedCount: 0 };

  await updateDashboard(dashboard);
  return { ok: true, patchedCount };
}
