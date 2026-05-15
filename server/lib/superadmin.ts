/**
 * Superadmin shadow viewer · hardcoded allowlist (Wave AD2 · single source of truth).
 *
 * One email gets read-only access to every session, dashboard, and analysis
 * across all users, plus the new admin dashboard surface (Wave AD7+).
 * Surfaced in the UI via an additional top-navbar item. Hardcoded (not
 * env-driven) by user requirement — rotation is a one-line edit away.
 *
 * Wave AD2 · `isAdminRequest` (formerly env-driven via ADMIN_EMAILS) now
 * delegates to `isSuperadminRequest`, so existing /admin/costs and
 * /admin/context-packs endpoints share this single allowlist with the new
 * /admin/dashboard surface. The `ADMIN_EMAILS` env var is no longer
 * consulted in production. Tests use `__setSuperadminEmailsForTesting` to
 * temporarily widen the allowlist in-process.
 *
 * Read-only is enforced by NOT widening any write endpoint. Superadmins use
 * dedicated `/api/superadmin/*` GETs that bypass the per-user collaborator
 * check; existing write paths (chat stream, dashboard PATCH/DELETE) keep
 * their ownership checks unchanged, so a superadmin trying to write into
 * someone else's session still 403s.
 */

import type { Request } from "express";
import { getAuthenticatedEmail } from "../utils/auth.helper.js";

const HARDCODED_SUPERADMIN_EMAILS: ReadonlyArray<string> = [
  "piyush@finzarc.com",
];

let SUPERADMIN_EMAILS = new Set<string>(HARDCODED_SUPERADMIN_EMAILS);

export function isSuperadminEmail(email: string | undefined | null): boolean {
  if (!email) return false;
  return SUPERADMIN_EMAILS.has(email.trim().toLowerCase());
}

/**
 * Wave AD2 · uses `getAuthenticatedEmail` so DISABLE_AUTH mode (tests + dev)
 * picks up the `x-user-email` header just like the rest of the auth surface.
 * In production, identity comes from the verified Azure AD JWT.
 */
export function isSuperadminRequest(req: Request): boolean {
  return isSuperadminEmail(getAuthenticatedEmail(req));
}

/**
 * Test-only escape hatch · override the in-process allowlist for the duration
 * of a test, then call again with the empty array (or the original list) to
 * restore. Production code MUST NOT call this — it bypasses the security
 * contract that admin access is hardcoded to a single email.
 *
 * Wave AD2 · introduced so the existing adminDomainContext / admin costs
 * tests that previously toggled `process.env.ADMIN_EMAILS` continue to work
 * after the env-driven gate was retired.
 */
export function __setSuperadminEmailsForTesting(emails: ReadonlyArray<string>): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("__setSuperadminEmailsForTesting must not be called in production");
  }
  SUPERADMIN_EMAILS = new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean));
}

/**
 * Test-only · restore the production hardcoded allowlist after a test mutated
 * it via `__setSuperadminEmailsForTesting`.
 */
export function __resetSuperadminEmailsForTesting(): void {
  SUPERADMIN_EMAILS = new Set<string>(HARDCODED_SUPERADMIN_EMAILS);
}
