/**
 * Wave WD3-telemetry · POST /api/telemetry/drill-through
 * Wave WI4-telemetry · POST /api/telemetry/explain-slice
 *
 * Two client-fired observability hooks for the dashboard click-intent
 * family: WD3 drill-through (single cmd-click) and WI4 explain-slice
 * (rect-drag brush). Both reuse the AD3 `recordUsageEvent`
 * fire-and-forget pattern proven in `dashboardController.ts` for
 * `dashboard.opened`. The client calls each when its DashboardView
 * listener accepts a validated event and is about to open the
 * corresponding side-surface — so we can quantify in Cosmos which
 * chart kinds + columns get interacted with via which click-intent.
 *
 * Body shapes:
 *   - drill-through: { chartId, column, valueType,  dashboardId? }
 *   - explain-slice: { chartId, column, regionKind, dashboardId? }
 * Response: 204 No Content (fire-and-forget on the client side too)
 *
 * Auth via `getAuthenticatedEmail` matches every other write route on this
 * server. Failure modes (cosmos down, malformed doc) are absorbed by
 * `recordUsageEvent`'s fire-and-forget invariant — telemetry MUST NEVER
 * block the user flow, but the endpoint itself still returns 204 so the
 * client's `await fetch(...)` resolves predictably.
 *
 * PII contract — both endpoints carry column NAMES (dataset schema,
 * public) but NEVER column VALUES. WD3's `valueType` is the JS typeof
 * tag of the clicked mark's value (`"string" | "number" | ...`); WI4's
 * `regionKind` is the BrushRegion discriminant
 * (`"numeric" | "temporal" | "categorical" | "box2d"`) — both observe
 * the shape of the click target without leaking the raw value.
 *
 * Route-level recorder seam: `__setUsageEventRecorderForTesting` /
 * `__resetUsageEventRecorderForTesting` are shared by both controllers
 * (second instance of this pattern at the route layer — first instance
 * shipped with WD3). The seam captures the model writer in a mutable
 * module-local so tests can substitute without ESM-binding gymnastics.
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

export const explainSliceTelemetryRequestSchema = z
  .object({
    chartId: z.string().min(1),
    column: z.string().min(1),
    regionKind: z.enum(["numeric", "temporal", "categorical", "box2d"]),
    dashboardId: z.string().min(1).optional(),
  })
  .strict();

export type ExplainSliceTelemetryRequest = z.infer<
  typeof explainSliceTelemetryRequestSchema
>;

export async function explainSliceTelemetryController(
  req: Request,
  res: Response,
) {
  const userEmail = getAuthenticatedEmail(req);
  if (!userEmail) {
    return res.status(401).json({ error: "Missing authenticated user email." });
  }

  const parsed = explainSliceTelemetryRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid request body.",
      details: parsed.error.flatten(),
    });
  }

  const { chartId, column, regionKind, dashboardId } = parsed.data;

  void recorder({
    eventType: "dashboard.explain-slice",
    userEmail,
    ...(dashboardId ? { dashboardId } : {}),
    metadata: { chartId, column, regionKind },
  });

  return res.status(204).send();
}

router.post("/telemetry/explain-slice", explainSliceTelemetryController);

export default router;
