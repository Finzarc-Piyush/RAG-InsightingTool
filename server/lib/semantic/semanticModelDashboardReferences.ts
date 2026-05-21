/**
 * Wave W61-references-dashboards · downstream-reference counter for
 * dashboards owned by the session's user. Pairs with W61-references-scan
 * (the chat-doc scanner): that module walks `doc.charts[]` on the chat
 * document; this module walks every chart-tile across every dashboard
 * the session-owner authored. The two together feed the W61-delete-entry
 * confirmation's "removing this metric will break N charts (and M tiles
 * across K dashboards) that reference it" warning.
 *
 * Why a separate module instead of widening the existing scanner:
 *   - The chat-doc walker takes `ReadonlyArray<unknown>` (charts) and
 *     returns `{ chartCount, totalOccurrences }`. The dashboard walker
 *     takes `ReadonlyArray<unknown>` (dashboards) and returns a
 *     dashboard-level + tile-level aggregate — different inputs, different
 *     output shape. Folding both into one function would mean a discriminated
 *     return type and a kind parameter; two pure modules read more directly.
 *   - The chat-doc walker is consumed by other call sites (potential
 *     future blob-stored-charts mode); the dashboard walker is unique to
 *     the references-endpoint. Keeping them separate prevents future
 *     coupling.
 *
 * Why walk `sheets[].charts[]` when present and fall back to
 * `dashboard.charts[]` only when no sheets exist:
 *   - Modern dashboards (post-DR series) keep `dashboard.charts[]` in
 *     sync with the union of all sheet charts (see
 *     [dashboard.model.ts](../../models/dashboard.model.ts):
 *     `createDashboardFromSpec`, `patchDashboard`, `addChartToDashboard`).
 *     Walking both arrays would double-count every tile.
 *   - Pre-sheets dashboards (legacy) only populated `dashboard.charts[]`
 *     and had `sheets` absent or empty. Falling back to the top-level
 *     array preserves coverage for those rows.
 *   - The safety check is `Array.isArray(sheets) && sheets.length > 0`;
 *     any sheet entry without a `.charts` field is silently skipped (a
 *     dashboard sheet with only narrativeBlocks / tables / pivots has no
 *     chart tiles and can't reference a semantic-model entry by metric
 *     name anyway).
 *
 * Why "tile" rather than "chart":
 *   - A single underlying ChartSpec can be the same object referenced
 *     from multiple sheets (the chat-flow agent re-uses chart specs
 *     across the Summary and Evidence sheets). For the destructive-op
 *     warning the admin needs to know "how many positions on dashboards
 *     will lose data," not "how many distinct chart objects exist" —
 *     each position is a tile, and removing the metric breaks each
 *     position independently.
 *   - "Tile" matches the dashboard surface's UX terminology (a
 *     dashboard sheet is a grid of tiles).
 *
 * Why we defensively accept `ReadonlyArray<unknown>` at the top level:
 *   - The caller (the references-endpoint handler) hands us whatever
 *     `getUserDashboards()` returns; per the dashboard model the
 *     production path returns a typed `Dashboard[]` but a Cosmos doc
 *     with malformed shape would slip through unparsed. Defensive
 *     `typeof === "object"` + `Array.isArray` guards keep the scanner
 *     safe on a malformed row without throwing — same defensive shape
 *     as the existing chat-doc scanner.
 */

import {
  countReferencesInChartSpec,
  countReferencesInChartSpecV2,
} from "./semanticModelReferences.js";
import {
  isChartSpecV2,
  type ChartSpec,
  type Dashboard,
} from "../../shared/schema.js";

export interface DashboardReferenceCount {
  /** Distinct dashboards that contain at least one matching tile. */
  dashboardCount: number;
  /** Total chart-tiles across all dashboards whose spec mentions the name. */
  dashboardTileCount: number;
}

function countChartReferences(chart: unknown, name: string): number {
  if (typeof chart !== "object" || chart === null) return 0;
  return isChartSpecV2(chart)
    ? countReferencesInChartSpecV2(chart, name)
    : countReferencesInChartSpec(chart as ChartSpec, name);
}

/**
 * Count distinct dashboards + chart-tiles referencing `name`. Non-object
 * dashboards (and dashboards with neither `sheets` nor `charts`) are
 * silently skipped. Empty `name` short-circuits to zero.
 */
export function countDashboardReferences(
  name: string,
  dashboards: ReadonlyArray<unknown>,
): DashboardReferenceCount {
  let dashboardCount = 0;
  let dashboardTileCount = 0;
  if (!name) return { dashboardCount, dashboardTileCount };
  for (const d of dashboards) {
    if (typeof d !== "object" || d === null) continue;
    const dash = d as Partial<Dashboard>;
    let perDashboardTiles = 0;
    const sheets = Array.isArray(dash.sheets) ? dash.sheets : null;
    if (sheets && sheets.length > 0) {
      for (const s of sheets) {
        if (!s || typeof s !== "object") continue;
        const charts = (s as { charts?: unknown }).charts;
        if (!Array.isArray(charts)) continue;
        for (const c of charts) {
          if (countChartReferences(c, name) > 0) perDashboardTiles += 1;
        }
      }
    } else if (Array.isArray(dash.charts)) {
      for (const c of dash.charts) {
        if (countChartReferences(c, name) > 0) perDashboardTiles += 1;
      }
    }
    if (perDashboardTiles > 0) {
      dashboardCount += 1;
      dashboardTileCount += perDashboardTiles;
    }
  }
  return { dashboardCount, dashboardTileCount };
}
