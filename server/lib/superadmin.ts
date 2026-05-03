/**
 * Superadmin shadow viewer · hardcoded allowlist.
 *
 * Two emails get read-only access to every session, dashboard, and analysis
 * across all users. Surfaced in the UI via an additional top-navbar item.
 * Hardcoded (not env-driven) by user choice — rotation is a one-line edit
 * away. Mirrors the shape of `admin.helper.ts` so a future requireSuperadmin
 * middleware can drop in cleanly if more endpoints accumulate.
 *
 * Read-only is enforced by NOT widening any write endpoint. Superadmins use
 * dedicated `/api/superadmin/*` GETs that bypass the per-user collaborator
 * check; existing write paths (chat stream, dashboard PATCH/DELETE) keep
 * their ownership checks unchanged, so a superadmin trying to write into
 * someone else's session still 403s.
 */

import type { Request } from "express";

const SUPERADMIN_EMAILS = new Set<string>([
  "piyush@finzarc.com",
  "piyush.kumar@finzarc.com",
]);

export function isSuperadminEmail(email: string | undefined | null): boolean {
  if (!email) return false;
  return SUPERADMIN_EMAILS.has(email.trim().toLowerCase());
}

export function isSuperadminRequest(req: Request): boolean {
  const email = (req as Request & { auth?: { email?: string } }).auth?.email;
  return isSuperadminEmail(email);
}
