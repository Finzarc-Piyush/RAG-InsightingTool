/**
 * DPF2 · patch a persisted dashboard's `businessActions` field after the
 * post-verifier `businessActionsAgent` resolves. Mirrors the BAI1 pattern
 * already used for `patchAssistantBusinessActions` on the chat message —
 * the auto-create dashboard fires synchronously inside `runAgentTurn`,
 * BEFORE the businessActions Promise resolves, so we must patch the
 * persisted document later.
 *
 * Per-dashboard in-process mutex: concurrent patches against the same
 * dashboard chain through a Promise so the read-modify-write of
 * `dashboard.businessActions` is serialised. Single-instance correctness
 * only — multi-instance scaling needs Cosmos `ifMatch` ETag (parity with
 * the W40 `persistMergeAssistantSessionContext` caveat).
 *
 * Failure isolation: if the patch fails or times out, the user simply
 * sees the dashboard without business actions. The analytical answer
 * and on-screen chat experience are unaffected.
 */

import type { BusinessActionItem } from "../shared/schema.js";

const dashboardPatchChain = new Map<string, Promise<unknown>>();

export async function patchDashboardBusinessActions(params: {
  dashboardId: string;
  username: string;
  items: BusinessActionItem[];
}): Promise<{ ok: boolean; reason?: string }> {
  if (!params.items?.length) return { ok: true, reason: "empty" };

  const previous = dashboardPatchChain.get(params.dashboardId);
  const work = (async () => {
    if (previous) {
      try {
        await previous;
      } catch {
        // Prior caller's failure is its own concern.
      }
    }
    return doPatch(params);
  })();
  dashboardPatchChain.set(params.dashboardId, work);
  try {
    return await work;
  } finally {
    if (dashboardPatchChain.get(params.dashboardId) === work) {
      dashboardPatchChain.delete(params.dashboardId);
    }
  }
}

async function doPatch(params: {
  dashboardId: string;
  username: string;
  items: BusinessActionItem[];
}): Promise<{ ok: boolean; reason?: string }> {
  const { getDashboardById, updateDashboard } = await import(
    "../models/dashboard.model.js"
  );
  const dashboard = await getDashboardById(params.dashboardId, params.username);
  if (!dashboard) return { ok: false, reason: "dashboard_not_found" };

  dashboard.businessActions = params.items;
  await updateDashboard(dashboard);
  return { ok: true };
}
