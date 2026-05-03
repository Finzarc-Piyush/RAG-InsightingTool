// Main server file - load server.env first so COSMOS_*, SNOWFLAKE_*, etc. are set before any other imports
import './loadEnv.js';

import {
  assertAgenticRagConfiguration,
  assertDashboardAutogenConfiguration,
} from "./lib/agents/runtime/assertAgenticRag.js";
import express from "express";
import rateLimit from "express-rate-limit";
import { corsConfig } from "./middleware/index.js";
import { requireAzureAdAuth } from "./middleware/azureAdAuth.js";
import { registerRoutes } from "./routes/index.js";
import { startDefaultLlmUsageSink } from "./lib/telemetry/llmUsageSink.js";
import { logDomainContextStartup } from "./lib/domainContext/loadEnabledDomainContext.js";

const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || "50mb";

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
  if (req.method === "OPTIONS" || req.path === "/health") return true;
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

  // Health check endpoint
  app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', message: 'Server is running' });
  });

  // Register all routes (synchronous)
  registerRoutes(app);

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