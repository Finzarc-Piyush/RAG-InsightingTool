/**
 * API-4 · Standard response envelope for the versioned `/api/v1` alias.
 *
 * The in-repo client consumes the UNVERSIONED `/api/*` routes and depends on
 * their bespoke raw shapes (`{ sessions, count }`, `{ dashboards }`, raw
 * documents, …). We must NOT change those. API-7 added a `/api/v1` alias that
 * mounts the SAME routers under a versioned prefix (see `routes/index.ts`).
 *
 * This middleware gives that v1 alias the one predictable contract from
 * `lib/responseEnvelope.ts` WITHOUT touching the route handlers: it
 * monkeypatches `res.json` so that, for requests on the v1 prefix only, a
 * success payload (2xx) is wrapped as `ok(payload)` → `{ data: payload }` and
 * an error payload (>=400) is wrapped as `fail(code, message, details?)` →
 * `{ error: { code, message, details? } }`.
 *
 * Non-breaking guarantees:
 *   - Only fires when the request path is on the `/api/v1` prefix. Unversioned
 *     `/api/*` responses are byte-identical to before.
 *   - Skips SSE (`text/event-stream`) — those bodies are streamed, not
 *     `res.json`'d, and must never be buffered/wrapped.
 *   - Skips payloads that are ALREADY an envelope (have a top-level `data` or
 *     `error` key) so a handler that adopts the helpers, or a re-entrant
 *     `res.json` call, isn't double-wrapped.
 */
import type { Request, Response, NextFunction } from "express";
import { ok, fail, type ErrorEnvelope } from "../lib/responseEnvelope.js";

const V1_PREFIX = "/api/v1";

/** True if the request targets the versioned v1 alias. */
function isV1Request(req: Request): boolean {
  // `baseUrl` is the mount path when this middleware is mounted under a prefix;
  // `originalUrl`/`path` are the safety net for an app-level mount.
  const candidates = [req.baseUrl, req.originalUrl, req.path];
  return candidates.some(
    (p) => typeof p === "string" && (p === V1_PREFIX || p.startsWith(`${V1_PREFIX}/`)),
  );
}

/**
 * A value is already an envelope if it matches the `lib/responseEnvelope.ts`
 * contract: a top-level `data` key (SuccessEnvelope) or an `error` OBJECT
 * carrying `{ code, message }` (ErrorEnvelope). The legacy unversioned API
 * emits `{ error: "<string>" }`, which is NOT an envelope and SHOULD be
 * wrapped — so we require `error` to be an object before treating it as one.
 */
function isAlreadyEnvelope(payload: unknown): boolean {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const obj = payload as Record<string, unknown>;
  if ("data" in obj) {
    return true;
  }
  const err = obj.error;
  return (
    typeof err === "object" &&
    err !== null &&
    !Array.isArray(err) &&
    "code" in (err as Record<string, unknown>) &&
    "message" in (err as Record<string, unknown>)
  );
}

/**
 * Derive a `fail(...)` envelope from a raw error payload, preserving any
 * existing `{ error: string }` / `{ message, details }` shape the handlers use
 * today (the unversioned API emits these), so the v1 envelope stays faithful.
 */
function toErrorEnvelope(status: number, payload: unknown): ErrorEnvelope {
  const code = `http_${status}`;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const obj = payload as Record<string, unknown>;
    const message =
      (typeof obj.error === "string" && obj.error) ||
      (typeof obj.message === "string" && obj.message) ||
      `Request failed with status ${status}`;
    const details = obj.details ?? (typeof obj.error === "string" ? undefined : obj.error);
    return details === undefined ? fail(code, message) : fail(code, message, details);
  }
  const message = typeof payload === "string" ? payload : `Request failed with status ${status}`;
  return fail(code, message);
}

export function apiV1Envelope(req: Request, res: Response, next: NextFunction): void {
  if (!isV1Request(req)) {
    next();
    return;
  }

  const originalJson = res.json.bind(res);
  res.json = (payload: unknown): Response => {
    // SSE / event-stream bodies are never JSON-wrapped.
    const contentType = String(res.getHeader("Content-Type") || "");
    if (contentType.includes("text/event-stream")) {
      return originalJson(payload);
    }
    // Don't double-wrap a payload that already follows the envelope contract.
    if (isAlreadyEnvelope(payload)) {
      return originalJson(payload);
    }
    if (res.statusCode >= 400) {
      return originalJson(toErrorEnvelope(res.statusCode, payload));
    }
    return originalJson(ok(payload));
  };

  next();
}
