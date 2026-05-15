/**
 * Wave AD2 · Express middleware that gates a route to superadmin emails only.
 *
 * Composes with the existing `requireAzureAdAuth` middleware (which populates
 * `req.auth.email` from the verified JWT). Mount order matters — this MUST
 * come AFTER `requireAzureAdAuth`. The new /admin/* endpoints (Wave AD6+)
 * use this; existing /admin/costs and /admin/context-packs controllers
 * continue to call `isAdminRequest()` directly (which now also delegates to
 * the same `isSuperadminEmail` source via `admin.helper.ts`).
 *
 * Returns 403 with a stable error code so the client can render a generic
 * "Not authorized" page without leaking whether the route exists.
 */

import type { Request, Response, NextFunction } from "express";
import { isSuperadminRequest } from "../lib/superadmin.js";

export function requireSuperadmin(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!isSuperadminRequest(req)) {
    res.status(403).json({ error: "superadmin_required" });
    return;
  }
  next();
}
