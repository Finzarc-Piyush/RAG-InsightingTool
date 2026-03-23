/**
 * Authentication Helper
 * Identity comes from verified JWT (req.auth) set by requireAzureAdAuth,
 * or from X-User-Email when DISABLE_AUTH=true.
 */
import { Request } from "express";

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
  if (process.env.DISABLE_AUTH === "true") {
    const raw = req.headers["x-user-email"];
    if (typeof raw === "string" && raw.trim()) {
      return raw.trim().toLowerCase();
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

