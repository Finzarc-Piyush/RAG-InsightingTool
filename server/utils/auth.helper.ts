/**
 * Authentication Helper
 * Identity comes from verified JWT (req.auth) set by requireAzureAdAuth,
 * or from X-User-Email when DISABLE_AUTH=true.
 */
import { Request } from "express";
import { isFlagOn } from "../lib/featureFlags.js";

export class AuthenticationError extends Error {
  constructor(message = "Authentication required") {
    super(message);
    this.name = "AuthenticationError";
  }
}

export function getAuthenticatedEmail(req: Request): string | undefined {
  if (req.auth?.email) {
    return req.auth.email;
  }
  if (isFlagOn("DISABLE_AUTH")) {
    const raw = req.headers["x-user-email"];
    if (typeof raw === "string" && raw.trim()) {
      return raw.trim().toLowerCase();
    }
  }
  return undefined;
}

/**
 * Wave R19 · The immutable Azure AD object id (`oid`) — the authoritative,
 * non-reassignable user identity. Prefer this over email for authorization
 * decisions: an email address can be re-aliased or reused across an account's
 * lifecycle, while `oid` never changes. Undefined under DISABLE_AUTH (dev)
 * unless an `X-User-Id` header is supplied.
 */
export function getAuthenticatedOid(req: Request): string | undefined {
  if (req.auth?.oid) {
    return req.auth.oid;
  }
  if (isFlagOn("DISABLE_AUTH")) {
    const raw = req.headers["x-user-id"];
    if (typeof raw === "string" && raw.trim()) {
      return raw.trim();
    }
  }
  return undefined;
}

/** @deprecated Prefer getAuthenticatedEmail; kept for gradual migration */
export function extractUsername(req: Request): string | null {
  return getAuthenticatedEmail(req) ?? null;
}

export function requireUsername(req: Request): string {
  const email = getAuthenticatedEmail(req);
  if (!email) {
    throw new AuthenticationError();
  }
  return email;
}

