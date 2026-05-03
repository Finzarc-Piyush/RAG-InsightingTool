/**
 * Superadmin shadow-viewer endpoints. Two hardcoded emails (see
 * `server/lib/superadmin.ts`) get read-only access to every session, dashboard,
 * and analysis across all users. All endpoints here gate on
 * `isSuperadminRequest(req)` and 403 otherwise — defence in depth alongside
 * the client-side navbar gate.
 */

import type { Request, Response } from "express";
import { getAuthenticatedEmail } from "../utils/auth.helper.js";
import { isSuperadminEmail, isSuperadminRequest } from "../lib/superadmin.js";
import {
  getAllSessions,
  getChatBySessionIdForSuperadmin,
} from "../models/chat.model.js";
import { aggregateFeedbackCountsBySession } from "../models/pastAnalysis.model.js";
import {
  listAllDashboardsForSuperadmin,
  getDashboardByIdForSuperadmin,
} from "../models/dashboard.model.js";

/**
 * GET /api/superadmin/me — single bit the client uses to decide whether to
 * render the "Admin View" navbar item. Always 200 — false for non-allowlist
 * users — so the client doesn't have to handle 403 specially.
 */
export async function superadminMeEndpoint(req: Request, res: Response) {
  const email = getAuthenticatedEmail(req);
  return res.json({
    isSuperadmin: isSuperadminEmail(email),
    email: email ?? null,
  });
}

/**
 * Generic gate. Mounts before every other superadmin endpoint to short-circuit
 * with 403 before any Cosmos query fires.
 */
export function requireSuperadmin(req: Request, res: Response, next: () => void) {
  if (!isSuperadminRequest(req)) {
    return res.status(403).json({ error: "superadmin_required" });
  }
  next();
}

/**
 * GET /api/superadmin/sessions — every session across every user. Returns the
 * lightweight `SessionListSummary` shape augmented with per-session feedback
 * counts (▲ N / ▼ N / ◯ N) so the table can flag sessions with negative
 * feedback at a glance.
 */
export async function listAllSessionsForSuperadminEndpoint(
  _req: Request,
  res: Response
) {
  try {
    const [sessions, feedbackCountsBySession] = await Promise.all([
      getAllSessions(undefined),
      aggregateFeedbackCountsBySession().catch(
        (err) => {
          console.warn(
            `⚠️ superadmin: feedback aggregation failed (${err instanceof Error ? err.message : String(err)}); rendering with zero counts`
          );
          return new Map<string, { up: number; down: number; none: number }>();
        }
      ),
    ]);

    const rows = sessions.map((s) => {
      const counts = feedbackCountsBySession.get(s.sessionId) ?? {
        up: 0,
        down: 0,
        none: 0,
      };
      return {
        sessionId: s.sessionId,
        ownerEmail: s.username ?? null,
        fileName: s.fileName ?? null,
        createdAt: s.createdAt ?? null,
        lastUpdatedAt: s.lastUpdatedAt ?? null,
        messageCount: s.messageCount ?? 0,
        chartCount: s.chartCount ?? 0,
        feedbackCounts: counts,
        // Filled in W9 once the dashboards aggregation lands. For now the
        // chip in the UI is disabled when this is false.
        hasDashboards: false,
      };
    });

    return res.json({ sessions: rows, count: rows.length });
  } catch (err) {
    console.error("⚠️ superadmin/sessions failed:", err);
    return res.status(500).json({ error: "superadmin_sessions_failed" });
  }
}

/**
 * GET /api/superadmin/sessions/:sessionId — full chat doc for any session,
 * bypassing the collaborator check. Read-only — no write surface widened.
 */
export async function getSessionForSuperadminEndpoint(
  req: Request,
  res: Response
) {
  try {
    const { sessionId } = req.params;
    if (!sessionId) {
      return res.status(400).json({ error: "session_id_required" });
    }
    const session = await getChatBySessionIdForSuperadmin(sessionId);
    if (!session) return res.status(404).json({ error: "session_not_found" });
    return res.json({ session, _superadmin: true });
  } catch (err) {
    console.error("⚠️ superadmin/sessions/:id failed:", err);
    return res.status(500).json({ error: "superadmin_session_fetch_failed" });
  }
}

/**
 * GET /api/superadmin/dashboards — every dashboard across every user.
 */
export async function listAllDashboardsForSuperadminEndpoint(
  _req: Request,
  res: Response
) {
  try {
    const dashboards = await listAllDashboardsForSuperadmin();
    const rows = dashboards.map((d) => {
      const dd = d as unknown as {
        id: string;
        username?: string;
        name?: string;
        createdAt?: number | null;
        updatedAt?: number | null;
      };
      return {
        dashboardId: dd.id,
        ownerEmail: dd.username ?? null,
        name: dd.name ?? "(untitled)",
        createdAt: dd.createdAt ?? null,
        updatedAt: dd.updatedAt ?? null,
      };
    });
    return res.json({ dashboards: rows, count: rows.length });
  } catch (err) {
    console.error("⚠️ superadmin/dashboards failed:", err);
    return res.status(500).json({ error: "superadmin_dashboards_failed" });
  }
}

/**
 * GET /api/superadmin/dashboards/:dashboardId — full dashboard doc, bypassing
 * the collaborator check. Read-only.
 */
export async function getDashboardForSuperadminEndpoint(
  req: Request,
  res: Response
) {
  try {
    const { dashboardId } = req.params;
    if (!dashboardId) {
      return res.status(400).json({ error: "dashboard_id_required" });
    }
    const dashboard = await getDashboardByIdForSuperadmin(dashboardId);
    if (!dashboard) {
      return res.status(404).json({ error: "dashboard_not_found" });
    }
    return res.json({ dashboard, _superadmin: true });
  } catch (err) {
    console.error("⚠️ superadmin/dashboards/:id failed:", err);
    return res.status(500).json({ error: "superadmin_dashboard_fetch_failed" });
  }
}
