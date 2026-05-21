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
 */

export interface DrillThroughTelemetryPayload {
  chartId: string;
  column: string;
  valueType: string;
  dashboardId?: string;
}

export async function recordDashboardDrillThroughTelemetry(
  payload: DrillThroughTelemetryPayload,
): Promise<void> {
  if (typeof fetch === "undefined") return;
  try {
    await fetch("/api/telemetry/drill-through", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
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
}

export async function recordDashboardExplainSliceTelemetry(
  payload: ExplainSliceTelemetryPayload,
): Promise<void> {
  if (typeof fetch === "undefined") return;
  try {
    await fetch("/api/telemetry/explain-slice", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    // Telemetry must never break user flow.
  }
}
