/**
 * Wave WD3-telemetry · client-side fire-and-forget helper for the
 * `POST /api/telemetry/drill-through` endpoint.
 *
 * Called from the DashboardView WD3 listener once a validated
 * `DrillThroughEvent` is accepted. The promise resolves once the fetch
 * settles (success or fail); the caller uses `void recordDashboardDrillThroughTelemetry(...)`
 * so the user flow never awaits.
 *
 * Invariants:
 * - **Never throws** — telemetry must NEVER break the user flow, so
 *   network errors and non-2xx server responses are silently absorbed.
 * - **SSR-safe** — no-op when `typeof fetch === "undefined"` (we don't
 *   wire telemetry through the SSR render path).
 * - **PII-aware** — `valueType` carries the JS `typeof` tag of the
 *   clicked mark's value, NOT the value itself. Column NAMES go on the
 *   wire (those are dataset schema, not user content); column VALUES
 *   do not.
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
