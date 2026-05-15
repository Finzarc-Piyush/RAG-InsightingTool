import type { DashboardData } from "./modules/useDashboardState";

/**
 * Wave DR15 · resolve every chat session that contributed to a dashboard.
 *
 * A dashboard can be "single-source" (the common case — the agent
 * auto-created it from one chat turn, or the user manually clicked
 * "Save as dashboard" on a draft card) or "multi-source" (the user
 * mixed in tiles from different sessions via DR13's add-tile menu, or
 * a pivot tile carries its own `sourceSessionId`).
 *
 * Sources are collected from two places, in priority order:
 *
 *   1. `dashboard.sessionId` — the session the dashboard was created
 *      *from*. Persisted at server side by the `from-spec` /
 *      `from-analysis` paths since DR15. Treated as the "primary"
 *      session and surfaced first in the UI.
 *
 *   2. `dashboard.sheets[].pivots[].sourceSessionId` — every pivot tile
 *      knows its own source session (pre-existing schema field).
 *      Useful for dashboards built from multiple chats.
 *
 * Chart tiles do not currently carry a `sourceSessionId` field on
 * their spec — adding that is a wider chart-schema change deferred to
 * a follow-up wave. Multi-source dashboards composed entirely of
 * agent-loop charts will surface only the `dashboard.sessionId`.
 *
 * The result is intentionally a flat de-duplicated list; the consumer
 * decides whether to render a single button or a dropdown.
 *
 * Pure function — no React, no async, no DOM.
 */

export interface DashboardSourceSession {
  sessionId: string;
  /** True when this is `dashboard.sessionId` (the originating session). */
  isPrimary: boolean;
}

export function dashboardSourceSessions(
  dashboard: Pick<DashboardData, "sessionId" | "sheets">,
): DashboardSourceSession[] {
  const out: DashboardSourceSession[] = [];
  const seen = new Set<string>();

  const push = (id: string | undefined | null, isPrimary: boolean) => {
    if (!id) return;
    const trimmed = id.trim();
    if (!trimmed) return;
    if (seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push({ sessionId: trimmed, isPrimary });
  };

  push(dashboard.sessionId, true);
  for (const sheet of dashboard.sheets ?? []) {
    for (const pivot of sheet.pivots ?? []) {
      push(pivot.sourceSessionId, false);
    }
  }

  return out;
}
