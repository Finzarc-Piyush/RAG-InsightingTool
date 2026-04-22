/**
 * Verifies Azure AD JWTs (ID tokens from the SPA) via JWKS.
 * EventSource cannot send Authorization; GET requests may pass access_token query (same JWT).
 */
import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import jwksClient from "jwks-rsa";
import { timingSafeEqual, createHash } from "crypto";

const MAX_CACHE_TTL_MS = 5 * 60 * 1000; // revoked tokens valid for at most 5 min

interface CachedAuth {
  email: string;
  oid: string | undefined;
  claims: jwt.JwtPayload;
  expiresAt: number;
}
const tokenCache = new Map<string, CachedAuth>();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of tokenCache) if (v.expiresAt <= now) tokenCache.delete(k);
}, 10 * 60 * 1000).unref();

function timingSafeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const abuf = Buffer.from(a);
  const bbuf = Buffer.from(b);
  return timingSafeEqual(abuf, bbuf);
}

function getTokenFromRequest(req: Request): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    const t = auth.slice(7).trim();
    if (t) return t;
  }
  const q = req.query.access_token;
  if (typeof q === "string" && q.trim()) return q.trim();
  return null;
}

function pickEmail(claims: jwt.JwtPayload): string {
  const p = claims as Record<string, unknown>;
  const email =
    (typeof p.email === "string" && p.email) ||
    (typeof p.preferred_username === "string" && p.preferred_username) ||
    (typeof p.upn === "string" && p.upn) ||
    "";
  return email.trim().toLowerCase();
}

const jwksClients = new Map<string, ReturnType<typeof jwksClient>>();

function getJwksClient(tenantId: string) {
  let c = jwksClients.get(tenantId);
  if (!c) {
    c = jwksClient({
      jwksUri: `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`,
      cache: true,
      cacheMaxAge: 10 * 60 * 1000,
    });
    jwksClients.set(tenantId, c);
  }
  return c;
}

function verifyToken(
  token: string,
  tenantId: string,
  audience: string
): Promise<jwt.JwtPayload> {
  const client = getJwksClient(tenantId);
  return new Promise((resolve, reject) => {
    jwt.verify(
      token,
      (header, cb) => {
        if (!header.kid) {
          cb(new Error("Missing token kid"));
          return;
        }
        client.getSigningKey(header.kid, (err: Error | null, key?: { getPublicKey: () => string }) => {
          if (err) {
            cb(err);
            return;
          }
          cb(null, key?.getPublicKey());
        });
      },
      {
        audience,
        issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
        algorithms: ["RS256"],
        clockTolerance: 300,
      },
      (err, decoded) => {
        if (err || !decoded || typeof decoded === "string") {
          reject(err ?? new Error("Invalid token payload"));
          return;
        }
        resolve(decoded);
      }
    );
  });
}

/**
 * Skip auth for OPTIONS and /api/health only. Apply under app.use('/api', ...).
 */
export async function requireAzureAdAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (req.method === "OPTIONS") {
    next();
    return;
  }

  const path = req.path || "";
  if (path === "/health" || path.startsWith("/health")) {
    next();
    return;
  }

  if (process.env.DISABLE_AUTH === "true") {
    // P-009: belt-and-braces guards against accidental production bypass.
    // (1) refuse to honour the flag in production
    if (process.env.NODE_ENV === "production" || process.env.VERCEL) {
      console.error(
        "DISABLE_AUTH=true is not honoured in production / Vercel; rejecting request"
      );
      res.status(500).json({ error: "Server authentication is not configured" });
      return;
    }
    // (2) require a secondary dev-only sentinel header/env match
    const expectedSentinel = process.env.AUTH_BYPASS_DEV_TOKEN?.trim();
    if (expectedSentinel) {
      const provided = req.headers["x-auth-bypass-dev-token"];
      const providedStr = typeof provided === "string" ? provided.trim() : "";
      const match =
        providedStr.length === expectedSentinel.length &&
        timingSafeStringEqual(providedStr, expectedSentinel);
      if (!match) {
        res.status(401).json({ error: "DISABLE_AUTH requires X-Auth-Bypass-Dev-Token" });
        return;
      }
    }
    const raw = req.headers["x-user-email"];
    const email =
      typeof raw === "string" && raw.trim() ? raw.trim().toLowerCase() : "";
    if (!email) {
      res.status(401).json({ error: "Missing X-User-Email (DISABLE_AUTH=true)" });
      return;
    }
    // (3) audit-log every bypassed request for forensic review
    console.warn(
      `⚠️ DISABLE_AUTH bypass: ${req.method} ${req.path} email=${email} ip=${req.ip}`
    );
    req.auth = { email, claims: {} };
    next();
    return;
  }

  const tenantId = process.env.AZURE_AD_TENANT_ID?.trim();
  const audience = process.env.AZURE_AD_CLIENT_ID?.trim();
  if (!tenantId || !audience) {
    console.error("AZURE_AD_TENANT_ID and AZURE_AD_CLIENT_ID must be set (or use DISABLE_AUTH=true for local dev)");
    res.status(500).json({ error: "Server authentication is not configured" });
    return;
  }

  const token = getTokenFromRequest(req);
  if (!token) {
    res.status(401).json({ error: "Missing Authorization: Bearer token or access_token query" });
    return;
  }

  const tokenKey = createHash("sha256").update(token).digest("hex");
  const cached = tokenCache.get(tokenKey);
  if (cached && cached.expiresAt > Date.now()) {
    req.auth = { email: cached.email, oid: cached.oid, claims: cached.claims };
    next();
    return;
  }

  try {
    const claims = await verifyToken(token, tenantId, audience);
    const email = pickEmail(claims);
    if (!email) {
      res.status(403).json({ error: "Token is missing an email or preferred_username claim" });
      return;
    }
    const oid = typeof claims.oid === "string" ? claims.oid : undefined;
    const tokenExp = typeof claims.exp === "number" ? claims.exp * 1000 : Infinity;
    tokenCache.set(tokenKey, { email, oid, claims, expiresAt: Math.min(tokenExp, Date.now() + MAX_CACHE_TTL_MS) });
    req.auth = { email, oid, claims };
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}
