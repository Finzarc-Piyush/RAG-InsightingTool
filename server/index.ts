// Main server file - load server.env first so COSMOS_*, SNOWFLAKE_*, etc. are set before any other imports
import './loadEnv.js';

import { assertAgenticRagConfiguration } from "./lib/agents/runtime/assertAgenticRag.js";
import express from "express";
import rateLimit from "express-rate-limit";
import { corsConfig } from "./middleware/index.js";
import { requireAzureAdAuth } from "./middleware/azureAdAuth.js";
import { registerRoutes } from "./routes/index.js";

const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || "50mb";

const apiRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.API_RATE_LIMIT_MAX || 400),
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === "OPTIONS" || req.path === "/health",
});

// Factory function to create the Express app
export function createApp() {
  assertAgenticRagConfiguration();
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
    })
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
      const port = process.env.PORT || 3003;
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