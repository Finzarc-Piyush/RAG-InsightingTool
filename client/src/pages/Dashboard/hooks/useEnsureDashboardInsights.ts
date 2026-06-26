import { useEffect, useRef } from "react";
import type { ChartSpec, Dashboard as ServerDashboard } from "@/shared/schema";
import { getAuthorizationHeader } from "@/auth/msalToken";
import { logger } from "@/lib/logger";

/**
 * Self-heal a saved dashboard's chart insights on open.
 *
 * Saved dashboards can render with "No insight yet …" tiles when the in-turn
 * born-insighted patch missed (race / wrong id / signature miss) and tile-level
 * regen never persisted. This hook detects any bare chart tile and, ONCE per
 * dashboard, asks the server to reuse the linked chat's insights + generate the
 * gaps + persist (`POST /api/dashboards/:id/ensure-insights`). On success it
 * swaps the healed dashboard back in so the tiles repaint and survive reload.
 *
 * Loop-safe: each dashboard id is attempted at most once per mount, so charts
 * that legitimately yield no insight don't re-trigger.
 */

type ChartLite = Pick<ChartSpec, "keyInsight"> & { insight?: { default?: string } };
type DashboardLite = {
  id: string;
  charts?: ChartLite[];
  sheets?: Array<{ charts?: ChartLite[] }>;
} | null | undefined;

function hasText(s: unknown): boolean {
  return typeof s === "string" && s.trim().length > 0;
}

function anyBareChart(dashboard: NonNullable<DashboardLite>): boolean {
  const charts: ChartLite[] = [
    ...(dashboard.charts ?? []),
    ...((dashboard.sheets ?? []).flatMap((s) => s.charts ?? [])),
  ];
  return charts.some((c) => !hasText(c.keyInsight) && !hasText(c.insight?.default));
}

export function useEnsureDashboardInsights(
  dashboard: DashboardLite,
  onHealed: (healed: ServerDashboard) => void,
): void {
  const attemptedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!dashboard?.id) return;
    if (attemptedRef.current.has(dashboard.id)) return;
    if (!anyBareChart(dashboard)) return;

    const id = dashboard.id;
    attemptedRef.current.add(id);

    void (async () => {
      try {
        // Raw fetch bypasses the axios apiClient interceptor, so attach the
        // Bearer token explicitly — otherwise this silent self-heal 401s and
        // the tile stays "No insight yet" (docs/conventions/authed-raw-fetch.md).
        const auth = await getAuthorizationHeader();
        const res = await fetch(`/api/dashboards/${id}/ensure-insights`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json", ...auth },
        });
        if (!res.ok) return;
        const data = (await res.json()) as {
          patchedCount: number;
          dashboard: ServerDashboard | null;
        };
        if (data.patchedCount > 0 && data.dashboard) onHealed(data.dashboard);
      } catch (err) {
        logger.warn("ensure-insights heal failed", err);
      }
    })();
  }, [dashboard, onHealed]);
}
