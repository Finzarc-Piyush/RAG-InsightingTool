import { randomUUID } from "crypto";
import { Request, Response } from "express";
import { requireUsername, AuthenticationError } from "../utils/auth.helper.js";
import {
  getAllSessions,
  getAllSessionsPaginated,
  getSessionsWithFilters,
  getSessionStatistics,
  getChatBySessionIdForUser,
  deleteSessionBySessionId,
  updateSessionFileName,
  updateSessionPinned,
  updateSessionPermanentContext,
  ChatDocument
} from "../models/chat.model.js";
import {
  listActiveDirectives,
  revokeDirective,
  getDatasetDirectivesDoc,
} from "../models/datasetDirectives.model.js";
import { loadChartsFromBlob } from "../lib/blobStorage.js";
import { listPastAnalysesForSession } from "../models/pastAnalysis.model.js";
import { loadLatestData } from "../utils/dataLoader.js";
import { uploadLimits } from "../config/uploadLimits.js";
import { buildRichDataSummary } from "../lib/richColumnProfile.js";
import {
  chartSpecSchema,
  dateTimeColumnPairSchema,
  dimensionHierarchySchema,
  pivotStateSchema,
  type ChartSpec,
  type DataSummary,
} from "../shared/schema.js";
import { z } from "zod";
import {
  updateSessionDimensionHierarchies,
  updateSessionSchemaAnnotations,
} from "../lib/sessionAnalysisContext.js";
import { updateChatDocument } from "../models/chat.model.js";
import { processChartData } from "../lib/chartGenerator.js";
import {
  calculateSmartDomainsForChart,
  multiSeriesYDomainKind,
  yDomainForMultiSeriesRows,
} from "../lib/axisScaling.js";
import { filterRowsByPivotSelections } from "../lib/pivotRowFilters.js";
import { tryProcessChartDataFromPivotQuery } from "../lib/chartPreviewFromPivot.js";
import {
  deriveSeriesKeysFromWideDataRow,
  seriesKeysPatchesFromProcessedSpec,
} from "../lib/ensureChartSpecSeriesKeys.js";
import { compileChartSpec } from "../lib/chartSpecCompiler.js";
import { emptySessionAnalysisContext } from "../lib/sessionAnalysisContext.js";
import { generateChartInsights } from "../lib/insightGenerator.js";
import { logger } from "../lib/logger.js";

const CHART_KEY_INSIGHT_MAX_ROWS = 800;

function normalizeDataSummaryForLocalStats(ds: DataSummary): DataSummary {
  return {
    ...ds,
    columns: ds.columns ?? [],
    numericColumns: ds.numericColumns ?? [],
    dateColumns: ds.dateColumns ?? [],
  };
}

// Get all sessions
export const getAllSessionsEndpoint = async (req: Request, res: Response) => {
  try {
    const username = requireUsername(req);

    const sessions = await getAllSessions(username);
    
    // Return simplified session list for better performance
    const sessionList = sessions.map((session) => ({
      id: session.id,
      username: session.username,
      fileName: session.fileName,
      uploadedAt: session.uploadedAt,
      createdAt: session.createdAt,
      lastUpdatedAt: session.lastUpdatedAt,
      collaborators: session.collaborators || [session.username],
      messageCount: session.messageCount,
      chartCount: session.chartCount,
      sessionId: session.sessionId,
    }));

    res.json({ 
      sessions: sessionList, 
      count: sessionList.length,
      message: `Retrieved ${sessionList.length} sessions for user: ${username}`
    });
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return res.status(401).json({ error: error.message });
    }
    logger.error('Get all sessions error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to fetch all sessions';
    
    // Check if it's a CosmosDB initialization error
    if (errorMessage.includes('not initialized')) {
      return res.status(503).json({
        error: 'Database is initializing. Please try again in a moment.',
        retryAfter: 2
      });
    }
    
    res.status(500).json({
      error: errorMessage,
    });
  }
};

// Get sessions with pagination
export const getSessionsPaginatedEndpoint = async (req: Request, res: Response) => {
  try {
    const pageSize = parseInt(req.query.pageSize as string) || 10;
    const continuationToken = req.query.continuationToken as string;
    
    const username = requireUsername(req);

    const result = await getAllSessionsPaginated(pageSize, continuationToken, username);
    
    // Return simplified session list
    const sessionList = result.sessions.map((session) => ({
      id: session.id,
      username: session.username,
      fileName: session.fileName,
      uploadedAt: session.uploadedAt,
      createdAt: session.createdAt,
      lastUpdatedAt: session.lastUpdatedAt,
      collaborators: session.collaborators || [session.username],
      messageCount: session.messageCount,
      chartCount: session.chartCount,
      sessionId: session.sessionId,
    }));

    res.json({
      sessions: sessionList,
      count: sessionList.length,
      continuationToken: result.continuationToken,
      hasMoreResults: result.hasMoreResults,
      pageSize,
      message: `Retrieved ${sessionList.length} sessions (page size: ${pageSize}) for user: ${username}`
    });
  } catch (error) {
    if (error instanceof AuthenticationError) {
      res.status(401).json({ error: error.message });
      return;
    }
    logger.error('Get paginated sessions error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to fetch paginated sessions',
    });
  }
};

// Get sessions with filters
export const getSessionsFilteredEndpoint = async (req: Request, res: Response) => {
  try {
    const authed = requireUsername(req);
    const {
      fileName,
      dateFrom,
      dateTo,
      limit,
      orderBy,
      orderDirection
    } = req.query;

    const options: {
      username?: string;
      fileName?: string;
      dateFrom?: number;
      dateTo?: number;
      limit?: number;
      orderBy?: 'createdAt' | 'lastUpdatedAt' | 'uploadedAt';
      orderDirection?: 'ASC' | 'DESC';
    } = {};

    options.username = authed;
    if (fileName) options.fileName = fileName as string;
    if (dateFrom) options.dateFrom = parseInt(dateFrom as string);
    if (dateTo) options.dateTo = parseInt(dateTo as string);
    if (limit) options.limit = parseInt(limit as string);
    if (orderBy) options.orderBy = orderBy as 'createdAt' | 'lastUpdatedAt' | 'uploadedAt';
    if (orderDirection) options.orderDirection = orderDirection as 'ASC' | 'DESC';

    const sessions = await getSessionsWithFilters(options);
    
    // Return simplified session list
    const sessionList = sessions.map((session) => ({
      id: session.id,
      username: session.username,
      fileName: session.fileName,
      uploadedAt: session.uploadedAt,
      createdAt: session.createdAt,
      lastUpdatedAt: session.lastUpdatedAt,
      collaborators: session.collaborators || [session.username],
      messageCount: session.messages.length,
      chartCount: session.charts.length,
      sessionId: session.sessionId,
    }));

    res.json({
      sessions: sessionList,
      count: sessionList.length,
      filters: options,
      message: `Retrieved ${sessionList.length} sessions with filters`
    });
  } catch (error) {
    if (error instanceof AuthenticationError) {
      res.status(401).json({ error: error.message });
      return;
    }
    logger.error('Get filtered sessions error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to fetch filtered sessions',
    });
  }
};

// Get session statistics
export const getSessionStatisticsEndpoint = async (req: Request, res: Response) => {
  try {
    requireUsername(req);
    const stats = await getSessionStatistics();
    
    res.json({
      statistics: stats,
      message: `Generated statistics for ${stats.totalSessions} sessions`
    });
  } catch (error) {
    if (error instanceof AuthenticationError) {
      res.status(401).json({ error: error.message });
      return;
    }
    logger.error('Get session statistics error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to fetch session statistics',
    });
  }
};

// Get detailed session by session ID (efficient)
export const getSessionDetailsEndpoint = async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const normalizedRequesterEmail = requireUsername(req);
    
    if (!sessionId) {
      return res.status(400).json({ error: 'Session ID is required' });
    }

    // Get session directly from CosmosDB by session ID with access check
    try {
      const session = await getChatBySessionIdForUser(sessionId, normalizedRequesterEmail);
      
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Load charts from blob storage if they're stored there
      let chartsWithData = session.charts || [];
      if (session.chartReferences && session.chartReferences.length > 0) {
        try {
          const chartsFromBlob = await loadChartsFromBlob(session.chartReferences);
          // Merge charts from blob with charts in CosmosDB (charts in CosmosDB may have metadata only)
          // Use charts from blob if available, otherwise use charts from CosmosDB
          if (chartsFromBlob.length > 0) {
            chartsWithData = chartsFromBlob;
            logger.log(`✅ Loaded ${chartsFromBlob.length} charts from blob storage`);
          }
        } catch (blobError) {
          logger.error('⚠️ Failed to load charts from blob, using charts from CosmosDB:', blobError);
          // Continue with charts from CosmosDB (may not have data arrays)
        }
      }

      // Build a lookup map: chart title+type -> full chart with data
      // This allows us to enrich message charts with data from top-level charts
      const chartLookup = new Map<string, any>();
      chartsWithData.forEach(chart => {
        if (chart.title && chart.type) {
          const key = `${chart.type}::${chart.title}`;
          chartLookup.set(key, chart);
        }
      });

      // Also check charts in CosmosDB that might have data (for small charts not in blob)
      (session.charts || []).forEach(chart => {
        if (chart.title && chart.type && chart.data) {
          const key = `${chart.type}::${chart.title}`;
          if (!chartLookup.has(key)) {
            chartLookup.set(key, chart);
          }
        }
      });

      // Enrich message charts with data from top-level charts
      const enrichedMessages = (session.messages || []).map(msg => {
        if (!msg.charts || msg.charts.length === 0) {
          return msg;
        }

        const enrichedCharts = msg.charts.map(chart => {
          const key = `${chart.type}::${chart.title}`;
          const fullChart = chartLookup.get(key);
          
          if (fullChart && fullChart.data) {
            // Merge metadata from message chart with data from top-level chart
            return {
              ...chart,
              data: fullChart.data,
              trendLine: fullChart.trendLine,
              xDomain: fullChart.xDomain,
              yDomain: fullChart.yDomain,
            };
          }
          
          // If no match found, return chart as-is (might have data already or be a small chart)
          return chart;
        });

        return {
          ...msg,
          charts: enrichedCharts,
        };
      });

      logger.log(`✅ Enriched ${enrichedMessages.length} messages with chart data`);

      // Hydrate per-turn feedback (answer-level + granular target details) onto
      // assistant messages so the thumbs render the persisted state on reload.
      // Best-effort: a Cosmos hiccup here downgrades to "no thumbs hydration"
      // rather than failing the whole session load.
      let pastAnalysesByTurn = new Map<
        string,
        { feedback: "up" | "down" | "none"; feedbackComment?: string; feedbackDetails: import("../shared/schema.js").PastAnalysisFeedbackDetail[] }
      >();
      try {
        const past = await listPastAnalysesForSession(sessionId, 200);
        pastAnalysesByTurn = new Map(
          past.map((p) => [
            p.turnId,
            {
              feedback: p.feedback,
              feedbackComment: p.feedbackComment,
              feedbackDetails: p.feedbackDetails ?? [],
            },
          ])
        );
      } catch (err) {
        logger.warn(
          `⚠️ feedback hydration failed for session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      const messagesWithFeedback = enrichedMessages.map((msg) => {
        const turnId = (msg as { agentTrace?: { turnId?: string } } | undefined)?.agentTrace?.turnId;
        if (!turnId) return msg;
        const past = pastAnalysesByTurn.get(turnId);
        if (!past) return msg;
        return {
          ...msg,
          feedback: past.feedback,
          feedbackComment: past.feedbackComment,
          feedbackDetails: past.feedbackDetails,
        };
      });

      // Return session with charts loaded from blob and messages enriched with chart data
      const sessionWithCharts = {
        ...session,
        charts: chartsWithData,
        messages: messagesWithFeedback,
        datasetProfile: session.datasetProfile || {
          shortDescription: "",
          dateColumns: [],
          suggestedQuestions: [],
        },
        sessionAnalysisContext: session.sessionAnalysisContext || emptySessionAnalysisContext(),
        permanentContext: typeof session.permanentContext === "string" ? session.permanentContext : "",
      };

      res.json({
        session: sessionWithCharts,
        message: `Retrieved session details for ${sessionId}`
      });
    } catch (accessError: any) {
      // Handle authorization errors separately
      if (accessError?.statusCode === 403) {
        logger.warn(`⚠️ Unauthorized access attempt: ${normalizedRequesterEmail} tried to access session ${sessionId}`);
        return res.status(403).json({ 
          error: 'Unauthorized to access this session',
          message: 'You do not have permission to access this session'
        });
      }
      // Re-throw if it's not an authorization error
      throw accessError;
    }
  } catch (error) {
    if (error instanceof AuthenticationError) {
      res.status(401).json({ error: error.message });
      return;
    }
    logger.error('Get session details error:', error);
    const statusCode = (error as any)?.statusCode || 500;
    res.status(statusCode).json({
      error: error instanceof Error ? error.message : 'Failed to fetch session details',
    });
  }
};

// Get sessions by user
export const getSessionsByUserEndpoint = async (req: Request, res: Response) => {
  try {
    const authed = requireUsername(req);
    const { username } = req.params;
    const pathUser = decodeURIComponent(username || "").trim().toLowerCase();
    
    if (!pathUser) {
      return res.status(400).json({ error: 'Username is required' });
    }
    if (pathUser !== authed) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const sessions = await getSessionsWithFilters({ username: pathUser });
    
    // Return simplified session list
    const sessionList = sessions.map((session) => ({
      id: session.id,
      username: session.username,
      fileName: session.fileName,
      uploadedAt: session.uploadedAt,
      createdAt: session.createdAt,
      lastUpdatedAt: session.lastUpdatedAt,
      collaborators: session.collaborators || [session.username],
      messageCount: session.messages.length,
      chartCount: session.charts.length,
      sessionId: session.sessionId,
    }));

    res.json({
      sessions: sessionList,
      count: sessionList.length,
      username,
      message: `Retrieved ${sessionList.length} sessions for user ${username}`
    });
  } catch (error) {
    if (error instanceof AuthenticationError) {
      res.status(401).json({ error: error.message });
      return;
    }
    logger.error('Get sessions by user error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to fetch sessions by user',
    });
  }
};

// Update session fileName and/or pinned flag by session ID. Either or both may
// be supplied in the request body; at least one is required.
export const updateSessionNameEndpoint = async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const { fileName, pinned } = req.body ?? {};

    if (!sessionId) {
      return res.status(400).json({ error: 'Session ID is required' });
    }

    const hasFileName = typeof fileName === 'string';
    const hasPinned = typeof pinned === 'boolean';

    if (!hasFileName && !hasPinned) {
      return res.status(400).json({ error: 'fileName or pinned is required' });
    }

    if (hasFileName && fileName.trim().length === 0) {
      return res.status(400).json({ error: 'File name cannot be empty' });
    }

    const username = requireUsername(req);

    let updatedSession;
    if (hasFileName) {
      updatedSession = await updateSessionFileName(sessionId, username, fileName.trim());
    }
    if (hasPinned) {
      updatedSession = await updateSessionPinned(sessionId, username, pinned);
    }

    if (!updatedSession) {
      return res.status(400).json({ error: 'No fields updated' });
    }

    res.json({
      success: true,
      message: `Session updated successfully`,
      session: {
        id: updatedSession.id,
        sessionId: updatedSession.sessionId,
        fileName: updatedSession.fileName,
        lastUpdatedAt: updatedSession.lastUpdatedAt,
        pinned: updatedSession.pinned ?? false,
        pinnedAt: updatedSession.pinnedAt,
      }
    });
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return res.status(401).json({ error: error.message });
    }
    logger.error('Update session name error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to update session name';
    
    // Check if it's a "not found" error
    if (errorMessage.includes('not found') || errorMessage.includes('Session not found')) {
      return res.status(404).json({
        error: errorMessage
      });
    }
    
    // Check if it's an unauthorized error
    if (errorMessage.includes('Unauthorized')) {
      return res.status(403).json({
        error: errorMessage
      });
    }
    
    // Check if it's a CosmosDB initialization error
    if (errorMessage.includes('not initialized')) {
      return res.status(503).json({
        error: 'Database is initializing. Please try again in a moment.',
        retryAfter: 2
      });
    }
    
    res.status(500).json({
      error: errorMessage
    });
  }
};

// Update session permanent context by session ID
export const updateSessionContextEndpoint = async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const { permanentContext } = req.body;
    
    if (!sessionId) {
      return res.status(400).json({ error: 'Session ID is required' });
    }
    
    if (permanentContext === undefined || (typeof permanentContext !== 'string' && permanentContext !== null)) {
      return res.status(400).json({ error: 'Permanent context must be a string or null' });
    }

    const username = requireUsername(req);

    // Update the session permanent context
    const updatedSession = await updateSessionPermanentContext(
      sessionId, 
      username, 
      permanentContext || ''
    );
    
    // Return regenerated starter questions so the client can swap chips without
    // a refetch race.
    const regeneratedQuestions =
      updatedSession.sessionAnalysisContext?.suggestedFollowUps ?? [];
    const initialMessage = updatedSession.messages?.[0];
    const initialAssistantMessage =
      initialMessage?.role === "assistant"
        ? {
            content: initialMessage.content,
            suggestedQuestions: initialMessage.suggestedQuestions ?? [],
          }
        : undefined;

    res.json({
      success: true,
      message: `Session context updated successfully`,
      session: {
        id: updatedSession.id,
        sessionId: updatedSession.sessionId,
        permanentContext: updatedSession.permanentContext,
        lastUpdatedAt: updatedSession.lastUpdatedAt,
      },
      suggestedQuestions: regeneratedQuestions,
      initialAssistantMessage,
    });
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return res.status(401).json({ error: error.message });
    }
    logger.error('Update session context error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to update session context';
    
    // Check if it's a "not found" error
    if (errorMessage.includes('not found') || errorMessage.includes('Session not found')) {
      return res.status(404).json({
        error: errorMessage
      });
    }
    
    // Check if it's an unauthorized error
    if (errorMessage.includes('Unauthorized')) {
      return res.status(403).json({
        error: errorMessage
      });
    }
    
    // Check if it's a CosmosDB initialization error
    if (errorMessage.includes('not initialized')) {
      return res.status(503).json({
        error: 'Database is initializing. Please try again in a moment.',
        retryAfter: 2
      });
    }
    
    res.status(500).json({
      error: errorMessage
    });
  }
};

// ─── Wave W-UD9 · per-dataset directive endpoints ────────────────────────
// Driven by the chat doc's `datasetFingerprint`. GET returns the full
// directives doc (active + superseded + revoked) so the UI can render an
// audit trail. DELETE flips a directive to `status: 'revoked'`. Both
// authorise against the session owner so cross-tenant leakage is impossible.

/** GET /api/session/:sessionId/directives — list directives for the
 *  dataset that owns this session. */
export const getSessionDirectivesEndpoint = async (
  req: Request,
  res: Response
) => {
  try {
    const { sessionId } = req.params;
    if (!sessionId) {
      return res.status(400).json({ error: "Session ID is required" });
    }
    const username = requireUsername(req);
    const doc = await getChatBySessionIdForUser(sessionId, username);
    if (!doc) {
      return res.status(404).json({ error: "Session not found" });
    }
    const fingerprint = (doc.datasetFingerprint ?? "").trim();
    if (!fingerprint) {
      // Legacy session — no per-dataset directives yet. Return an empty
      // shape rather than 404 so the UI can render the panel cleanly.
      return res.json({
        sessionId,
        datasetFingerprint: null,
        directives: [],
        activeDirectives: [],
      });
    }
    const directivesDoc = await getDatasetDirectivesDoc(username, fingerprint);
    const active = await listActiveDirectives(username, fingerprint);
    res.json({
      sessionId,
      datasetFingerprint: fingerprint,
      directives: directivesDoc.directives,
      activeDirectives: active,
      updatedAt: directivesDoc.updatedAt,
      version: directivesDoc.version,
    });
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return res.status(401).json({ error: error.message });
    }
    const msg = error instanceof Error ? error.message : "Failed to list directives";
    logger.error("getSessionDirectivesEndpoint failed:", error);
    res.status(500).json({ error: msg });
  }
};

/** DELETE /api/session/:sessionId/directives/:directiveId — revoke. */
export const revokeSessionDirectiveEndpoint = async (
  req: Request,
  res: Response
) => {
  try {
    const { sessionId, directiveId } = req.params;
    if (!sessionId || !directiveId) {
      return res.status(400).json({
        error: "Session ID and directive ID are required",
      });
    }
    const username = requireUsername(req);
    const doc = await getChatBySessionIdForUser(sessionId, username);
    if (!doc) {
      return res.status(404).json({ error: "Session not found" });
    }
    const fingerprint = (doc.datasetFingerprint ?? "").trim();
    if (!fingerprint) {
      return res.status(404).json({
        error: "Session has no dataset fingerprint — no directives to revoke",
      });
    }
    const updated = await revokeDirective(username, fingerprint, directiveId);
    if (!updated) {
      return res.status(404).json({
        error: "Directive not found or already revoked",
      });
    }
    const active = await listActiveDirectives(username, fingerprint);
    res.json({
      success: true,
      directiveId,
      datasetFingerprint: fingerprint,
      activeDirectives: active,
    });
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return res.status(401).json({ error: error.message });
    }
    const msg = error instanceof Error ? error.message : "Failed to revoke directive";
    logger.error("revokeSessionDirectiveEndpoint failed:", error);
    res.status(500).json({ error: msg });
  }
};

/**
 * W-PivotState · per-session in-process mutex for message pivotState writes.
 * Mirrors the W40 pattern in `persistMergeAssistantSessionContext`. Reads chat
 * doc, mutates one message's `pivotState`, writes the whole doc back. Concurrent
 * PATCH calls for the same session chain through this map so a streaming-turn
 * append (which also reads-modifies-writes the doc) does not silently overwrite
 * a debounced PATCH that landed mid-turn.
 *
 * Single-instance correctness only — multi-instance scaling would need Cosmos
 * `ifMatch` ETag or external lock.
 */
const messagePivotStateLocks = new Map<string, Promise<unknown>>();

export const updateMessagePivotStateEndpoint = async (req: Request, res: Response) => {
  try {
    const sessionId = req.params.sessionId;
    const tsParam = req.params.messageTimestamp;
    const ts = Number(tsParam);

    if (!sessionId) {
      return res.status(400).json({ error: "Session ID is required" });
    }
    if (!Number.isFinite(ts)) {
      return res.status(400).json({ error: "messageTimestamp must be numeric" });
    }

    const username = requireUsername(req);

    // Body shape: `{ pivotState: PivotState | null }`. `null` clears the field
    // (e.g. user "Reset" affordance). Anything else fails validation.
    const body = req.body ?? {};
    const incoming = body.pivotState;
    let parsedState: import("../shared/schema.js").PivotState | null;
    if (incoming === null) {
      parsedState = null;
    } else {
      const parsed = pivotStateSchema.safeParse(incoming);
      if (!parsed.success) {
        return res.status(400).json({
          error: "Invalid pivotState payload",
          details: parsed.error.flatten(),
        });
      }
      parsedState = parsed.data;
    }

    const previous = messagePivotStateLocks.get(sessionId);
    const work = (async () => {
      if (previous) {
        try {
          await previous;
        } catch {
          // Prior caller's failure is its own concern.
        }
      }

      const doc = await getChatBySessionIdForUser(sessionId, username);
      if (!doc) {
        const err = new Error("Session not found") as Error & { statusCode?: number };
        err.statusCode = 404;
        throw err;
      }

      const messages = Array.isArray(doc.messages) ? doc.messages : [];
      const idx = messages.findIndex(
        (m) => m && m.role === "assistant" && m.timestamp === ts
      );
      if (idx < 0) {
        const err = new Error("Assistant message not found for given timestamp") as Error & {
          statusCode?: number;
        };
        err.statusCode = 404;
        throw err;
      }

      const next = { ...messages[idx] };
      if (parsedState === null) {
        delete (next as Record<string, unknown>).pivotState;
      } else {
        (next as Record<string, unknown>).pivotState = parsedState;
      }
      messages[idx] = next;
      doc.messages = messages;

      await updateChatDocument(doc);
    })();

    messagePivotStateLocks.set(sessionId, work);
    try {
      await work;
    } finally {
      if (messagePivotStateLocks.get(sessionId) === work) {
        messagePivotStateLocks.delete(sessionId);
      }
    }

    return res.json({ ok: true });
  } catch (err: any) {
    if (err instanceof AuthenticationError) {
      return res.status(401).json({ error: err.message });
    }
    if (err?.statusCode === 404) {
      return res.status(404).json({ error: err.message });
    }
    if (err?.statusCode === 403 || /unauthorized/i.test(String(err?.message ?? ""))) {
      return res.status(403).json({ error: err.message });
    }
    logger.error("Update message pivotState error:", err);
    return res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to update pivot state",
    });
  }
};

// Get the rolling session analysis context (lightweight — no messages/charts)
export const getSessionAnalysisContextEndpoint = async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const email = requireUsername(req);
    if (!sessionId) return res.status(400).json({ error: "Session ID is required" });

    const session = await getChatBySessionIdForUser(sessionId, email);
    if (!session) return res.status(404).json({ error: "Session not found" });

    return res.json({
      sessionAnalysisContext: session.sessionAnalysisContext ?? null,
      suggestedQuestions: session.sessionAnalysisContext?.suggestedFollowUps ?? [],
      enrichmentStatus: session.enrichmentStatus ?? null,
      lastUpdatedAt: session.lastUpdatedAt,
    });
  } catch (err: any) {
    if (err instanceof AuthenticationError || err?.statusCode === 403) {
      return res.status(403).json({ error: "Unauthorized" });
    }
    logger.error("getSessionAnalysisContextEndpoint error:", err);
    return res.status(500).json({ error: "Failed to load session context" });
  }
};

// Get data summary for a session
export const getDataSummaryEndpoint = async (req: Request, res: Response) => {
  const requestId =
    (typeof req.headers["x-request-id"] === "string" && req.headers["x-request-id"].trim()) ||
    randomUUID();
  res.setHeader("X-Request-Id", requestId);

  try {
    logger.log('📊 getDataSummaryEndpoint called', { 
      requestId,
      sessionId: req.params.sessionId,
      path: req.path,
      method: req.method 
    });
    
    const { sessionId } = req.params;
    const username = requireUsername(req);
    
    if (!sessionId) {
      return res.status(400).json({ error: 'Session ID is required' });
    }

    // Get session document
    const session = await getChatBySessionIdForUser(sessionId, username);
    
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (!session.dataSummary) {
      return res.status(404).json({ error: 'Data summary not available for this session' });
    }

    // Load latest data (reflecting any data-operation modifications) and build
    // an authoritative, type-aware profile. Column kinds come from the
    // dataset's own classification (numericColumns / dateColumns / indicator
    // metadata) — not an independent re-detection that could disagree with how
    // the agent treats each column. See server/lib/richColumnProfile.ts.
    let data = await loadLatestData(session);

    const dataSummary = normalizeDataSummaryForLocalStats(session.dataSummary);

    if (!data || data.length === 0) {
      // No rows (e.g. an empty working set) — still return dataset-level shape
      // so the modal renders an empty state instead of erroring.
      return res.json({
        dataset: {
          rowCount: 0,
          columnCount: dataSummary.columns?.length ?? 0,
          typeBreakdown: { numeric: 0, date: 0, categorical: 0, boolean: 0 },
          totalCells: 0,
          totalNulls: 0,
          overallCompleteness: 100,
          duplicateRowCount: 0,
        },
        qualityScore: 0,
        columns: [],
      });
    }

    // Soft cap for very large datasets: evenly sample rows so per-column
    // profiling stays bounded. Statistics are representative; completeness is
    // near-exact at this scale.
    const MAX_ROWS_FOR_PROFILE = uploadLimits.maxRowsForDataSummaryProfile;
    const totalRowCount = data.length;
    const sampledForProfile = totalRowCount > MAX_ROWS_FOR_PROFILE;
    if (sampledForProfile) {
      logger.log(
        `📊 Dataset has ${totalRowCount} rows; sampling ${MAX_ROWS_FOR_PROFILE} for the profile`,
      );
      const step = totalRowCount / MAX_ROWS_FOR_PROFILE;
      const sampled: Record<string, any>[] = [];
      for (let i = 0; i < data.length && sampled.length < MAX_ROWS_FOR_PROFILE; i += step) {
        sampled.push(data[Math.floor(i)]);
      }
      data = sampled;
    }

    const richSummary = buildRichDataSummary(data, dataSummary);
    // Phase 0 · large-dataset transparency: tell the client when the profile was
    // computed on a sample so the UI can badge it instead of implying full fidelity.
    return res.json(
      sampledForProfile
        ? {
            ...richSummary,
            sampling: {
              sampled: true,
              profiledRowCount: data.length,
              totalRowCount,
            },
          }
        : richSummary,
    );
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return res.status(401).json({ error: error.message });
    }
    const errorMessage = error instanceof Error ? error.message : 'Failed to fetch data summary';
    const stack = error instanceof Error ? error.stack : undefined;
    logger.error('Get data summary error:', {
      requestId,
      sessionId: req.params.sessionId,
      hasAuthHeader: Boolean(req.headers.authorization),
      errorMessage,
    });
    if (stack) {
      logger.error(stack);
    }
    
    if (errorMessage.includes('not found') || errorMessage.includes('Session not found')) {
      return res.status(404).json({ error: errorMessage });
    }
    
    if (errorMessage.includes('Unauthorized')) {
      return res.status(403).json({ error: errorMessage });
    }

    res.status(500).json({ error: errorMessage, requestId });
  }
};

/** Build chart data server-side for Chart Builder preview (matches chat chart pipeline). */
export const postChartPreviewEndpoint = async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    if (!sessionId) {
      return res.status(400).json({ error: "Session ID is required" });
    }
    const username = requireUsername(req);
    const session = await getChatBySessionIdForUser(sessionId, username);
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }
    if (!session.dataSummary) {
      return res.status(400).json({ error: "No dataset loaded for this session" });
    }

    const rawBody = req.body as Record<string, unknown> | undefined;
    const body = (rawBody?.chart ?? rawBody) as Partial<ChartSpec>;
    const pivotFilterFields = Array.isArray(rawBody?.pivotFilterFields)
      ? (rawBody.pivotFilterFields as string[])
      : [];
    const pivotFilterSelections =
      rawBody?.pivotFilterSelections &&
      typeof rawBody.pivotFilterSelections === "object" &&
      !Array.isArray(rawBody.pivotFilterSelections)
        ? (rawBody.pivotFilterSelections as Record<string, string[]>)
        : undefined;

    const pivotQueryBody = rawBody?.pivotQuery;

    if (!body.type || !body.x || !body.y) {
      return res.status(400).json({ error: "chart.type, chart.x, and chart.y are required" });
    }

    const aggregateProvided =
      body.aggregate !== undefined && body.aggregate !== null;

    let spec = chartSpecSchema.parse({
      title: body.title || "Chart",
      type: body.type,
      x: body.x,
      y: body.y,
      z: body.z,
      seriesColumn: body.seriesColumn,
      barLayout: body.barLayout,
      aggregate: body.aggregate ?? "sum",
      xLabel: body.xLabel,
      yLabel: body.yLabel,
      zLabel: body.zLabel,
      y2: body.y2,
      y2Series: body.y2Series,
      y2Label: body.y2Label,
    });

    const dataVersion =
      session.currentDataBlob?.version ?? session.ragIndex?.dataVersion ?? 0;

    if (pivotQueryBody !== undefined && pivotQueryBody !== null) {
      const pivotPreview = await tryProcessChartDataFromPivotQuery(
        sessionId,
        dataVersion,
        { ...spec },
        pivotQueryBody,
        session.dataSummary.dateColumns,
        session.dataSummary.numericColumns ?? [],
        session
      );
      if (pivotPreview?.rows?.length) {
        const fromPivot = pivotPreview.rows;
        const yField = pivotPreview.yField;
        const resolved = pivotPreview.resolvedSpec;
        const seriesKeysForDomain = resolved.seriesKeys?.length
          ? resolved.seriesKeys
          : spec.seriesKeys;
        let extra: Partial<ChartSpec> = {};
        if (spec.type === "heatmap") {
          extra = {};
        } else if (seriesKeysForDomain?.length) {
          const sk = seriesKeysForDomain;
          extra = yDomainForMultiSeriesRows(
            fromPivot as Record<string, any>[],
            sk,
            multiSeriesYDomainKind(spec.type, spec.barLayout)
          );
        } else {
          extra = calculateSmartDomainsForChart(
            fromPivot as Record<string, any>[],
            spec.x,
            yField,
            spec.y2 || undefined,
            {
              yOptions: { useIQR: true, paddingPercent: 5, includeOutliers: true },
              y2Options: spec.y2
                ? { useIQR: true, paddingPercent: 5, includeOutliers: true }
                : undefined,
            }
          );
        }
        let out: ChartSpec = {
          ...spec,
          ...resolved,
          y: yField,
          ...extra,
          data: fromPivot as Record<string, any>[],
          xLabel: spec.xLabel || resolved.x,
          yLabel: spec.yLabel || yField,
        };
        const derivedSk = out.seriesKeys?.length
          ? undefined
          : deriveSeriesKeysFromWideDataRow(
              out.type,
              out.x,
              out.y,
              out.seriesColumn,
              fromPivot[0] as Record<string, unknown>
            );
        if (derivedSk?.length) {
          out = { ...out, seriesKeys: derivedSk };
        }
        return res.json({ chart: out });
      }
    }

    let data = await loadLatestData(session);
    if (!data?.length) {
      return res.status(400).json({ error: "No rows available for this session" });
    }

    if (pivotFilterFields.length > 0 && pivotFilterSelections) {
      data = filterRowsByPivotSelections(
        data as Record<string, unknown>[],
        pivotFilterFields,
        pivotFilterSelections
      ) as Record<string, any>[];
    }

    if (!data?.length) {
      return res.status(400).json({ error: "No rows match the current pivot filters" });
    }
    const MAX = 50000;
    if (data.length > MAX) {
      const step = Math.floor(data.length / MAX);
      const sampled: Record<string, unknown>[] = [];
      for (let i = 0; i < data.length && sampled.length < MAX; i += step) {
        sampled.push(data[i]);
      }
      data = sampled as Record<string, any>[];
    }

    const { merged: rowCompiled } = compileChartSpec(
      data as Record<string, unknown>[],
      {
        numericColumns: session.dataSummary.numericColumns ?? [],
        dateColumns: session.dataSummary.dateColumns,
      },
      {
        type: spec.type,
        x: spec.x,
        y: spec.y,
        z: spec.z,
        seriesColumn: spec.seriesColumn,
        barLayout: spec.barLayout,
        ...(aggregateProvided ? { aggregate: spec.aggregate } : {}),
        y2: spec.y2,
        y2Series: spec.y2Series,
        seriesKeys: spec.seriesKeys,
      },
      { preserveAggregate: aggregateProvided }
    );

    spec = chartSpecSchema.parse({
      ...spec,
      type: rowCompiled.type,
      x: rowCompiled.x,
      y: rowCompiled.y,
      z: rowCompiled.z,
      seriesColumn: rowCompiled.seriesColumn,
      barLayout: rowCompiled.barLayout,
      aggregate: rowCompiled.aggregate ?? spec.aggregate,
    });

    const specProcessing: ChartSpec = { ...spec };
    const processed = processChartData(
      data as Record<string, any>[],
      specProcessing,
      session.dataSummary.dateColumns,
      { chartQuestion: "" }
    );
    if (!processed.length) {
      return res.status(400).json({ error: "No data points produced for this chart configuration" });
    }

    let mergedPatches = seriesKeysPatchesFromProcessedSpec(specProcessing);
    if (!mergedPatches.seriesKeys?.length && spec.seriesColumn && processed[0]) {
      const d = deriveSeriesKeysFromWideDataRow(
        spec.type,
        spec.x,
        spec.y,
        spec.seriesColumn,
        processed[0] as Record<string, unknown>
      );
      if (d?.length) {
        mergedPatches = { ...mergedPatches, seriesKeys: d };
      }
    }
    spec = chartSpecSchema.parse({
      ...spec,
      ...mergedPatches,
    });

    let extra: Partial<ChartSpec> = {};
    if (spec.type === "heatmap") {
      extra = {};
    } else if (spec.seriesKeys?.length) {
      const sk = spec.seriesKeys;
      extra = yDomainForMultiSeriesRows(
        processed,
        sk,
        multiSeriesYDomainKind(spec.type, spec.barLayout)
      );
    } else {
      extra = calculateSmartDomainsForChart(
        processed,
        spec.x,
        spec.y,
        spec.y2 || undefined,
        {
          yOptions: { useIQR: true, paddingPercent: 5, includeOutliers: true },
          y2Options: spec.y2
            ? { useIQR: true, paddingPercent: 5, includeOutliers: true }
            : undefined,
        }
      );
    }

    const out: ChartSpec = {
      ...spec,
      ...extra,
      data: processed,
      xLabel: spec.xLabel || spec.x,
      yLabel: spec.yLabel || spec.y,
    };
    return res.json({ chart: out });
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return res.status(401).json({ error: error.message });
    }
    logger.error("postChartPreviewEndpoint:", error);
    const msg = error instanceof Error ? error.message : "Chart preview failed";
    return res.status(400).json({ error: msg });
  }
};

// RL2 · per-session mutex chain. When a dashboard turn emits N chart bubbles,
// each bubble's debounced effect POSTs to /chart-key-insight in parallel
// (within the 500ms client debounce window). Without serialisation this fans
// out N parallel `generateChartInsights` calls per session, each issuing its
// own outbound LLM request — multiplying instantaneous LLM-API pressure.
// Mirrors the W40 pattern at sessionAnalysisContext.ts:472-513.
const chartKeyInsightChain = new Map<string, Promise<unknown>>();

async function runSerialisedPerSession<T>(
  sessionId: string,
  work: () => Promise<T>
): Promise<T> {
  const previous = chartKeyInsightChain.get(sessionId);
  const next = (async () => {
    if (previous) {
      try {
        await previous;
      } catch {
        // Prior call's failure is its own concern; this call still runs.
      }
    }
    return work();
  })();
  chartKeyInsightChain.set(sessionId, next);
  try {
    return await next;
  } finally {
    if (chartKeyInsightChain.get(sessionId) === next) {
      chartKeyInsightChain.delete(sessionId);
    }
  }
}

/** On-demand Key Insight for chart preview / pivot charts (avoids LLM on debounced preview). */
export const postChartKeyInsightEndpoint = async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    if (!sessionId) {
      return res.status(400).json({ error: "Session ID is required" });
    }
    const username = requireUsername(req);
    const session = await getChatBySessionIdForUser(sessionId, username);
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }
    if (!session.dataSummary) {
      return res.status(400).json({ error: "No dataset loaded for this session" });
    }

    const rawBody = req.body as Record<string, unknown> | undefined;
    const bodyChart = rawBody?.chart ?? rawBody;
    if (!bodyChart || typeof bodyChart !== "object") {
      return res.status(400).json({ error: "Request body must include a chart object" });
    }
    const userQuestionRaw = rawBody?.userQuestion;
    const userQuestion =
      typeof userQuestionRaw === "string" && userQuestionRaw.trim().length > 0
        ? userQuestionRaw.trim()
        : undefined;

    const chart = chartSpecSchema.parse(bodyChart) as ChartSpec;
    const rows = Array.isArray(chart.data) ? chart.data : [];
    // Empty data is a valid user-driven state (zero-row filter). Return an empty
    // insight so the client can preserve prior text rather than seeing an error.
    if (rows.length === 0) {
      return res.json({ keyInsight: "" });
    }

    const capped = rows.slice(0, CHART_KEY_INSIGHT_MAX_ROWS) as Record<string, any>[];
    const chartForInsight: ChartSpec = {
      ...chart,
      data: capped,
    };

    // Match the agent-turn `enrichCharts` parity: hydrate synthesis context so
    // the LLM produces a substantive insight, not a flat statistical sentence
    // that mimics the deterministic fallback. Domain context loader is process-
    // memoised; failures are non-fatal (commentary just won't render).
    let domainContext: string | undefined;
    try {
      const { loadEnabledDomainContext } = await import(
        "../lib/domainContext/loadEnabledDomainContext.js"
      );
      const { text } = await loadEnabledDomainContext();
      if (text?.trim()) domainContext = text;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`postChartKeyInsightEndpoint · domain context load failed: ${msg}`);
    }

    const chatLevelInsights =
      Array.isArray(session.insights) && session.insights.length > 0
        ? session.insights
        : undefined;

    const { keyInsight } = await runSerialisedPerSession(sessionId, () =>
      generateChartInsights(
        chartForInsight,
        capped,
        session.dataSummary as DataSummary,
        chatLevelInsights,
        {
          userQuestion,
          sessionAnalysisContext: session.sessionAnalysisContext,
          permanentContext: session.permanentContext,
          domainContext,
        }
      )
    );

    return res.json({ keyInsight });
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return res.status(401).json({ error: error.message });
    }
    logger.error("postChartKeyInsightEndpoint:", error);
    const msg = error instanceof Error ? error.message : "Key insight generation failed";
    return res.status(400).json({ error: msg });
  }
};

// Exported for tests so we can verify same-session serialisation directly.
export const __chartKeyInsight_test__ = { runSerialisedPerSession };

// Delete session by session ID
export const deleteSessionEndpoint = async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    
    if (!sessionId) {
      return res.status(400).json({ error: 'Session ID is required' });
    }

    const username = requireUsername(req);

    // Delete the session
    await deleteSessionBySessionId(sessionId, username);
    
    res.json({
      success: true,
      message: `Session ${sessionId} deleted successfully`,
      sessionId
    });
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return res.status(401).json({ error: error.message });
    }
    logger.error('Delete session error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to delete session';
    
    // Check if it's a "not found" error
    if (errorMessage.includes('not found') || errorMessage.includes('Session not found')) {
      return res.status(404).json({
        error: errorMessage
      });
    }
    
    // Check if it's a CosmosDB initialization error
    if (errorMessage.includes('not initialized')) {
      return res.status(503).json({
        error: 'Database is initializing. Please try again in a moment.',
        retryAfter: 2
      });
    }
    
    res.status(500).json({
      error: errorMessage
    });
  }
};


// EU1 · Replace the dimensionHierarchies array on a session.
// Used by the in-banner remove/edit affordances. The H2 immutability
// guard does NOT block this path because it operates only on assistant
// merges; the user-merge LLM and this endpoint both have full control.
const putSessionHierarchiesBodySchema = z.object({
  hierarchies: z.array(dimensionHierarchySchema).max(20),
});

export const putSessionHierarchiesEndpoint = async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    if (!sessionId) {
      return res.status(400).json({ error: "Session ID is required" });
    }
    const parsed = putSessionHierarchiesBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Invalid hierarchies payload",
        details: parsed.error.flatten(),
      });
    }
    const username = requireUsername(req);
    const updated = await updateSessionDimensionHierarchies({
      sessionId,
      username,
      hierarchies: parsed.data.hierarchies,
    });
    if (!updated) {
      return res.status(404).json({ error: "Session not found" });
    }
    res.json({
      success: true,
      hierarchies: updated.dataset.dimensionHierarchies ?? [],
    });
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return res.status(401).json({ error: error.message });
    }
    logger.error("Put session hierarchies error:", error);
    const msg = error instanceof Error ? error.message : "Failed to update hierarchies";
    if (/not initialized/.test(msg)) {
      return res.status(503).json({ error: "Database is initializing. Please try again." });
    }
    res.status(500).json({ error: msg });
  }
};

// SU-UX1 · Replace the dataSummary's schema-annotation arrays for a session.
// Used by the in-banner remove buttons on DateTimePairsBanner and
// IndicatorColumnsBanner. Either body field is optional — clients patch
// independently. Empty arrays explicitly clear the corresponding annotation.
const putSessionSchemaAnnotationsBodySchema = z.object({
  dateTimeColumnPairs: z.array(dateTimeColumnPairSchema).max(20).optional(),
  indicators: z
    .array(
      z.object({
        column: z.string().min(1).max(200),
        kind: z.enum(["boolean", "categorical"]),
        positiveValues: z.array(z.string().min(1).max(200)).max(8).optional(),
        negativeValues: z.array(z.string().min(1).max(200)).max(8).optional(),
        sentinelValues: z.array(z.string().min(1).max(200)).max(8).optional(),
      })
    )
    .max(50)
    .optional(),
});

export const putSessionSchemaAnnotationsEndpoint = async (
  req: Request,
  res: Response
) => {
  try {
    const { sessionId } = req.params;
    if (!sessionId) {
      return res.status(400).json({ error: "Session ID is required" });
    }
    const parsed = putSessionSchemaAnnotationsBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Invalid schema-annotations payload",
        details: parsed.error.flatten(),
      });
    }
    const username = requireUsername(req);
    const updated = await updateSessionSchemaAnnotations({
      sessionId,
      username,
      ...parsed.data,
    });
    if (!updated) {
      return res.status(404).json({ error: "Session not found" });
    }
    res.json({ success: true, ...updated });
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return res.status(401).json({ error: error.message });
    }
    logger.error("Put session schema annotations error:", error);
    const msg =
      error instanceof Error ? error.message : "Failed to update annotations";
    if (/not initialized/.test(msg)) {
      return res
        .status(503)
        .json({ error: "Database is initializing. Please try again." });
    }
    res.status(500).json({ error: msg });
  }
};
