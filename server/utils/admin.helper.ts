/**
 * Admin allow-list. Reads `ADMIN_EMAILS` env (comma-separated, case-insensitive)
 * and returns true when the supplied email matches any entry. Centralised here
 * so admin-gated routes (W6.4) all use the same source of truth.
 */

import type { Request } from "express";
import { getAuthenticatedEmail } from "./auth.helper.js";

function adminSet(): Set<string> {
  const raw = process.env.ADMIN_EMAILS || "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

export function isAdminEmail(email: string | undefined): boolean {
  if (!email) return false;
  return adminSet().has(email.toLowerCase());
}

export function isAdminRequest(req: Request): boolean {
  return isAdminEmail(getAuthenticatedEmail(req));
}
