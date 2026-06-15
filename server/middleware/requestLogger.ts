/**
 * EX21 / OBS-5 · HTTP access logging.
 *
 * Emits one line per request on response `finish` with method, path, status,
 * and duration — so request latency/status (and, for authed requests, the
 * user and trace correlation) are visible in production. Pairs with the
 * structured `logger` (OBS-1): in JSON mode each access line is a structured
 * record carrying traceId/sessionId from the request context.
 *
 * Registered early (before auth) so EVERY request — including 401s and
 * preflights — is captured; `req.auth` is read at finish-time, by which point
 * the auth middleware has populated it for successful requests. High-frequency
 * health/readiness probes are skipped to avoid noise.
 */
import type { Request, Response, NextFunction } from "express";
import { logger } from "../lib/logger.js";

const SKIP_PATHS = new Set(["/health", "/ready", "/api/health", "/api/ready"]);

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const path = req.path || req.url || "";
  if (SKIP_PATHS.has(path)) {
    next();
    return;
  }
  const start = Date.now();
  res.on("finish", () => {
    const durationMs = Date.now() - start;
    const userId = (req as { auth?: { email?: string } }).auth?.email;
    const target = req.originalUrl || path;
    logger.info(
      `${req.method} ${target} ${res.statusCode} ${durationMs}ms${userId ? ` user=${userId}` : ""}`,
    );
  });
  next();
}
