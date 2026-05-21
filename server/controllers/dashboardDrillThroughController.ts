/**
 * Wave WD3-server · POST /api/dashboards/:id/drill — controller.
 *
 * Returns underlying rows for a (chart, column, value) pin under the
 * active filter snapshot. POST body (not GET) because the filters
 * payload can be a nontrivial object (ActiveChartFilters); query
 * params would force JSON-in-URL-string encoding for the common case.
 *
 * Request:
 *   - URL params: `id` = dashboard id
 *   - Query params: `chartId`, `column` (URL-encoded), `value` (URL-encoded),
 *     optional `sheetId` (Wave WD3-server-sheetId-resolution — disambiguates
 *     the per-sheet `chart-N` on multi-sheet dashboards; absent → legacy
 *     walk-across-sheets behaviour preserved for shareable URLs)
 *   - Body (application/json):
 *     ```ts
 *     { filters?: ActiveChartFilters, extraPins?: DrillThroughPin[] }
 *     ```
 *
 * Response: `DrillThroughResponse` ({ rows, totalMatched, capApplied,
 * chart: { title, tileId } }).
 *
 * Auth: gated by `getAuthenticatedEmail` — only the dashboard owner
 * can drill. Same auth pattern as the export endpoints.
 *
 * Error mapping:
 *   - 401 missing auth
 *   - 400 missing chartId / column
 *   - 404 dashboard / chart not found
 *   - 500 unexpected
 */

import type { Request, Response } from "express";
import { getAuthenticatedEmail } from "../utils/auth.helper.js";
import { getDashboardById } from "../models/dashboard.model.js";
import {
  resolveDrillThrough,
  type DrillThroughRequest,
} from "../services/dashboardDrillThrough.service.js";

export async function drillDashboardController(
  req: Request,
  res: Response,
): Promise<void> {
  const userEmail = getAuthenticatedEmail(req);
  if (!userEmail) {
    res.status(401).json({ error: "auth_required" });
    return;
  }
  const dashboardId = req.params.id;
  if (!dashboardId) {
    res.status(400).json({ error: "missing_dashboard_id" });
    return;
  }
  const chartId =
    typeof req.query.chartId === "string" ? req.query.chartId : undefined;
  const column =
    typeof req.query.column === "string" ? req.query.column : undefined;
  if (!chartId || !column) {
    res.status(400).json({ error: "missing_chart_id_or_column" });
    return;
  }
  // `value` is intentionally lenient — null / undefined / "" are valid
  // drill targets (e.g. "drill into rows where Region is null").
  const value = typeof req.query.value === "string" ? req.query.value : null;
  // Wave WD3-server-sheetId-resolution · optional sheetId scopes the
  // chartId lookup to a specific sheet on multi-sheet dashboards. Read
  // as a string-only query param (typeof guard matches the chartId /
  // column / value pattern above); leave undefined when absent so the
  // service's legacy walk-across-sheets behaviour stays the fallback.
  const sheetId =
    typeof req.query.sheetId === "string" ? req.query.sheetId : undefined;
  const body = (req.body ?? {}) as {
    filters?: DrillThroughRequest["filters"];
    extraPins?: DrillThroughRequest["extraPins"];
  };
  try {
    const dashboard = await getDashboardById(dashboardId, userEmail);
    if (!dashboard) {
      res.status(404).json({ error: "dashboard_not_found" });
      return;
    }
    const response = resolveDrillThrough(dashboard, chartId, {
      column,
      value,
      extraPins: body.extraPins,
      filters: body.filters,
      sheetId,
    });
    res.status(200).json(response);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith("chart_not_found:")) {
      res.status(404).json({ error: msg });
      return;
    }
    console.error(`drill-through failed for ${dashboardId}: ${msg}`);
    res.status(500).json({ error: "drill_through_failed" });
  }
}
