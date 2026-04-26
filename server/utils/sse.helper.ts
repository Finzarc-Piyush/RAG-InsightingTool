/**
 * SSE (Server-Sent Events) Helper
 * Utility functions for handling SSE connections
 */
import { Response } from "express";
import { validateSseEvent, isKnownSseEventKind } from "../shared/sseEvents.js";

/**
 * Send SSE event to client
 * Safely handles client disconnections
 */
const ENABLE_SSE_LOGGING = process.env.ENABLE_SSE_LOGGING === 'true';
// W6 · validate SSE payloads in dev mode against the registered Zod schemas.
// Production stays unvalidated for zero overhead; dev catches shape regressions
// at the emit site instead of silently breaking the client.
const VALIDATE_SSE_DEV =
  process.env.NODE_ENV !== "production" && process.env.SSE_VALIDATE !== "0";

// Track when a given response has already been observed as closed so callers
// can short-circuit without every call site having to read a boolean (P-026).
const closedResponses = new WeakSet<Response>();

/** True once sendSSE has observed this response as closed. */
export function isSseClosed(res: Response): boolean {
  if (closedResponses.has(res)) return true;
  if (res.writableEnded || res.destroyed || !res.writable) {
    closedResponses.add(res);
    return true;
  }
  return false;
}

export function sendSSE(res: Response, event: string, data: any): boolean {
  // Check if connection is still writable
  if (isSseClosed(res)) {
    return false;
  }

  // W6 · dev-mode contract validation. Warn-and-pass: if an emit shape drifts,
  // the warning surfaces at the call site so the dev fixes it before the
  // client crashes on parse. Production paths skip the check (zero overhead).
  if (VALIDATE_SSE_DEV && isKnownSseEventKind(event)) {
    const v = validateSseEvent(event, data);
    if (!v.ok) {
      console.warn(
        `⚠️  SSE event '${event}' failed schema validation. ` +
          `Update server/shared/sseEvents.ts or fix the emit site. ` +
          `Error: ${v.error.slice(0, 400)}`
      );
    }
  }

  try {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    res.write(message);
    // Force flush the response (if supported by the platform)
    if (typeof (res as any).flush === 'function') {
      (res as any).flush();
    }
    // Only log in development or when explicitly enabled
    if (ENABLE_SSE_LOGGING || process.env.NODE_ENV === 'development') {
      console.log(`📤 SSE sent: ${event}`, data);
    }
    return true;
  } catch (error: any) {
    // Ignore errors from client disconnections (ECONNRESET, EPIPE are expected)
    if (error.code === 'ECONNRESET' || error.code === 'EPIPE' || error.code === 'ECONNABORTED') {
      closedResponses.add(res);
      return false;
    }
    // Log unexpected errors
    console.error('Error sending SSE event:', error);
    closedResponses.add(res);
    return false;
  }
}

/**
 * Set SSE headers for response
 */
export function setSSEHeaders(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable buffering for nginx
}

/**
 * W10: Start a periodic SSE keepalive comment (": keepalive") to prevent
 * proxies (Vercel, nginx) from closing long-running connections. Returns a
 * stop function; call it when the stream ends.
 *
 * The interval is 15s — well below the 30–60s proxy idle timeout on most platforms.
 */
export function startSseKeepalive(res: Response, intervalMs = 15_000): () => void {
  const timer = setInterval(() => {
    if (isSseClosed(res)) {
      clearInterval(timer);
      return;
    }
    try {
      res.write(': keepalive\n\n');
      if (typeof (res as any).flush === 'function') {
        (res as any).flush();
      }
    } catch {
      clearInterval(timer);
    }
  }, intervalMs);

  return () => clearInterval(timer);
}

