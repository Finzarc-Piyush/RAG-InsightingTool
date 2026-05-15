/**
 * Admin allow-list. Wave AD2 · consolidated to delegate to the hardcoded
 * superadmin allowlist in `server/lib/superadmin.ts` so /admin/costs,
 * /admin/context-packs, and the new /admin/dashboard surface (Wave AD6+)
 * all share one source of truth.
 *
 * Pre-AD2 this was env-driven via the `ADMIN_EMAILS` env var. That env is
 * no longer consulted — production access is hardcoded to a single email
 * per user requirement. Tests that previously toggled `process.env.ADMIN_EMAILS`
 * should call `__setSuperadminEmailsForTesting` from `server/lib/superadmin.ts`
 * instead.
 */

import type { Request } from "express";
import {
  isSuperadminEmail,
  isSuperadminRequest,
} from "../lib/superadmin.js";

export function isAdminEmail(email: string | undefined): boolean {
  return isSuperadminEmail(email);
}

export function isAdminRequest(req: Request): boolean {
  return isSuperadminRequest(req);
}
