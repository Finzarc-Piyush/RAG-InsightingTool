/**
 * Wave WD3-telemetry · POST /api/telemetry/drill-through
 *
 * Client-fired observability hook for the WD3 dashboard drill-through path.
 * The client calls this when its DashboardView listener accepts a validated
 * `DrillThroughEvent` (chartId + column non-empty strings) and is about to
 * open the drill-through sheet — so we can quantify in Cosmos which chart
 * kinds + columns get drilled into and how often.
 *
 * Body: { chartId, column, valueType, dashboardId? }
 * Response: 204 No Content (fire-and-forget on the client side too)
 *
 * Auth via `getAuthenticatedEmail` matches every other write route on this
 * server. Failure modes (cosmos down, malformed doc) are absorbed by
 * `recordUsageEvent`'s fire-and-forget invariant — telemetry MUST NEVER
 * block the user flow, but the endpoint itself still returns 204 so the
 * client's `await fetch(...)` resolves predictably.
 *
 * `valueType` is the JS typeof tag of the clicked mark's value
 * (`"string" | "number" | "boolean" | "object" | "undefined" | …`) — carries
 * the shape of the value without leaking PII (the raw value is never sent).
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { getAuthenticatedEmail } from "../utils/auth.helper.js";
import { recordUsageEvent } from "../models/usageEvent.model.js";

const router = Router();

// Injectable seam so tests can substitute the Cosmos-writing
// `recordUsageEvent` with an in-memory recorder. Production path uses the
// real import via the default below; tests call
// `__setUsageEventRecorderForTesting` from `beforeEach` and reset in
// `afterEach`. Same pattern as the W61 admin controller setters.
type UsageEventRecorder = typeof recordUsageEvent;
let recorder: UsageEventRecorder = recordUsageEvent;
export function __setUsageEventRecorderForTesting(fn: UsageEventRecorder) {
  recorder = fn;
}
export function __resetUsageEventRecorderForTesting() {
  recorder = recordUsageEvent;
}

export const drillThroughTelemetryRequestSchema = z
  .object({
    chartId: z.string().min(1),
    column: z.string().min(1),
    valueType: z.string().min(1),
    dashboardId: z.string().min(1).optional(),
  })
  .strict();

export type DrillThroughTelemetryRequest = z.infer<
  typeof drillThroughTelemetryRequestSchema
>;

export async function drillThroughTelemetryController(
  req: Request,
  res: Response,
) {
  const userEmail = getAuthenticatedEmail(req);
  if (!userEmail) {
    return res.status(401).json({ error: "Missing authenticated user email." });
  }

  const parsed = drillThroughTelemetryRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid request body.",
      details: parsed.error.flatten(),
    });
  }

  const { chartId, column, valueType, dashboardId } = parsed.data;

  void recorder({
    eventType: "dashboard.drill-through",
    userEmail,
    ...(dashboardId ? { dashboardId } : {}),
    metadata: { chartId, column, valueType },
  });

  return res.status(204).send();
}

router.post("/telemetry/drill-through", drillThroughTelemetryController);

export default router;
