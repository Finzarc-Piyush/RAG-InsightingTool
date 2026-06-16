/**
 * OBS-6 · Client error sink.
 *
 * A best-effort, fire-and-forget reporter that POSTs uncaught client errors to
 * the server's `POST /api/client-error` endpoint so they land in the structured
 * server logs (and thus on-call dashboards), rather than dying silently in the
 * browser console. Wired from:
 *   - `ErrorBoundary.componentDidCatch` (React render-tree crashes), and
 *   - the global `window` `error` / `unhandledrejection` listeners in `main.tsx`.
 *
 * Invariants:
 * - **Never throws** — error reporting must NEVER cascade into another error
 *   (which would loop a global handler). All failures (network, non-2xx,
 *   serialization) are swallowed.
 * - **Throttled + capped** — a per-session counter caps the total number of
 *   reports, and a short time-window throttle drops bursts. A render loop or a
 *   storm of `unhandledrejection`s therefore can't DoS the endpoint or the user.
 * - **SSR-safe** — no-op when `fetch` is unavailable.
 * - **Correlation** — attaches a correlation id when one is discoverable on
 *   `window` (an SSE `lastEventId` or any `traceId` a future seam parks there)
 *   plus `location.pathname` as the route, so a server log line can be tied
 *   back to the turn/route that produced the crash.
 */

export interface ClientErrorReport {
  message: string;
  stack?: string;
  /** Where the error originated, e.g. "ErrorBoundary", "window.onerror". */
  source?: string;
  /** Defaults to `location.pathname` when omitted. */
  route?: string;
}

// Hard cap on reports per page session — a render loop must not flood the sink.
const MAX_REPORTS_PER_SESSION = 20;
// Minimum gap between reports; bursts inside the window are dropped.
const THROTTLE_MS = 1000;
// Cap on the serialized stack to keep the payload (and server log line) bounded.
const MAX_STACK_LEN = 4000;
const MAX_MESSAGE_LEN = 1000;

let reportCount = 0;
let lastReportAt = 0;

/**
 * Best-effort lookup of a correlation id. We don't own the SSE plumbing here, so
 * we probe well-known parking spots a request/stream layer may have set:
 *   - `window.__lastEventId` (last SSE `lastEventId` seen), or
 *   - `window.__traceId` (any per-request trace id parked by the API layer).
 * Returns `undefined` when nothing is available — never throws.
 */
function resolveCorrelationId(): string | undefined {
  try {
    const w = window as unknown as {
      __lastEventId?: unknown;
      __traceId?: unknown;
    };
    const candidate = w.__traceId ?? w.__lastEventId;
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  } catch {
    // Accessing window props must never break reporting.
  }
  return undefined;
}

function truncate(value: string | undefined, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Report a client error to the server. Fire-and-forget: callers do NOT await,
 * and the promise it returns always resolves (never rejects).
 */
export async function reportClientError(report: ClientErrorReport): Promise<void> {
  if (typeof fetch === "undefined") return;

  // Throttle + cap. Both guards protect against handler loops.
  if (reportCount >= MAX_REPORTS_PER_SESSION) return;
  const now = Date.now();
  if (now - lastReportAt < THROTTLE_MS) return;
  lastReportAt = now;
  reportCount += 1;

  try {
    const message = truncate(report.message, MAX_MESSAGE_LEN) || "Unknown client error";
    const stack = truncate(report.stack, MAX_STACK_LEN);
    const route =
      report.route ||
      (typeof location !== "undefined" ? location.pathname : undefined);
    const correlationId = resolveCorrelationId();

    const body: Record<string, unknown> = { message };
    if (stack) body.stack = stack;
    if (report.source) body.source = report.source;
    if (route) body.route = route;
    if (correlationId) body.correlationId = correlationId;

    await fetch("/api/client-error", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      // Allow the report to complete even if the page is unloading.
      keepalive: true,
    });
  } catch {
    // Error reporting must never throw — that would loop the global handler.
  }
}
