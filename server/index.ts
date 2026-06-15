// Main server file - load server.env first so COSMOS_*, SNOWFLAKE_*, etc. are set before any other imports
import './loadEnv.js';

// Wave R23 · initialise crash reporting before anything else can throw (no-op
// unless @sentry/node is installed AND SENTRY_DSN is set).
import { initCrashReporter, captureException } from './lib/observability/crashReporter.js';
void initCrashReporter();

import {
  assertAgenticRagConfiguration,
  assertDashboardAutogenConfiguration,
} from "./lib/agents/runtime/assertAgenticRag.js";
import express from "express";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import { ZodError } from "zod";
import { assertRequiredEnv } from "./config/env.js";
import { requestLogger } from "./middleware/requestLogger.js";
import { corsConfig } from "./middleware/index.js";
import { requireAzureAdAuth } from "./middleware/azureAdAuth.js";
import { registerRoutes } from "./routes/index.js";
import { startDefaultLlmUsageSink } from "./lib/telemetry/llmUsageSink.js";
import { logDomainContextStartup } from "./lib/domainContext/loadEnabledDomainContext.js";

const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || "50mb";

// Wave R4 · process-level safety net. Without these, an unhandled promise
// rejection or uncaught exception crashes the Node process with only the
// default (unstructured) trace — and in newer Node an unhandled rejection
// terminates the process outright. Log with a stable prefix so alerting can
// match; on a truly uncaught exception the process state is undefined, so exit
// and let the platform restart it cleanly (skipped on Vercel, which owns the
// serverless lifecycle and where exit() would tear down the whole instance).
process.on("unhandledRejection", (reason: unknown) => {
  const msg =
    reason instanceof Error ? `${reason.message}\n${reason.stack ?? ""}` : String(reason);
  console.error("[unhandledRejection]", msg);
  captureException(reason, { source: "unhandledRejection" });
});
process.on("uncaughtException", (err: unknown) => {
  const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
  console.error("[uncaughtException]", msg);
  captureException(err, { source: "uncaughtException" });
  if (!process.env.VERCEL) process.exit(1);
});

// RL2 · `chart-preview`, `chart-key-insight`, and the `/pivot/*` family are
// intrinsically pacing-controlled: a 500 ms client debounce on the
// chart-preview effect, a per-session mutex on the chart-key-insight handler,
// and the pivot endpoints are pure data shaping (no LLM cost). During a
// dashboard build the agent emits ~14 chart bubbles whose effects each fire
// chart-preview + chart-key-insight + pivot/preview + pivot/fields within the
// same window — counting these against the coarse 400/15-min global limiter
// caused user-visible 429s without protecting anything (the real cost is the
// downstream LLM call, which the per-session mutex already serialises).
// Excluding these paths lets dashboard / pivot work finish without cascades.
const RATE_LIMIT_EXEMPT_SUFFIXES: ReadonlyArray<string> = [
  "/chart-preview",
  "/chart-key-insight",
  "/pivot/preview",
  "/pivot/query",
  "/pivot/fields",
  "/pivot/drillthrough",
];

function isExemptFromRateLimit(req: import("express").Request): boolean {
  if (req.method === "OPTIONS" || req.path === "/health" || req.path === "/ready") return true;
  return RATE_LIMIT_EXEMPT_SUFFIXES.some((suffix) => req.path.endsWith(suffix));
}

const apiRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.API_RATE_LIMIT_MAX || 400),
  standardHeaders: true,
  legacyHeaders: false,
  skip: isExemptFromRateLimit,
});

// P-031: Tight per-IP limiter dedicated to pre-auth paths. Unauthenticated
// token-verify attempts force JWKS cache lookups; a noisy client can thrash
// Azure AD round-trips. RL2-followup: this limiter was previously enforced
// for every /api/* request — authenticated or not — at 20/min. Multi-chart
// dashboard turns + pivot work easily blew past 20 in seconds, surfacing 429
// to the user even though the limiter's stated purpose was protecting JWKS.
// Now skip when (a) the path is one of the known-safe high-traffic
// suffixes, or (b) the request carries a Bearer token (auth middleware
// downstream still validates it; failed validations are caught by the
// downstream limiter — the JWKS cache-miss attack vector requires *no* token
// or a structurally invalid one, which we still throttle).
const AUTH_PREFLIGHT_BURST = Number(process.env.AUTH_PREFLIGHT_BURST || 60);
const authPreflightLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: AUTH_PREFLIGHT_BURST,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    if (isExemptFromRateLimit(req)) return true;
    const auth = req.headers.authorization;
    if (typeof auth === "string" && /^Bearer\s+\S{20,}/.test(auth)) return true;
    return false;
  },
});

// Factory function to create the Express app
export function createApp() {
  // CFG-1 · fail fast on a misconfigured credential cluster (prod) / warn (dev),
  // before lazy per-subsystem failures can surface mid-request.
  assertRequiredEnv();
  assertAgenticRagConfiguration();
  assertDashboardAutogenConfiguration();
  // W1.3 · subscribe the telemetry sink to the LLM usage emitter. Idempotent;
  // no-op when LLM_USAGE_TELEMETRY_ENABLED=false.
  startDefaultLlmUsageSink();
  // WD7 · log enabled domain-context packs at boot (best-effort; never blocks)
  void logDomainContextStartup();
  const app = express();
  if (process.env.TRUST_PROXY === "true" || process.env.VERCEL) {
    app.set("trust proxy", 1);
  }

  // Wave R5 · security headers (OWASP A05 / ASVS V14.4). HSTS, X-Content-Type-
  // Options: nosniff, X-Frame-Options, X-DNS-Prefetch-Control, and drops the
  // X-Powered-By banner. CSP is disabled here — this tier serves JSON/SSE, not
  // HTML, so a response CSP is pointless and risks interfering; the SPA sets
  // its own. CORP is set cross-origin so the separate-origin SPA can still read
  // responses (access is governed by CORS).
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: "cross-origin" },
      crossOriginEmbedderPolicy: false,
    })
  );

  // EX11 / PERF-6 · compress JSON API responses (gzip/deflate). Skips SSE
  // streams — text/event-stream must not be buffered/coalesced — and honours an
  // explicit `x-no-compression` opt-out. Large analytical envelopes and session
  // lists shrink substantially on the wire.
  app.use(
    compression({
      filter: (req, res) => {
        if (req.headers["x-no-compression"]) return false;
        const contentType = String(res.getHeader("Content-Type") || "");
        if (contentType.includes("text/event-stream")) return false;
        return compression.filter(req, res);
      },
    })
  );

  // OBS-5 · per-request access log (one structured line on response finish).
  // Early, so 401s/preflights are captured; reads req.auth at finish-time.
  app.use(requestLogger);

  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  app.use(express.urlencoded({ extended: false, limit: JSON_BODY_LIMIT }));

  // Handle preflight requests explicitly
  app.options('*', corsConfig);

  app.use(corsConfig);

  app.use("/api", apiRateLimiter);
  // Pre-auth throttle runs BEFORE Azure AD verification so failed-token attempts
  // are rate-limited even when they never pass auth (P-031).
  app.use("/api", authPreflightLimiter);
  app.use("/api", requireAzureAdAuth);

  // Liveness probe — process is up (no dependency checks; stays fast + always
  // 200 so load balancers never evict a healthy-but-degraded instance).
  app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', message: 'Server is running' });
  });

  // Wave R21 · Readiness probe — verifies the CRITICAL dependencies (Cosmos +
  // Blob) are actually reachable, returning 503 until they are. A blue/green
  // or rolling deploy can gate traffic on this so requests aren't routed to an
  // instance that can't serve them yet. Cheap (1 attempt, short timeout) and
  // auth/rate-limit exempt.
  app.get('/api/ready', async (req, res) => {
    const checks: Record<string, boolean> = { cosmos: false, blob: false };
    try {
      const { waitForContainer } = await import('./models/database.config.js');
      await waitForContainer(1, 100);
      checks.cosmos = true;
    } catch {
      /* dependency not ready */
    }
    try {
      const { ensureBlobStorageReady } = await import('./lib/blobStorage.js');
      await ensureBlobStorageReady();
      checks.blob = true;
    } catch {
      /* dependency not ready */
    }
    const ready = checks.cosmos && checks.blob;
    res.status(ready ? 200 : 503).json({ ready, checks, timestamp: Date.now() });
  });

  // Wave R20 · SSE ticket exchange. EventSource cannot send an Authorization
  // header, so rather than leak the raw JWT via ?access_token (proxy/CDN logs),
  // the client POSTs here Bearer-auth'd (requireAzureAdAuth ran above) and gets
  // a short-lived opaque ticket to open the stream with ?sse_ticket=<ticket>.
  app.post('/api/auth/sse-ticket', async (req, res) => {
    const email = req.auth?.email;
    if (!email) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const { mintSseTicket } = await import('./lib/sseTicket.js');
    const { ticket, expiresInSeconds } = mintSseTicket({ email, oid: req.auth?.oid });
    res.json({ ticket, expiresInSeconds });
  });

  // Register all routes (synchronous)
  registerRoutes(app);

  // Wave R23 · terminal error handler — forward to Sentry (when active) and
  // return a generic 500 without leaking internals. Registered AFTER all routes
  // so thrown errors / next(err) from any handler land here.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // EX15 / API-1 · A failed input validation is a CLIENT error (400), not a
    // 500. Map a Zod parse failure to 400 + the flattened field errors so the
    // caller can fix the request instead of seeing an opaque server error.
    if (err instanceof ZodError) {
      console.warn("[express-validation]", err.message);
      if (!res.headersSent) {
        res.status(400).json({ error: "Invalid request", details: err.flatten() });
      }
      return;
    }
    // EX15 / API-5 · Honour an explicit 4xx status tagged on the error (e.g.
    // the 403 thrown by getChatBySessionIdForUser) instead of mislabelling it
    // 500. The message is caller-safe for intentional 4xx; 5xx stays generic.
    const tagged = (err as { statusCode?: unknown } | null)?.statusCode;
    if (typeof tagged === "number" && tagged >= 400 && tagged < 500) {
      if (!res.headersSent) {
        res.status(tagged).json({ error: err instanceof Error ? err.message : "Request failed" });
      }
      return;
    }
    const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
    console.error("[express-error]", msg);
    captureException(err, { source: "express" });
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Initialize optional services in background (non-blocking)
  // These are optional, so we don't wait for them
  // Use dynamic imports to avoid breaking if packages aren't available
  Promise.all([
    import("./models/index.js").then(m => m.initializeCosmosDB()).catch((error) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.warn("⚠️ CosmosDB initialization failed on startup, will retry on first use:", errorMessage);
      console.warn("   Make sure COSMOS_ENDPOINT and COSMOS_KEY are set in your environment variables");
    }),
    import("./lib/blobStorage.js").then(m => m.initializeBlobStorage()).catch((error) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.warn("⚠️ Azure Blob Storage initialization failed, continuing without it:", errorMessage);
    }),
    import("./lib/snowflakeService.js").then(m => m.verifySnowflakeConnection()).then((result) => {
      if (result.ok) {
        console.log("✅ Snowflake: connected at startup");
      } else {
        console.warn("⚠️ Snowflake: connection at startup failed:", result.message || "Unknown error");
        console.warn("   Set SNOWFLAKE_ACCOUNT, SNOWFLAKE_USERNAME, SNOWFLAKE_PASSWORD, SNOWFLAKE_WAREHOUSE in server.env to enable Import from Snowflake");
      }
    }).catch((error) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.warn("⚠️ Snowflake: startup check failed, continuing without it:", errorMessage);
    }),
    import("./lib/columnarStorage.js").then(m => m.initDuckDBEager()).catch(() => {})
  ]).catch(() => {
    // Ignore - services are optional
  });

  return app;
}

// For local: create and start server
if (!process.env.VERCEL) {
  (async () => {
    try {
      const app = createApp();
      const { createServer } = await import("http");
      const server = createServer(app);
      const port = process.env.PORT || 3002;
      server.listen(port, () => {
        console.log(`Server running on port ${port}`);
      });
    } catch (error) {
      console.error("Failed to start server:", error);
      process.exit(1);
    }
  })();
}

// No default export needed - createApp is used directly by api/index.ts