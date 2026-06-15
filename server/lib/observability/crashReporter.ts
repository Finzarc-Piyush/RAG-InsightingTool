import { logger } from "../logger.js";
import { errorMessage } from "../../utils/errorMessage.js";
/**
 * Wave R23 · Crash reporting hook.
 *
 * Sends unhandled errors to Sentry WHEN `@sentry/node` is installed and
 * `SENTRY_DSN` is set; otherwise it is a clean no-op and the caller's existing
 * structured `console.error` is the sink (an external log drain / Sentry MCP can
 * ingest those). `@sentry/node` is intentionally NOT a hard dependency: it is
 * heavy, a no-op without a DSN, and forcing it would enlarge the audit surface
 * (the supply-chain gate now blocks on high+ vulns) for a feature many deploys
 * won't enable.
 *
 * To enable direct Sentry capture: `npm i @sentry/node` in server/ and set
 * SENTRY_DSN (optionally SENTRY_TRACES_SAMPLE_RATE).
 */
interface SentryLike {
  init: (opts: Record<string, unknown>) => void;
  captureException: (e: unknown, hint?: unknown) => void;
  captureMessage: (m: string, level?: string) => void;
}

let sentry: SentryLike | null = null;
let initialized = false;

/** Initialise Sentry if @sentry/node + SENTRY_DSN are both present. */
export async function initCrashReporter(): Promise<void> {
  if (initialized) return;
  initialized = true;
  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn) return; // structured-log fallback only

  try {
    // Non-literal specifier so TS/bundler treat it as a runtime-optional import.
    const moduleName = "@sentry/node";
    const mod = (await import(moduleName)) as unknown as SentryLike;
    mod.init({
      dsn,
      environment: process.env.NODE_ENV || "development",
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0),
    });
    sentry = mod;
    logger.log("✅ Sentry crash reporting initialised");
  } catch (err) {
    const msg = errorMessage(err);
    logger.warn(
      `⚠️ SENTRY_DSN is set but @sentry/node could not load (run \`npm i @sentry/node\`): ${msg}`,
    );
  }
}

/** True once Sentry is live (for tests / conditional wiring). */
export function isCrashReporterActive(): boolean {
  return sentry !== null;
}

/**
 * Forward an exception to Sentry when active. Never throws and never logs — the
 * caller owns its own structured console.error so there is no double-logging
 * and existing alert prefixes ([unhandledRejection] etc.) are preserved.
 */
export function captureException(err: unknown, context?: Record<string, unknown>): void {
  if (!sentry) return;
  try {
    sentry.captureException(err, context ? { extra: context } : undefined);
  } catch {
    /* never let crash reporting cause a crash */
  }
}

/** Forward a message-level event (e.g. a cost anomaly) to Sentry when active. */
export function captureMessage(
  message: string,
  level: "info" | "warning" | "error" = "error",
): void {
  if (!sentry) return;
  try {
    sentry.captureMessage(message, level);
  } catch {
    /* ignore */
  }
}

/** Test-only · reset the module's init latch + handle. */
export function __resetCrashReporterForTesting(): void {
  sentry = null;
  initialized = false;
}
