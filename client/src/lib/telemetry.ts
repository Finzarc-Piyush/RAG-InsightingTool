/**
 * Wave WD3-telemetry · client-side fire-and-forget helper for the
 * `POST /api/telemetry/drill-through` endpoint.
 * Wave WI4-telemetry · sibling helper for `POST /api/telemetry/explain-slice`.
 *
 * Called from the matching DashboardView listener once a validated
 * `DrillThroughEvent` / `ExplainSliceEvent` is accepted. The promise
 * resolves once the fetch settles (success or fail); the caller uses
 * `void recordDashboard{DrillThrough,ExplainSlice}Telemetry(...)` so
 * the user flow never awaits.
 *
 * Invariants (apply to both helpers — shared infrastructure):
 * - **Never throws** — telemetry must NEVER break the user flow, so
 *   network errors and non-2xx server responses are silently absorbed.
 * - **SSR-safe** — no-op when `typeof fetch === "undefined"` (we don't
 *   wire telemetry through the SSR render path).
 * - **PII-aware** — WD3's `valueType` carries the JS `typeof` tag of
 *   the clicked mark's value; WI4's `regionKind` carries the
 *   BrushRegion discriminant (`"numeric" | "temporal" | "categorical"
 *   | "box2d"`). Column NAMES go on the wire (those are dataset
 *   schema, not user content); column VALUES never do.
 * - **Auth, silently** — `/api/telemetry/*` sits behind `requireAzureAdAuth`
 *   like every `/api/*` route, and raw `fetch` bypasses the axios interceptor,
 *   so we attach the Bearer token via `getAuthorizationHeaderSilent()`. The
 *   *silent* variant never pops a re-auth window from a background beacon — if
 *   no token is cached it sends without one (the ping is best-effort anyway).
 *   See docs/conventions/authed-raw-fetch.md.
 */

import { getAuthorizationHeaderSilent } from "@/auth/msalToken";

export interface DrillThroughTelemetryPayload {
  chartId: string;
  column: string;
  valueType: string;
  dashboardId?: string;
  // WD3-WI4-sheetId-telemetry · sheet identity for multi-sheet
  // dashboards. `chartId` is "chart-N" per the DashboardView tile
  // generator, which resets to N=0 per-sheet — so without sheetId,
  // Cosmos aggregations silently collide rows from different sheets.
  // Optional because legacy callers may not have a sheet in context.
  sheetId?: string;
}

export async function recordDashboardDrillThroughTelemetry(
  payload: DrillThroughTelemetryPayload,
): Promise<void> {
  if (typeof fetch === "undefined") return;
  try {
    const auth = await getAuthorizationHeaderSilent();
    await fetch("/api/telemetry/drill-through", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify(payload),
    });
  } catch {
    // Telemetry must never break user flow.
  }
}

export interface ExplainSliceTelemetryPayload {
  chartId: string;
  column: string;
  regionKind: "numeric" | "temporal" | "categorical" | "box2d";
  dashboardId?: string;
  // See DrillThroughTelemetryPayload for the sheetId rationale.
  sheetId?: string;
}

export async function recordDashboardExplainSliceTelemetry(
  payload: ExplainSliceTelemetryPayload,
): Promise<void> {
  if (typeof fetch === "undefined") return;
  try {
    const auth = await getAuthorizationHeaderSilent();
    await fetch("/api/telemetry/explain-slice", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify(payload),
    });
  } catch {
    // Telemetry must never break user flow.
  }
}
