import { Express, type RequestHandler, type Router } from "express";
import { createServer, type Server } from "http";
import { apiV1Envelope } from "../middleware/apiV1Envelope.js";
import uploadRoutes from "./upload.js";
import chatRoutes from "./chat.js";
import chatManagementRoutes from "./chatManagement.js";
import blobStorageRoutes from "./blobStorage.js";
import sessionRoutes from "./sessions.js";
import dataRetrievalRoutes from "./dataRetrieval.js";
import dashboardRoutes from "./dashboards.js";
import sharedAnalysisRoutes from "./sharedAnalyses.js";
import sharedDashboardRoutes from "./sharedDashboards.js";
import dataOpsRoutes from "./dataOps.js";
import dataApiRoutes from "./dataApi.js";
import snowflakeRoutes from "./snowflake.js";
import feedbackRoutes from "./feedback.js";
import adminRoutes from "./admin.js";
import superadminRoutes from "./superadmin.js";
import automationRoutes from "./automations.js";
import refreshRoutes from "./refresh.js";
import pastAnalysesRoutes from "./pastAnalyses.js";
import insightRegenRoutes from "./insightRegen.js";
import telemetryRoutes from "./telemetry.js";
import clientErrorRoutes from "./clientError.js";

export function registerRoutes(app: Express): Server | void {
  // Register route modules. API-7(a) · every module is mounted under BOTH the
  // unversioned `/api` prefix (what the in-repo client uses today — never
  // removed) AND a `/api/v1` alias so external consumers can pin a version.
  // The two prefixes resolve to the same handlers, so behaviour is identical.
  const mount = (path: string, ...handlers: (RequestHandler | Router)[]) => {
    app.use(`/api${path}`, ...handlers);
    app.use(`/api/v1${path}`, ...handlers);
  };

  // API-4 · the `/api/v1` alias gets the standard response envelope from
  // `lib/responseEnvelope.ts` (success → `{ data }`, error → `{ error: {…} }`),
  // applied by monkeypatching `res.json` for v1 requests only. The unversioned
  // `/api` responses stay byte-identical (the in-repo client depends on them).
  // Mounted under the v1 prefix BEFORE the routers so it runs first and only
  // for v1 paths.
  app.use('/api/v1', apiV1Envelope);

  mount('', uploadRoutes);
  mount('', snowflakeRoutes);
  mount('', chatRoutes);
  mount('', chatManagementRoutes);
  mount('', blobStorageRoutes);
  mount('', sessionRoutes);
  mount('/data', dataRetrievalRoutes);
  mount('', dashboardRoutes);
  mount('', sharedAnalysisRoutes);
  mount('', sharedDashboardRoutes);
  mount('', dataOpsRoutes);
  mount('/data', dataApiRoutes);
  mount('', feedbackRoutes);
  mount('', adminRoutes);
  mount('', superadminRoutes);
  mount('', automationRoutes);
  mount('', refreshRoutes);
  mount('', pastAnalysesRoutes);
  mount('', insightRegenRoutes);
  mount('', telemetryRoutes);
  mount('', clientErrorRoutes);

  // For Vercel, we don't need to create HTTP server
  if (process.env.VERCEL) {
    return;
  }
  
  // For local development, create HTTP server
  const httpServer = createServer(app);
  return httpServer;
}
