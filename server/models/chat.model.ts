/**
 * Chat Model
 * Handles all database operations for chat documents and sessions
 */
import {
  ChartSpec,
  Message,
  DataSummary,
  Insight,
  DatasetProfile,
  SessionAnalysisContext,
  ActiveFilterSpec,
  SemanticModel,
  chartIdentityKey,
} from "../shared/schema.js";
import type { SemanticModelAuditEntry } from "../lib/semantic/semanticModelAuditLog.js";
import { waitForContainer } from "./database.config.js";
import { ChartReference, saveChartsToBlob, loadChartsFromBlob } from "../lib/blobStorage.js";

// ─── Short-lived CosmosDB read caches ────────────────────────────────────────
// Each unique session document is fetched from Cosmos at most once per TTL
// window; writes (upsert / create / delete) always invalidate immediately.

const SESSION_DOC_CACHE_TTL_MS = 5_000;
const SESSION_LIST_CACHE_TTL_MS = 5_000;
const ACCESS_CACHE_TTL_MS = 30_000;

const sessionDocCache = new Map<string, { doc: ChatDocument | null; expiresAt: number }>();
const sessionListCache = new Map<string, { sessions: SessionListSummary[]; expiresAt: number }>();
const accessResultCache = new Map<string, { expiresAt: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessionDocCache) if (v.expiresAt <= now) sessionDocCache.delete(k);
  for (const [k, v] of sessionListCache) if (v.expiresAt <= now) sessionListCache.delete(k);
  for (const [k, v] of accessResultCache) if (v.expiresAt <= now) accessResultCache.delete(k);
}, 60_000).unref();

function invalidateSessionDoc(sessionId: string) { sessionDocCache.delete(sessionId); }
function invalidateSessionList(username: string) {
  sessionListCache.delete(username.toLowerCase());
  sessionListCache.delete(""); // clear any all-users cached query
}

// Chat document interface
export interface ChatDocument {
  id: string; // Unique chat ID (fileName + timestamp)
  username: string; // User email
  fileName: string; // Original uploaded file name
  uploadedAt: number; // Upload timestamp
  createdAt: number; // Chat creation timestamp
  lastUpdatedAt: number; // Last update timestamp
  collaborators?: string[]; // Emails with access (always includes owner)
  dataSummary: DataSummary; // Data summary from file upload
  messages: Message[]; // Chat messages with charts and insights
  charts: ChartSpec[]; // All charts generated for this chat (may be empty if stored in blob)
  chartReferences?: ChartReference[]; // References to charts stored in blob storage
  insights: Insight[]; // AI-generated insights from data analysis
  sessionId: string; // Original session ID
  // Enhanced analysis data storage
  rawData: Record<string, any>[]; // Complete raw data from uploaded file (updated after each data operation)
  sampleRows: Record<string, any>[]; // Sample rows for preview (first 100)
  columnStatistics: Record<string, any>; // Statistical analysis of numeric columns
  dataSummaryStatistics?: { // Pre-computed detailed statistics from Python service
    summary: Array<{
      variable: string;
      datatype: string;
      total_values: number;
      null_values: number;
      non_null_values: number;
      mean?: number | null;
      median?: number | null;
      mode?: any;
      std_dev?: number | null;
      min?: number | string | null;
      max?: number | string | null;
    }>;
    qualityScore: number;
    computedAt: number; // Timestamp when statistics were computed
  };
  blobInfo?: { // Azure Blob Storage information
    blobUrl: string;
    blobName: string;
  };
  currentDataBlob?: { // Current processed data blob (for data operations)
    blobUrl: string;
    blobName: string;
    version: number;
    lastUpdated: number;
  };
  /**
   * Phase 1 (large-dataset robustness) · pointer to the durable Parquet copy of
   * the authoritative dataset in blob, keyed by dataVersion. When the
   * USE_PARQUET_READ_PATH flag is on, the read path opens this directly as the
   * DuckDB `data` view instead of rehydrating all rows per request. Optional /
   * additive — absent on existing sessions; the read path falls back cleanly.
   */
  parquetBlob?: {
    blobName: string;
    version: number;
    rowCount?: number;
  };
  dataVersions?: Array<{ // Version history for data operations
    versionId: string;
    blobName: string;
    operation: string;
    description: string;
    timestamp: number;
    parameters?: any;
    affectedRows?: number;
    affectedColumns?: string[];
    rowsBefore?: number;
    rowsAfter?: number;
  }>;
  dataOpsContext?: any; // Context for data operations (pending operations, filters, etc.)
  analysisMetadata: { // Additional metadata about the analysis
    totalProcessingTime: number; // Time taken to process the file
    aiModelUsed: string; // AI model used for analysis
    fileSize: number; // Original file size in bytes
    analysisVersion: string; // Version of analysis algorithm
  };
  dataOpsMode?: boolean; // Whether Data Ops mode is enabled for this session
  permanentContext?: string; // Permanent context provided by user during upload, sent to AI with each message
  /**
   * Wave W-UD1 · per-dataset directive fingerprint. Hash of the dataset's
   * sorted lowercase columns + types (see [datasetFingerprint.ts](../lib/datasetFingerprint.ts)).
   * Two sessions on datasets with identical column shapes share a fingerprint
   * and therefore inherit each other's persisted directives. Computed at
   * upload completion; persisted on the session for fast hydration.
   */
  datasetFingerprint?: string;
  /**
   * Wave W-UD1 · hydrated snapshot of the dataset's user directives at session
   * start. The authoritative store is the `dataset_directives` Cosmos
   * container; this field is a per-session mirror so the chat doc carries
   * its own audit-visible copy. Read in `buildAgentExecutionContext` and
   * projected into every agent role's prompt block.
   */
  userDirectives?: import("../shared/schema.js").UserDirective[];
  /** DuckDB/columnar path for large uploads (not in Cosmos payload). */
  columnarStoragePath?: string;
  /** Selected Excel worksheet name for this upload session. */
  selectedSheetName?: string;
  chunkIndexBlob?: { // Chunk index for chunked files (faster querying)
    blobName: string;
    totalChunks: number;
    totalRows: number;
  };
  /** Azure AI Search RAG index status for this session (optional). */
  ragIndex?: {
    status: "indexing" | "ready" | "error";
    indexedAt?: number;
    chunkCount?: number;
    dataVersion?: number;
    lastError?: string;
  };
  /** LLM dataset profile from initial upload (columns, suggested questions, etc.). */
  datasetProfile?: DatasetProfile;
  /**
   * Wave W57 · per-session semantic model. Built once at upload from
   * `dataSummary + datasetProfile` via `inferModel`, persisted at the
   * understanding-ready checkpoint. The compiler (W58) reads this; the
   * admin UI (W61) edits it; the planner prompt (W59) renders it. Auto-
   * inferred; absent on legacy sessions persisted before W57. See
   * [server/lib/semantic/inferModel.ts](../lib/semantic/inferModel.ts).
   */
  semanticModel?: SemanticModel;
  /**
   * Wave W61-audit-log · prior-model snapshots written on every admin
   * PATCH, newest-first, capped at
   * `SEMANTIC_MODEL_AUDIT_LOG_MAX_ENTRIES` (10). Each entry preserves
   * what was about to be overwritten so a future W61-audit-revert wave
   * can re-PATCH a chosen prior version. Absent on sessions that have
   * never been edited via the admin viewer. See
   * [server/lib/semantic/semanticModelAuditLog.ts](../lib/semantic/semanticModelAuditLog.ts).
   */
  semanticModelAuditLog?: SemanticModelAuditEntry[];
  /** Rolling structured context: LLM seed + merges (user + each assistant turn). */
  sessionAnalysisContext?: SessionAnalysisContext;
  /** Upload pipeline: LLM profile + session context seed. Answers wait until complete (omit = legacy sessions). */
  enrichmentStatus?: "pending" | "in_progress" | "complete" | "failed";
  /** User message received while enrichment incomplete; processed after upload job finishes enrichment. */
  pendingUserMessage?: { content: string; timestamp: number };
  /**
   * Phase 2.E · Most recent dashboard the agent (or user) created from
   * this session. Written by POST /api/dashboards/from-spec when a
   * sessionId is supplied, read by the `patch_dashboard` agent tool so
   * "add a margin chart to the dashboard we just built" resolves without
   * the user re-stating the id.
   */
  lastCreatedDashboardId?: string;
  /**
   * Wave A4 · running turn checkpoint. Updated debounced (~3 s) during the
   * agent turn so a process crash mid-turn leaves a partial state in Cosmos
   * the client can render as "your last turn was interrupted; here's what we
   * had". Cleared at turn end (success path or fatal error). Optional + back-
   * compat — the absence of the field on a chat doc means no in-flight turn.
   */
  currentTurnCheckpoint?: {
    sessionId: string;
    question: string;
    startedAt: number;
    lastUpdatedAt: number;
    /** AgentInternals snapshot at the latest persisted step boundary. */
    agentInternals?: import("../shared/schema.js").AgentInternals;
    /** Number of plan steps completed when this snapshot was written. */
    stepsCompleted?: number;
  };
  /**
   * Wave-FA1 · Excel-style active filter overlay. Non-destructive — the
   * canonical `currentDataBlob` / `rawData` / `blobInfo` are never altered
   * by filter changes. Applied at `loadLatestData` and DuckDB query time.
   * Absent or `conditions: []` means "no active filter" (analysis sees the
   * canonical rows). See `server/lib/activeFilter/` for the implementation.
   */
  activeFilter?: ActiveFilterSpec;
  /**
   * Sidebar pin flag — pinned sessions sort to the top of the Recent
   * Sessions list. Optional, no default; absent means unpinned.
   */
  pinned?: boolean;
  /** Timestamp (ms) when `pinned` was set true. Used as a tiebreaker. */
  pinnedAt?: number;
}

/** Lightweight row for session list APIs (avoids loading messages/charts/rawData from Cosmos). */
export interface SessionListSummary {
  id: string;
  username: string;
  fileName: string;
  uploadedAt: number;
  createdAt: number;
  lastUpdatedAt: number;
  collaborators?: string[];
  sessionId: string;
  messageCount: number;
  chartCount: number;
  pinned?: boolean;
  pinnedAt?: number;
}

const SESSION_LIST_SELECT =
  "SELECT c.id, c.username, c.fileName, c.uploadedAt, c.createdAt, c.lastUpdatedAt, c.collaborators, c.sessionId, c.pinned, c.pinnedAt, " +
  "IIF(IS_DEFINED(c.messages) AND IS_ARRAY(c.messages), ARRAY_LENGTH(c.messages), 0) AS messageCount, " +
  "IIF(IS_DEFINED(c.charts) AND IS_ARRAY(c.charts), ARRAY_LENGTH(c.charts), 0) AS chartCount FROM c";

// Helper functions
const normalizeEmail = (value: string) => value?.trim().toLowerCase();

const ensureCollaborators = (chatDocument: ChatDocument): string[] => {
  const owner = normalizeEmail(chatDocument.username);
  const collaborators = Array.from(
    new Set(
      (chatDocument.collaborators || [])
        .map(normalizeEmail)
        .filter((email): email is string => Boolean(email))
    )
  );

  if (!collaborators.includes(owner)) {
    collaborators.unshift(owner);
  }

  chatDocument.collaborators = collaborators;
  return collaborators;
};

const finalizeSessionListSummary = (raw: Record<string, unknown>): SessionListSummary => {
  const row: SessionListSummary = {
    id: String(raw.id ?? ""),
    username: String(raw.username ?? ""),
    fileName: String(raw.fileName ?? ""),
    uploadedAt: Number(raw.uploadedAt ?? 0),
    createdAt: Number(raw.createdAt ?? 0),
    lastUpdatedAt: Number(raw.lastUpdatedAt ?? 0),
    collaborators: Array.isArray(raw.collaborators)
      ? (raw.collaborators as string[]).filter((e): e is string => typeof e === "string")
      : undefined,
    sessionId: String(raw.sessionId ?? ""),
    messageCount: Number(raw.messageCount ?? 0),
    chartCount: Number(raw.chartCount ?? 0),
    pinned: typeof raw.pinned === "boolean" ? raw.pinned : undefined,
    pinnedAt: typeof raw.pinnedAt === "number" ? raw.pinnedAt : undefined,
  };
  const stub = {
    username: row.username,
    collaborators: row.collaborators,
  } as ChatDocument;
  ensureCollaborators(stub);
  row.collaborators = stub.collaborators;
  return row;
};

const deepClone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

// Helper function to generate unique filename with number suffix
const generateUniqueFileName = async (baseFileName: string, username: string): Promise<string> => {
  try {
    // Get all sessions for this user
    const allSessions = await getAllSessions(username);
    
    // Extract base name without extension and any existing number suffix
    const baseNameMatch = baseFileName.match(/^(.+?)(\s*\(\d+\))?(\.[^.]+)?$/);
    const baseNameWithoutExt = baseNameMatch ? baseNameMatch[1] : baseFileName;
    const extension = baseNameMatch && baseNameMatch[3] ? baseNameMatch[3] : '';
    
    // Find all sessions with matching base filename (with or without number suffix)
    const matchingSessions = allSessions.filter(session => {
      const sessionBaseMatch = session.fileName.match(/^(.+?)(\s*\(\d+\))?(\.[^.]+)?$/);
      const sessionBaseName = sessionBaseMatch ? sessionBaseMatch[1] : session.fileName;
      const sessionExt = sessionBaseMatch && sessionBaseMatch[3] ? sessionBaseMatch[3] : '';
      
      // Match if base name and extension are the same
      return sessionBaseName === baseNameWithoutExt && sessionExt === extension;
    });
    
    // If no matches, return original filename
    if (matchingSessions.length === 0) {
      return baseFileName;
    }
    
    // Extract numbers from existing filenames
    // If a filename has no number suffix, it's the first upload (count as 1)
    const existingNumbers = matchingSessions
      .map(session => {
        const match = session.fileName.match(/\((\d+)\)/);
        return match ? parseInt(match[1], 10) : 1; // If no number, treat as (1)
      })
      .sort((a, b) => b - a); // Sort descending
    
    // Find the next available number
    const maxNumber = existingNumbers.length > 0 ? existingNumbers[0] : 0;
    const nextNumber = maxNumber + 1;
    
    // Return filename with number suffix
    return `${baseNameWithoutExt} (${nextNumber})${extension}`;
  } catch (error) {
    console.error('Error generating unique filename, using original:', error);
    return baseFileName; // Fallback to original filename on error
  }
};

/**
 * Create a new chat document
 */
export const createChatDocument = async (
  username: string,
  fileName: string,
  sessionId: string,
  dataSummary: DataSummary,
  initialCharts: ChartSpec[] = [],
  rawData: Record<string, any>[] = [],
  sampleRows: Record<string, any>[] = [],
  columnStatistics: Record<string, any> = {},
  blobInfo?: { blobUrl: string; blobName: string },
  analysisMetadata?: {
    totalProcessingTime: number;
    aiModelUsed: string;
    fileSize: number;
    analysisVersion: string;
  },
  insights: Insight[] = [],
  dataSummaryStatistics?: {
    summary: Array<{
      variable: string;
      datatype: string;
      total_values: number;
      null_values: number;
      non_null_values: number;
      mean?: number | null;
      median?: number | null;
      mode?: any;
      std_dev?: number | null;
      min?: number | string | null;
      max?: number | string | null;
    }>;
    qualityScore: number;
    computedAt: number;
  },
  datasetProfile?: DatasetProfile,
  sessionAnalysisContext?: SessionAnalysisContext
): Promise<ChatDocument> => {
  const timestamp = Date.now();
  const normalizedUsername = normalizeEmail(username) || username;
  
  // Generate unique filename with number suffix if needed
  const uniqueFileName = await generateUniqueFileName(fileName, normalizedUsername);
  console.log(`📝 Generated unique filename: "${fileName}" -> "${uniqueFileName}"`);
  
  const chatId = `${uniqueFileName.replace(/[^a-zA-Z0-9]/g, '_')}_${timestamp}`;
  
  // rawData is never stored in CosmosDB — full data lives in blob/columnar storage,
  // only sampleRows are kept for preview to stay well under the 4MB document limit.
  
  // Check if charts should be stored in blob (if they have large data arrays)
  let chartsToStore: ChartSpec[] = [];
  let chartReferences: ChartReference[] = [];
  
  if (initialCharts && initialCharts.length > 0) {
    // Estimate chart size - if any chart has data array with >1000 points, store in blob
    const shouldStoreChartsInBlob = initialCharts.some(chart => {
      const chartSize = JSON.stringify(chart).length;
      const hasLargeData = chart.data && Array.isArray(chart.data) && chart.data.length > 1000;
      return chartSize > 100000 || hasLargeData; // 100KB or >1000 data points
    });
    
    if (shouldStoreChartsInBlob) {
      console.log(`📊 Charts have large data arrays. Storing in blob storage...`);
      try {
        chartReferences = await saveChartsToBlob(sessionId, initialCharts, normalizedUsername);
        // Store only chart metadata (without data) in CosmosDB
        chartsToStore = initialCharts.map(chart => ({
          ...chart,
          data: undefined, // Remove data array
        }));
        console.log(`✅ Saved ${chartReferences.length} charts to blob storage`);
      } catch (blobError) {
        console.error('⚠️ Failed to save charts to blob, storing in CosmosDB:', blobError);
        chartsToStore = initialCharts; // Fallback to storing in CosmosDB
      }
    } else {
      chartsToStore = initialCharts; // Small charts can be stored in CosmosDB
    }
  }
  
  const chatDocument: ChatDocument & { fsmrora?: string } = {
    id: chatId,
    username: normalizedUsername,
    fsmrora: normalizedUsername, // Add partition key field to match partition key path /fsmrora
    fileName: uniqueFileName,
    uploadedAt: timestamp,
    createdAt: timestamp,
    lastUpdatedAt: timestamp,
    dataSummary,
    messages: [],
    charts: chartsToStore, // Charts without data if stored in blob
    chartReferences: chartReferences.length > 0 ? chartReferences : undefined,
    insights: insights,
    sessionId,
    rawData: [],
    sampleRows,
    columnStatistics,
    dataSummaryStatistics, // Pre-computed data summary statistics
    blobInfo,
    collaborators: [normalizedUsername],
    analysisMetadata: analysisMetadata || {
      totalProcessingTime: 0,
      aiModelUsed: 'gpt-4o',
      fileSize: 0,
      analysisVersion: '1.0.0'
    },
    ...(datasetProfile ? { datasetProfile } : {}),
    ...(sessionAnalysisContext ? { sessionAnalysisContext } : {}),
  };

  try {
    const containerInstance = await waitForContainer();
    const { resource } = await containerInstance.items.create(chatDocument);
    console.log(`✅ Created chat document: ${chatId}`);
    return resource as ChatDocument;
  } catch (error: any) {
    // Check if error is due to document size
    if (error?.code === 400 || error?.message?.includes('Request Entity Too Large') || error?.message?.includes('413')) {
      console.error(`❌ Document too large for CosmosDB (${rawData.length} rows). Retrying without rawData...`);
      // Retry without rawData
      const retryDocument = {
        ...chatDocument,
        rawData: [] as Record<string, any>[], // Don't store rawData - it's in blob storage
      };
      try {
        const containerInstance = await waitForContainer();
        const { resource } = await containerInstance.items.create(retryDocument);
        console.log(`✅ Created chat document (without rawData): ${chatId}`);
        return resource as ChatDocument;
      } catch (retryError) {
        console.error("Failed to create chat document even without rawData:", retryError);
        throw retryError;
      }
    }
    console.error("Failed to create chat document:", error);
    throw error;
  }
};

/**
 * Create a placeholder session document immediately when upload is accepted
 * This ensures the session exists in the database before async processing completes
 */
export const createPlaceholderSession = async (
  username: string,
  fileName: string,
  sessionId: string,
  fileSize: number,
  blobInfo?: { blobUrl: string; blobName: string }
): Promise<ChatDocument> => {
  const timestamp = Date.now();
  const normalizedUsername = normalizeEmail(username) || username;
  
  // Generate unique filename with number suffix if needed
  const uniqueFileName = await generateUniqueFileName(fileName, normalizedUsername);
  console.log(`📝 Creating placeholder session: "${fileName}" -> "${uniqueFileName}"`);
  
  const chatId = `${uniqueFileName.replace(/[^a-zA-Z0-9]/g, '_')}_${timestamp}`;
  
  // Create minimal placeholder document
  const placeholderDocument: ChatDocument & { fsmrora?: string } = {
    id: chatId,
    username: normalizedUsername,
    fsmrora: normalizedUsername, // Partition key
    fileName: uniqueFileName,
    uploadedAt: timestamp,
    createdAt: timestamp,
    lastUpdatedAt: timestamp,
    sessionId,
    dataSummary: {
      rowCount: 0,
      columnCount: 0,
      columns: [],
      numericColumns: [],
      dateColumns: [],
    },
    messages: [],
    charts: [],
    insights: [],
    rawData: [],
    sampleRows: [],
    columnStatistics: {},
    collaborators: [normalizedUsername],
    blobInfo,
    analysisMetadata: {
      totalProcessingTime: 0,
      aiModelUsed: 'gpt-4o',
      fileSize: fileSize,
      analysisVersion: '1.0.0'
    },
    enrichmentStatus: "pending",
  };

  try {
    const containerInstance = await waitForContainer();
    const { resource } = await containerInstance.items.create(placeholderDocument);
    invalidateSessionDoc(sessionId);
    invalidateSessionList(normalizedUsername);
    console.log(`✅ Created placeholder session: ${chatId} for sessionId: ${sessionId}`);
    // W59 · record `analysis_created` in the durable Memory journal.
    void (async () => {
      try {
        const { buildAnalysisCreatedEntry, scheduleLifecycleMemory } =
          await import("../lib/agents/runtime/memoryLifecycleBuilders.js");
        scheduleLifecycleMemory(
          buildAnalysisCreatedEntry({
            sessionId,
            username: normalizedUsername,
            fileName: uniqueFileName,
            fileSize,
            createdAt: timestamp,
          })
        );
      } catch (e) {
        console.warn("⚠️ analysisMemory analysis_created hook failed:", e);
      }
    })();
    return resource as ChatDocument;
  } catch (error: any) {
    console.error("❌ Failed to create placeholder session:", error);
    throw error;
  }
};

/**
 * Ensure a Cosmos chat row exists for an upload/Snowflake job before persisting preview.
 * Handles placeholder creation failure at upload time (enqueue still runs).
 */
export const ensureChatDocumentForUploadJob = async (params: {
  sessionId: string;
  username: string;
  fileName: string;
  fileSize: number;
  blobInfo?: { blobUrl: string; blobName: string };
}): Promise<ChatDocument> => {
  let doc = await getChatBySessionIdEfficient(params.sessionId);
  if (doc) {
    return doc;
  }
  try {
    await createPlaceholderSession(
      params.username,
      params.fileName,
      params.sessionId,
      params.fileSize,
      params.blobInfo
    );
  } catch (e) {
    console.warn(
      "⚠️ ensureChatDocumentForUploadJob: createPlaceholderSession failed (may be race); re-fetching:",
      e instanceof Error ? e.message : e
    );
  }
  doc = await getChatBySessionIdEfficient(params.sessionId);
  if (!doc) {
    throw new Error(
      `Could not create or load chat document for session ${params.sessionId}`
    );
  }
  return doc;
};

/**
 * Get chat document by ID
 */
export const getChatDocument = async (
  chatId: string,
  requesterEmail: string
): Promise<ChatDocument | null> => {
  try {
    const containerInstance = await waitForContainer();
    const { resources } = await containerInstance.items
      .query(
        {
          query: "SELECT * FROM c WHERE c.id = @chatId",
          parameters: [{ name: "@chatId", value: chatId }],
        },
        { enableCrossPartitionQuery: true }
      )
      .fetchAll();

    if (!resources.length) {
      return null;
    }

    const chatDocument = resources[0] as ChatDocument;
    const collaborators = ensureCollaborators(chatDocument);
    const normalizedRequester = normalizeEmail(requesterEmail);

    if (!normalizedRequester || !collaborators.includes(normalizedRequester)) {
      const error = new Error("Unauthorized to access this analysis");
      (error as any).statusCode = 403;
      throw error;
    }

    return chatDocument;
  } catch (error: any) {
    if (error.code === 404) {
      return null;
    }
    console.error("Failed to get chat document:", error);
    throw error;
  }
};

// Cosmos's per-document hard limit is 2 MB. Warn well before, error before
// the cliff so the failing turn doesn't disappear silently.
const COSMOS_DOC_SIZE_WARN_BYTES = 1_600_000;
const COSMOS_DOC_SIZE_ERROR_BYTES = 1_900_000;

export class CosmosDocSizeError extends Error {
  readonly bytes: number;
  readonly sessionId: string;
  constructor(bytes: number, sessionId: string) {
    super(
      `Chat document for session ${sessionId} is ${bytes} bytes — too large to persist (Cosmos 2 MB limit). Start a new session or remove older messages.`,
    );
    this.name = "CosmosDocSizeError";
    this.bytes = bytes;
    this.sessionId = sessionId;
  }
}

function assertDocSizeUnderLimit(chatDocument: ChatDocument): void {
  const bytes = Buffer.byteLength(JSON.stringify(chatDocument), "utf8");
  if (bytes >= COSMOS_DOC_SIZE_ERROR_BYTES) {
    throw new CosmosDocSizeError(bytes, chatDocument.sessionId);
  }
  if (bytes >= COSMOS_DOC_SIZE_WARN_BYTES) {
    console.warn(
      `⚠️ chat doc size ${bytes} bytes (session ${chatDocument.sessionId}, messages=${chatDocument.messages?.length ?? 0}) — approaching Cosmos 2 MB limit`,
    );
  }
}

/**
 * Update chat document.
 *
 * **Cache contract (Wave A5 verified — load-bearing).** Every successful
 * upsert here repopulates `sessionDocCache` with the resource Cosmos
 * returned, so a read immediately after a write sees the new state
 * within the same process. This is the ONLY write path to the chat
 * container — there are no direct `containerInstance.items.upsert` /
 * `.patch` calls elsewhere in the server tree (verified by grep). New
 * code that wants to mutate a chat doc MUST go through `updateChatDocument`
 * (or a helper that ultimately delegates to it) — never call
 * `containerInstance.items.upsert(chatDoc)` directly, otherwise the
 * cache will hand out stale state for up to `SESSION_DOC_CACHE_TTL_MS`
 * after the bypass-write.
 *
 * The audit that flagged "sessionDocCache not invalidated on hierarchy /
 * permanent-context updates" was a false positive — every legitimate
 * write path (sessionAnalysisContext.ts, activeFilterController.ts,
 * patchAssistantBusinessActions.ts, dataPersistence.ts) routes through
 * `updateChatDocument` and inherits this cache freshness automatically.
 * This comment exists to keep that invariant load-bearing for future code.
 */
export const updateChatDocument = async (chatDocument: ChatDocument): Promise<ChatDocument> => {
  try {
    const containerInstance = await waitForContainer();
    chatDocument.username = normalizeEmail(chatDocument.username) || chatDocument.username;
    (chatDocument as any).fsmrora = chatDocument.username;
    ensureCollaborators(chatDocument);

    chatDocument.lastUpdatedAt = Date.now();
    assertDocSizeUnderLimit(chatDocument);
    const { resource } = await containerInstance.items.upsert(chatDocument);
    const result = resource as unknown as ChatDocument;
    // Wave A5 · Repopulate cache with the freshly-written doc so reads
    // immediately after a write hit the cache. Load-bearing — see the
    // doc comment above for the cross-module contract.
    sessionDocCache.set(result.sessionId, { doc: result, expiresAt: Date.now() + SESSION_DOC_CACHE_TTL_MS });
    console.log(`✅ Updated chat document: ${chatDocument.id}`);
    return result;
  } catch (error) {
    console.error("❌ Failed to update chat document:", error);
    throw error;
  }
};

/**
 * Add message to chat
 */
export const addMessageToChat = async (
  chatId: string,
  username: string,
  message: Message
): Promise<ChatDocument> => {
  try {
    const chatDocument = await getChatDocument(chatId, username);
    if (!chatDocument) {
      throw new Error("Chat document not found");
    }

    chatDocument.messages.push(message);
    
    // Add any new charts from the message to the main charts array
    if (message.charts && message.charts.length > 0) {
      const newCharts = message.charts.filter(chart => {
        // Axis-aware identity (not just title+type) so two charts that share a
        // title but differ in breakdown both persist their data for reload.
        const key = chartIdentityKey(chart);
        const exists = chatDocument.charts.find(c => chartIdentityKey(c) === key);
        return !exists;
      });

      if (newCharts.length > 0) {
        // Check if charts should be stored in blob
        const shouldStoreInBlob = newCharts.some(chart => {
          const chartSize = JSON.stringify(chart).length;
          const hasLargeData = chart.data && Array.isArray(chart.data) && chart.data.length > 1000;
          return chartSize > 100000 || hasLargeData;
        });

        if (shouldStoreInBlob) {
          try {
            const newChartReferences = await saveChartsToBlob(
              chatDocument.sessionId,
              newCharts,
              chatDocument.username
            );
            
            const existingRefs = chatDocument.chartReferences || [];
            chatDocument.chartReferences = [...existingRefs, ...newChartReferences];
            
            // Store charts without data
            newCharts.forEach(chart => {
              chatDocument.charts.push({
                ...chart,
                data: undefined,
              });
            });
          } catch (blobError) {
            console.error('⚠️ Failed to save charts to blob:', blobError);
            chatDocument.charts.push(...newCharts); // Fallback
          }
        } else {
          chatDocument.charts.push(...newCharts);
        }
      }
    }

    return await updateChatDocument(chatDocument);
  } catch (error) {
    console.error("❌ Failed to add message to chat:", error);
    throw error;
  }
};

/**
 * Add one or more messages by sessionId (avoids relying on partition key at callsite)
 */
export const addMessagesBySessionId = async (
  sessionId: string,
  messages: Message[]
): Promise<ChatDocument> => {
  try {
    console.log("📝 addMessagesBySessionId - sessionId:", sessionId, "messages:", messages.map(m => m.role));
    const chatDocument = await getChatBySessionIdEfficient(sessionId);
    if (!chatDocument) {
      throw new Error("Chat document not found for sessionId");
    }

    // Prevent duplicate messages by checking if they already exist
    // Use a composite key: role + content + timestamp (within 5 seconds tolerance)
    const existingMessages = chatDocument.messages || [];
    const existingKeys = new Set<string>();
    
    existingMessages.forEach(msg => {
      // Exact match key
      const exactKey = `${msg.role}|${msg.content}|${msg.timestamp}`;
      existingKeys.add(exactKey);
      
      // Similar match key (for timestamp within 5 seconds) - helps catch duplicates with slightly different timestamps
      const roundedTimestamp = Math.floor(msg.timestamp / 5000) * 5000;
      const similarKey = `${msg.role}|${msg.content}|${roundedTimestamp}`;
      existingKeys.add(similarKey);
    });
    
    // Filter out duplicate messages
    const uniqueMessages = messages.filter(msg => {
      // Check for exact match
      const exactKey = `${msg.role}|${msg.content}|${msg.timestamp}`;
      if (existingKeys.has(exactKey)) {
        console.log(`⚠️ Duplicate message detected (exact match): ${msg.role} message with timestamp ${msg.timestamp}`);
        return false;
      }
      
      // Check for similar match (content+role with timestamp within 5 seconds)
      const roundedTimestamp = Math.floor(msg.timestamp / 5000) * 5000;
      const similarKey = `${msg.role}|${msg.content}|${roundedTimestamp}`;
      if (existingKeys.has(similarKey)) {
        console.log(`⚠️ Duplicate message detected (similar match): ${msg.role} message with timestamp ${msg.timestamp}`);
        return false;
      }
      
      return true;
    });
    
    if (uniqueMessages.length === 0) {
      console.log("⚠️ All messages were duplicates, skipping add");
      return chatDocument;
    }
    
    if (uniqueMessages.length < messages.length) {
      console.log(`⚠️ Filtered out ${messages.length - uniqueMessages.length} duplicate messages`);
    }

    console.log("🗂️ Appending to doc:", chatDocument.id, "partition:", chatDocument.username, "existing messages:", existingMessages.length, "new unique messages:", uniqueMessages.length);
    chatDocument.messages.push(...uniqueMessages);

    // Collect any charts from assistant messages into top-level charts
    // IMPORTANT: Charts passed here should have FULL data (not stripped)
    // We'll save large charts to blob and strip data from message-level charts
    const newCharts: ChartSpec[] = [];
    messages.forEach((msg) => {
      if (msg.charts && msg.charts.length > 0) {
        msg.charts.forEach((chart) => {
          // Axis-aware identity (not just title+type): an investigated
          // follow-up chart that re-uses a primary chart's title but breaks the
          // metric down differently must persist its OWN data, or it re-hydrates
          // empty on reload (visible on the dashboard, blank in chat).
          const key = chartIdentityKey(chart);
          const exists = chatDocument.charts.find((c) => chartIdentityKey(c) === key);
          if (!exists) {
            newCharts.push(chart); // Keep full chart with data
          }
        });
      }
    });

    // Save new charts to blob if they're large, and strip data from message-level charts
    if (newCharts.length > 0) {
      const largeCharts: ChartSpec[] = [];
      const smallCharts: ChartSpec[] = [];
      
      // Separate large and small charts
      newCharts.forEach(chart => {
        const chartSize = JSON.stringify(chart).length;
        const hasLargeData = chart.data && Array.isArray(chart.data) && chart.data.length > 1000;
        if (chartSize > 100000 || hasLargeData) {
          largeCharts.push(chart);
        } else {
          smallCharts.push(chart);
        }
      });

      // Save large charts to blob storage
      if (largeCharts.length > 0) {
        try {
          const newChartReferences = await saveChartsToBlob(
            sessionId,
            largeCharts,
            chatDocument.username
          );
          
          // Merge with existing chart references
          const existingRefs = chatDocument.chartReferences || [];
          chatDocument.chartReferences = [...existingRefs, ...newChartReferences];
          
          // Store charts without data in CosmosDB (metadata only)
          largeCharts.forEach(chart => {
            const { data, trendLine, ...metadata } = chart;
            chatDocument.charts.push(metadata as ChartSpec);
          });
          
          console.log(`✅ Saved ${newChartReferences.length} large charts to blob storage`);
        } catch (blobError) {
          console.error('⚠️ Failed to save large charts to blob, storing in CosmosDB:', blobError);
          // Fallback: store in CosmosDB (might fail if too large, but we try)
          largeCharts.forEach(chart => {
            chatDocument.charts.push(chart);
          });
        }
      }

      // Store small charts directly in CosmosDB (with full data)
      if (smallCharts.length > 0) {
        chatDocument.charts.push(...smallCharts);
        console.log(`✅ Stored ${smallCharts.length} small charts directly in CosmosDB`);
      }

      // Strip data from message-level charts to prevent CosmosDB size issues
      // Full chart data is available in top-level charts array and blob storage
      messages.forEach(msg => {
        if (msg.charts && msg.charts.length > 0) {
          msg.charts = msg.charts.map(chart => {
            const { data, trendLine, ...rest } = chart;
            return rest; // Keep only metadata in message charts
          });
        }
      });
    }

    const updated = await updateChatDocument(chatDocument);
    console.log("✅ Upserted chat doc:", updated.id, "messages now:", updated.messages?.length || 0);
    return updated;
  } catch (error) {
    console.error("❌ Failed to add messages by sessionId:", error);
    throw error;
  }
};

/**
 * Update a message and truncate all messages after it (used when editing a message)
 */
export const updateMessageAndTruncate = async (
  sessionId: string,
  targetTimestamp: number,
  updatedContent: string
): Promise<ChatDocument> => {
  try {
    console.log("✏️ updateMessageAndTruncate - sessionId:", sessionId, "targetTimestamp:", targetTimestamp);
    const chatDocument = await getChatBySessionIdEfficient(sessionId);
    if (!chatDocument) {
      throw new Error("Chat document not found for sessionId");
    }

    if (!chatDocument.messages || chatDocument.messages.length === 0) {
      throw new Error("No messages found in chat document");
    }

    // Find the message to update by timestamp
    const messageIndex = chatDocument.messages.findIndex(
      (msg) => msg.timestamp === targetTimestamp && msg.role === 'user'
    );

    if (messageIndex === -1) {
      // Message not found - this might be a new message, not an edit
      // Return the document unchanged instead of throwing an error
      console.warn(`⚠️ Message with timestamp ${targetTimestamp} not found. This might be a new message, not an edit. Skipping truncation.`);
      return chatDocument;
    }

    console.log(`🗂️ Found message at index ${messageIndex}, truncating all messages after it`);
    console.log(`📊 Messages before truncation: ${chatDocument.messages.length}`);

    // Update the message content
    chatDocument.messages[messageIndex] = {
      ...chatDocument.messages[messageIndex],
      content: updatedContent,
    };

    // Remove all messages after the edited message
    const messagesToRemove = chatDocument.messages.length - messageIndex - 1;
    if (messagesToRemove > 0) {
      chatDocument.messages.splice(messageIndex + 1);
      console.log(`🗑️ Removed ${messagesToRemove} messages after the edited message`);
    }

    console.log(`📊 Messages after truncation: ${chatDocument.messages.length}`);

    const updated = await updateChatDocument(chatDocument);
    console.log("✅ Updated message and truncated chat doc:", updated.id, "messages now:", updated.messages?.length || 0);
    return updated;
  } catch (error) {
    console.error("❌ Failed to update message and truncate:", error);
    throw error;
  }
};

/**
 * Get all chats for a user
 */
export const getUserChats = async (username: string): Promise<ChatDocument[]> => {
  try {
    const containerInstance = await waitForContainer();
    const normalizedUsername = normalizeEmail(username) || username;

    const query =
      "SELECT * FROM c WHERE (ARRAY_CONTAINS(c.collaborators, @username) OR c.username = @username) ORDER BY c.createdAt DESC";
    const { resources } = await containerInstance.items
      .query(
        {
          query,
          parameters: [{ name: "@username", value: normalizedUsername }],
        },
        { enableCrossPartitionQuery: true }
      )
      .fetchAll();

    const chats = resources.map((doc) => {
      const typed = doc as ChatDocument;
      ensureCollaborators(typed);
      return typed;
    });
    
    return chats;
  } catch (error) {
    console.error("❌ Failed to get user chats:", error);
    throw error;
  }
};

/**
 * Get chat by session ID (more efficient)
 */
/**
 * Helper function to retry Cosmos DB operations on connection errors
 */
const retryOnConnectionError = async <T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
  operationName: string = "Cosmos DB operation"
): Promise<T> => {
  let lastError: any;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error: any) {
      lastError = error;
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      // Check if it's a connection error that might be retryable
      // Include PARSE_ERROR and query timeout errors (subStatusCode 1004)
      const isRetryableError = 
        error.code === "ECONNREFUSED" || 
        error.code === "ETIMEDOUT" || 
        error.code === "ENOTFOUND" ||
        error.code === "ECONNRESET" ||
        error.code === "RestError" ||
        error.code === "PARSE_ERROR" ||
        error.name === "RestError" ||
        (error.diagnostics?.clientSideRequestStatistics?.gatewayStatistics?.[0]?.subStatusCode === 1004) ||
        errorMessage.includes("ECONNREFUSED") ||
        errorMessage.includes("ETIMEDOUT") ||
        errorMessage.includes("ENOTFOUND") ||
        errorMessage.includes("ECONNRESET") ||
        errorMessage.includes("aborted") ||
        errorMessage.includes("PARSE_ERROR");
      
      if (isRetryableError && attempt < maxRetries) {
        const delay = Math.min(attempt * 1000, 5000); // Exponential backoff: 1s, 2s, 3s (max 5s)
        console.warn(`⚠️ ${operationName} connection error (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms...`, errorMessage.substring(0, 100));
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      
      // If not retryable or max retries reached, throw
      throw error;
    }
  }
  
  throw lastError;
};

export const getChatBySessionIdEfficient = async (sessionId: string): Promise<ChatDocument | null> => {
  const hit = sessionDocCache.get(sessionId);
  if (hit && hit.expiresAt > Date.now()) return hit.doc;

  const doc = await retryOnConnectionError(async () => {
    try {
      const containerInstance = await waitForContainer();

      const query =
        "SELECT * FROM c WHERE c.sessionId = @sessionId ORDER BY c.lastUpdatedAt DESC";
      // Enable cross-partition query since sessionId is not the partition key
      const { resources } = await containerInstance.items.query({
        query,
        parameters: [{ name: "@sessionId", value: sessionId }]
      }, { enableCrossPartitionQuery: true }).fetchAll();
      if (resources && resources.length > 1) {
        console.warn(
          `⚠️ Multiple chat documents (${resources.length}) for sessionId ${sessionId}; using latest by lastUpdatedAt`
        );
      }
      const d = (resources && resources.length > 0) ? resources[0] : null;
      if (!d) {
        console.warn("⚠️ No chat document found for sessionId:", sessionId);
      } else {
        ensureCollaborators(d as ChatDocument);
      }
      return d as unknown as ChatDocument | null;
    } catch (error) {
      console.error("❌ Failed to get chat by session ID:", error);
      throw error;
    }
  }, 3, "getChatBySessionIdEfficient");

  sessionDocCache.set(sessionId, { doc, expiresAt: Date.now() + SESSION_DOC_CACHE_TTL_MS });
  return doc;
};

/**
 * Get chat by session ID for a specific user (with authorization check)
 */
export const getChatBySessionIdForUser = async (
  sessionId: string,
  requesterEmail: string
): Promise<ChatDocument | null> => {
  const chatDocument = await getChatBySessionIdEfficient(sessionId);
  if (!chatDocument) {
    console.log(`❌ Session not found: ${sessionId}`);
    return null;
  }

  const normalizedRequester = normalizeEmail(requesterEmail);
  if (!normalizedRequester) {
    const error = new Error("Unauthorized to access this session");
    (error as any).statusCode = 403;
    throw error;
  }

  const cacheKey = `${sessionId}:${normalizedRequester}`;
  const cached = accessResultCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return chatDocument;
  }

  const collaborators = ensureCollaborators(chatDocument);
  if (!collaborators.includes(normalizedRequester)) {
    console.warn(`⚠️ Unauthorized access attempt: "${normalizedRequester}" not in collaborators for session ${sessionId}`);
    const error = new Error("Unauthorized to access this session");
    (error as any).statusCode = 403;
    throw error;
  }

  accessResultCache.set(cacheKey, { expiresAt: Date.now() + ACCESS_CACHE_TTL_MS });
  return chatDocument;
};

/**
 * Superadmin shadow-viewer fetch — bypasses the collaborator check that
 * `getChatBySessionIdForUser` enforces. Caller MUST verify
 * `isSuperadminEmail(email)` before invoking this. Read-only by convention:
 * the only superadmin code path is GETs, so the bypass cannot widen the
 * write surface.
 */
export const getChatBySessionIdForSuperadmin = async (
  sessionId: string
): Promise<ChatDocument | null> => {
  return await getChatBySessionIdEfficient(sessionId);
};

/** Queue a user message while enrichment is incomplete (single slot; latest wins). */
export const setPendingUserMessageForSession = async (
  sessionId: string,
  requesterEmail: string,
  content: string
): Promise<ChatDocument> => {
  const doc = await getChatBySessionIdForUser(sessionId, requesterEmail);
  if (!doc) {
    throw new Error("Session not found");
  }
  doc.pendingUserMessage = { content, timestamp: Date.now() };
  doc.lastUpdatedAt = Date.now();
  return updateChatDocument(doc);
};

/**
 * Phase 2.E · Remember the dashboard the user just created so follow-up
 * chat turns ("add a margin chart to the dashboard we just built") can
 * resolve the target without the user re-stating the id. No-op + silent
 * return when the session / chat doc isn't found, so the create-dashboard
 * endpoint never fails just because the session lookup blinked.
 */
export const setLastCreatedDashboardForSession = async (
  sessionId: string,
  requesterEmail: string,
  dashboardId: string
): Promise<void> => {
  try {
    const doc = await getChatBySessionIdForUser(sessionId, requesterEmail);
    if (!doc) return;
    doc.lastCreatedDashboardId = dashboardId;
    doc.lastUpdatedAt = Date.now();
    await updateChatDocument(doc);
  } catch {
    // Best-effort; memory is advisory — the dashboard already exists.
  }
};

export const clearPendingUserMessage = async (
  sessionId: string,
  requesterEmail: string
): Promise<void> => {
  const doc = await getChatBySessionIdForUser(sessionId, requesterEmail);
  if (!doc) return;
  delete doc.pendingUserMessage;
  doc.lastUpdatedAt = Date.now();
  await updateChatDocument(doc);
};

/**
 * Delete chat document
 */
export const deleteChatDocument = async (chatId: string, username: string): Promise<void> => {
  try {
    const containerInstance = await waitForContainer();
    await containerInstance.item(chatId, username).delete();
    console.log(`✅ Deleted chat document: ${chatId}`);
  } catch (error) {
    console.error("❌ Failed to delete chat document:", error);
    throw error;
  }
};

/**
 * Update session fileName by session ID
 */
export const updateSessionFileName = async (
  sessionId: string,
  username: string,
  newFileName: string
): Promise<ChatDocument> => {
  try {
    const chatDocument = await getChatBySessionIdEfficient(sessionId);
    
    if (!chatDocument) {
      throw new Error(`Session not found for sessionId: ${sessionId}`);
    }
    
    // Verify the username matches
    if (chatDocument.username !== username) {
      throw new Error('Unauthorized: Session does not belong to this user');
    }
    
    // Update the fileName
    chatDocument.fileName = newFileName.trim();
    
    // Update the document
    const updated = await updateChatDocument(chatDocument);
    console.log(`✅ Updated session fileName: ${sessionId} -> ${newFileName}`);
    return updated;
  } catch (error) {
    console.error("❌ Failed to update session fileName:", error);
    throw error;
  }
};

/**
 * Update session pin flag by session ID. Sets `pinnedAt` to now when pinning,
 * clears it when unpinning. Sidebar consumers sort pinned-first.
 */
export const updateSessionPinned = async (
  sessionId: string,
  username: string,
  pinned: boolean
): Promise<ChatDocument> => {
  try {
    const chatDocument = await getChatBySessionIdEfficient(sessionId);

    if (!chatDocument) {
      throw new Error(`Session not found for sessionId: ${sessionId}`);
    }

    if (chatDocument.username !== username) {
      throw new Error('Unauthorized: Session does not belong to this user');
    }

    chatDocument.pinned = pinned;
    chatDocument.pinnedAt = pinned ? Date.now() : undefined;

    const updated = await updateChatDocument(chatDocument);
    console.log(`✅ Updated session pinned: ${sessionId} -> ${pinned}`);
    return updated;
  } catch (error) {
    console.error("❌ Failed to update session pinned:", error);
    throw error;
  }
};

/**
 * Wave W-UD-integration · ensure `datasetFingerprint` is populated on the
 * session's chat doc. When the existing doc already carries a non-empty
 * fingerprint, this is a no-op fast-path (returns the existing value).
 * Otherwise, the supplied fingerprint is written under
 * `withSessionWriteLock` (invariant #9) so it serialises against any
 * other RMW on the same doc. Returns the fingerprint that ended up on
 * the doc — caller can use it for downstream directives lookups.
 *
 * Failures are surfaced as `null` rather than thrown — the session can
 * proceed without a persisted fingerprint (directives simply won't
 * hydrate for that one turn), but a missing fingerprint must not block
 * the user's chat turn.
 */
export const ensureDatasetFingerprintForSession = async (
  sessionId: string,
  username: string,
  fingerprint: string
): Promise<string | null> => {
  if (!sessionId || !fingerprint) return null;
  try {
    const { withSessionWriteLock } = await import(
      "../lib/sessionWriteLock.js"
    );
    return await withSessionWriteLock(sessionId, async () => {
      const doc = await getChatBySessionIdForUser(sessionId, username);
      if (!doc) return null;
      const existing = (doc.datasetFingerprint ?? "").trim();
      if (existing.length > 0) return existing;
      doc.datasetFingerprint = fingerprint;
      doc.lastUpdatedAt = Date.now();
      await updateChatDocument(doc);
      return fingerprint;
    });
  } catch (err) {
    console.warn(
      `⚠️ ensureDatasetFingerprintForSession failed (${sessionId}):`,
      err
    );
    return null;
  }
};

/**
 * Update session permanent context by session ID
 */
export const updateSessionPermanentContext = async (
  sessionId: string,
  username: string,
  permanentContext: string
): Promise<ChatDocument> => {
  try {
    // Initial read for authorization check only.
    const authDoc = await getChatBySessionIdEfficient(sessionId);
    if (!authDoc) {
      throw new Error(`Session not found for sessionId: ${sessionId}`);
    }
    const normalizedUsername = normalizeEmail(username) || username;
    const collaborators = ensureCollaborators(authDoc);
    if (!collaborators.includes(normalizedUsername)) {
      throw new Error('Unauthorized: Session does not belong to this user');
    }

    const incoming = permanentContext.trim();

    // Run the slow LLM merge before re-reading, using the best-known previous snapshot.
    let mergedCtx = authDoc.sessionAnalysisContext;
    if (incoming.length > 0) {
      try {
        const { mergeSessionAnalysisContextUserLLM } = await import(
          "../lib/sessionAnalysisContext.js"
        );
        mergedCtx = await mergeSessionAnalysisContextUserLLM({
          previous: authDoc.sessionAnalysisContext,
          userText: incoming,
        });
      } catch (e) {
        console.warn("⚠️ sessionAnalysisContext user merge skipped:", e);
      }
    }

    // Re-read the doc *after* the slow LLM call so concurrent writes (upload
    // pipeline's understanding checkpoint, fire-and-forget seed) are preserved.
    const freshDoc = (await getChatBySessionIdEfficient(sessionId)) ?? authDoc;

    // Keep permanent context additive and idempotent — use the freshest snapshot.
    const existing = (freshDoc.permanentContext || "").trim();
    const combined =
      incoming.length === 0
        ? existing
        : existing.length === 0
          ? incoming
          : existing.includes(incoming)
            ? existing
            : `${existing}\n\n${incoming}`;
    freshDoc.permanentContext = combined;

    if (incoming.length > 0 && mergedCtx) {
      // Only overwrite sessionAnalysisContext if we actually produced a merge.
      freshDoc.sessionAnalysisContext = mergedCtx;
    }

    // W5: regenerate starter questions + rewrite initial welcome message when
    // the conversation is still at the initial assistant-only state.
    if (incoming.length > 0 && freshDoc.dataSummary && freshDoc.datasetProfile) {
      try {
        const {
          regenerateStarterQuestionsLLM,
          buildInitialAssistantContentFromContext,
        } = await import("../lib/sessionAnalysisContext.js");
        const fresh = await regenerateStarterQuestionsLLM({
          datasetProfile: freshDoc.datasetProfile,
          dataSummary: freshDoc.dataSummary,
          permanentContext: combined,
        });
        if (fresh.length > 0 && freshDoc.sessionAnalysisContext) {
          freshDoc.sessionAnalysisContext = {
            ...freshDoc.sessionAnalysisContext,
            suggestedFollowUps: fresh.slice(0, 12),
          };
          const msgs = freshDoc.messages ?? [];
          const onlyInitial =
            msgs.length === 1 && msgs[0]?.role === "assistant";
          if (onlyInitial) {
            const newContent = buildInitialAssistantContentFromContext(
              freshDoc.dataSummary,
              freshDoc.sessionAnalysisContext
            );
            freshDoc.messages = [
              {
                ...msgs[0],
                content: newContent,
                suggestedQuestions: fresh.slice(0, 5),
              },
            ];
          }
        }
      } catch (e) {
        console.warn("⚠️ starter-question regeneration skipped:", e);
      }
    }

    const updated = await updateChatDocument(freshDoc);
    console.log(`✅ Updated session permanent context: ${sessionId}`);

    // W59 · record the user_note in the Memory journal so resume-after-days
    // shows the note as part of the analysis timeline.
    if (incoming.length > 0) {
      void (async () => {
        try {
          const { buildUserNoteEntry, scheduleLifecycleMemory } =
            await import("../lib/agents/runtime/memoryLifecycleBuilders.js");
          const entry = buildUserNoteEntry({
            sessionId,
            username: normalizedUsername,
            noteText: incoming,
            createdAt: Date.now(),
          });
          if (entry) scheduleLifecycleMemory(entry);
        } catch (e) {
          console.warn("⚠️ analysisMemory user_note hook failed:", e);
        }
      })();
    }

    // W2/W3: index the user context into RAG (fire-and-forget).
    if (combined.length > 0) {
      try {
        const { scheduleUpsertUserContextChunk } = await import(
          "../lib/rag/indexSession.js"
        );
        scheduleUpsertUserContextChunk(sessionId, combined);
      } catch (e) {
        console.warn("⚠️ RAG user_context upsert scheduling failed:", e);
      }
    }

    // Wave W-UD3 · also persist the upload-context as a `free-text` directive
    // in the per-dataset directives store, so re-uploads of the same dataset
    // shape inherit the note. Fire-and-forget: the chat doc has already been
    // upserted; a directive failure must not block the user's save action.
    if (incoming.length > 0) {
      const fingerprint = freshDoc.datasetFingerprint;
      if (fingerprint && fingerprint.length > 0) {
        void (async () => {
          try {
            const { appendDirective } = await import(
              "./datasetDirectives.model.js"
            );
            await appendDirective(normalizedUsername, fingerprint, {
              scope: "dataset",
              kind: "free-text",
              text: incoming,
              source: "upload-context",
              sourceSessionId: sessionId,
            });
          } catch (e) {
            console.warn("⚠️ dataset_directives upload-context write failed:", e);
          }
        })();
      }
    }

    return updated;
  } catch (error) {
    console.error("❌ Failed to update session permanent context:", error);
    throw error;
  }
};

/**
 * Delete chat document by session ID
 */
export const deleteSessionBySessionId = async (sessionId: string, username: string): Promise<void> => {
  try {
    const containerInstance = await waitForContainer();
    
    // First, get the chat document by sessionId to find the chatId
    const chatDocument = await getChatBySessionIdEfficient(sessionId);
    
    if (!chatDocument) {
      throw new Error(`Session not found for sessionId: ${sessionId}`);
    }
    
    const chatId = chatDocument.id;
    
    console.log(`🗑️ Attempting to delete session: ${sessionId}`);
    console.log(`   Chat ID: ${chatId}`);
    console.log(`   Username from doc: ${chatDocument.username}`);
    console.log(`   fsmrora from doc: ${(chatDocument as any).fsmrora || 'not found'}`);
    
    // Try different partition key values
    const possiblePartitionKeys = [
      (chatDocument as any).fsmrora,
      chatDocument.username,
      username
    ].filter(Boolean) as string[];
    
    console.log(`   Trying partition keys: ${possiblePartitionKeys.join(', ')}`);
    
    // Try each possible partition key value
    for (const pkValue of possiblePartitionKeys) {
      try {
        await containerInstance.item(chatId, pkValue).delete();
        invalidateSessionDoc(sessionId);
        invalidateSessionList(chatDocument.username);
        console.log(`✅ Successfully deleted session: ${sessionId} (chatId: ${chatId}, partitionKey: ${pkValue})`);
        return;
      } catch (pkError: any) {
        if (pkError.code === 404) {
          console.log(`   ⚠️ Partition key ${pkValue} didn't work (404), trying next...`);
          continue;
        }
        throw pkError;
      }
    }
    
    throw new Error(`Could not delete document with any partition key value`);
  } catch (error: any) {
    console.error("❌ Failed to delete session by sessionId:", error);
    throw error;
  }
};

/**
 * Get all sessions from CosmosDB container (optionally filtered by username).
 * Uses a narrow projection (no messages/charts/rawData) to keep payloads small and avoid timeouts.
 */
export const getAllSessions = async (username?: string): Promise<SessionListSummary[]> => {
  const cacheKey = username ? (normalizeEmail(username) || username).toLowerCase() : "";
  const hit = sessionListCache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) return hit.sessions;

  const sessions = await retryOnConnectionError(async () => {
    try {
      const containerInstance = await waitForContainer();

      let query = SESSION_LIST_SELECT;
      const parameters: Array<{ name: string; value: any }> = [];

      if (username) {
        query +=
          " WHERE (ARRAY_CONTAINS(c.collaborators, @username) OR c.username = @username)";
        parameters.push({
          name: "@username",
          value: normalizeEmail(username) || username,
        });
      }

      query += " ORDER BY c.createdAt DESC";

      const querySpec =
        parameters.length > 0 ? { query, parameters } : { query };

      const { resources } = await containerInstance.items
        .query(querySpec, {
          maxItemCount: 1000,
          enableCrossPartitionQuery: true,
        })
        .fetchAll();

      console.log(
        `✅ Retrieved ${resources.length} sessions from CosmosDB${username ? ` for user: ${username}` : ""}`
      );
      return resources.map((doc) =>
        finalizeSessionListSummary(doc as Record<string, unknown>)
      );
    } catch (error) {
      console.error("❌ Failed to get all sessions:", error);
      throw error;
    }
  }, 3, "getAllSessions");

  sessionListCache.set(cacheKey, { sessions, expiresAt: Date.now() + SESSION_LIST_CACHE_TTL_MS });
  return sessions;
};

/**
 * Get all sessions with pagination (optionally filtered by username)
 */
export const getAllSessionsPaginated = async (
  pageSize: number = 10,
  continuationToken?: string,
  username?: string
): Promise<{
  sessions: SessionListSummary[];
  continuationToken?: string;
  hasMoreResults: boolean;
}> => {
  try {
    const containerInstance = await waitForContainer();

    let query = SESSION_LIST_SELECT;
    const parameters: Array<{ name: string; value: any }> = [];

    if (username) {
      query +=
        " WHERE (ARRAY_CONTAINS(c.collaborators, @username) OR c.username = @username)";
      parameters.push({
        name: "@username",
        value: normalizeEmail(username) || username,
      });
    }

    query += " ORDER BY c.createdAt DESC";

    const queryOptions = {
      maxItemCount: pageSize,
      continuationToken,
      enableCrossPartitionQuery: true as const,
      ...(parameters.length > 0 && { parameters }),
    };

    const { resources, continuationToken: nextToken, hasMoreResults } =
      await containerInstance.items
        .query(
          parameters.length > 0 ? { query, parameters } : { query },
          queryOptions
        )
        .fetchNext();

    console.log(
      `✅ Retrieved ${resources.length} sessions (page size: ${pageSize})${username ? ` for user: ${username}` : ""}`
    );

    const sessions = resources.map((doc) =>
      finalizeSessionListSummary(doc as Record<string, unknown>)
    );

    return {
      sessions,
      continuationToken: nextToken,
      hasMoreResults: hasMoreResults || false,
    };
  } catch (error) {
    console.error("❌ Failed to get paginated sessions:", error);
    throw error;
  }
};

/**
 * Wave W61-list · light projection row for the admin semantic-model index
 * page. The full `semanticModel` payload is NOT loaded — only the counts
 * + metadata needed to render the list view. The detail page (W61-detail)
 * fetches the full payload per-session.
 *
 * `version` / `modelName` / `modelUpdatedAt` / `modelUpdatedBy` mirror the
 * `semanticModelSchema` fields; the *Count fields are server-computed via
 * Cosmos's `ARRAY_LENGTH` so the wire payload stays small even for sessions
 * with 100s of metrics + dimensions.
 */
export interface AdminSemanticModelListEntry {
  id: string;
  username: string;
  fileName: string;
  sessionId: string;
  lastUpdatedAt: number;
  version: number;
  modelName: string;
  /** ISO timestamp; absent for sessions where the inferred model has never been edited. */
  modelUpdatedAt?: string;
  /** Email of last editor; absent on freshly-inferred models. */
  modelUpdatedBy?: string;
  metricsCount: number;
  dimensionsCount: number;
  hierarchiesCount: number;
}

/**
 * Wave W61-list · the Cosmos SQL projection for the admin index page.
 *
 * Mirrors `SESSION_LIST_SELECT`'s shape: cherry-picks fields off the root
 * document + the nested `semanticModel` object, computes per-collection
 * counts via `IIF(IS_DEFINED ... AND IS_ARRAY, ARRAY_LENGTH, 0)` so a
 * legacy `semanticModel` with a missing array doesn't blow up the row.
 * `WHERE IS_DEFINED(c.semanticModel)` filters out the pre-W57 sessions
 * whose docs lack the field entirely.
 *
 * Returned as a single string (not a query object) so the caller can
 * compose it with parameters at the call site. Exported for the
 * source-inspection wing of the test.
 */
export const ADMIN_SEMANTIC_MODEL_LIST_SELECT = [
  "SELECT",
  "  c.id, c.username, c.fileName, c.sessionId, c.lastUpdatedAt,",
  "  c.semanticModel.version AS version,",
  "  c.semanticModel.name AS modelName,",
  "  c.semanticModel.updatedAt AS modelUpdatedAt,",
  "  c.semanticModel.updatedBy AS modelUpdatedBy,",
  "  IIF(IS_DEFINED(c.semanticModel.metrics) AND IS_ARRAY(c.semanticModel.metrics), ARRAY_LENGTH(c.semanticModel.metrics), 0) AS metricsCount,",
  "  IIF(IS_DEFINED(c.semanticModel.dimensions) AND IS_ARRAY(c.semanticModel.dimensions), ARRAY_LENGTH(c.semanticModel.dimensions), 0) AS dimensionsCount,",
  "  IIF(IS_DEFINED(c.semanticModel.hierarchies) AND IS_ARRAY(c.semanticModel.hierarchies), ARRAY_LENGTH(c.semanticModel.hierarchies), 0) AS hierarchiesCount",
  "FROM c",
  "WHERE IS_DEFINED(c.semanticModel)",
  "ORDER BY c.lastUpdatedAt DESC",
].join("\n");

/**
 * Wave W61-list · defensive finaliser for the admin projection row.
 *
 * Pure function — converts a raw Cosmos response (which can have any
 * `unknown` field shape if a document was corrupted or partially
 * written) into the typed `AdminSemanticModelListEntry`. Numbers coerce
 * via `Number(... ?? 0)`; optional strings only land if their type matches.
 * The defaults match the `semanticModelSchema` defaults so a row missing
 * `version` reads as `1` and a missing `modelName` reads as `"Default model"`.
 */
export const finalizeAdminSemanticModelEntry = (
  raw: Record<string, unknown>,
): AdminSemanticModelListEntry => ({
  id: String(raw.id ?? ""),
  username: String(raw.username ?? ""),
  fileName: String(raw.fileName ?? ""),
  sessionId: String(raw.sessionId ?? ""),
  lastUpdatedAt: Number(raw.lastUpdatedAt ?? 0),
  version: Number(raw.version ?? 1),
  modelName: String(raw.modelName ?? "Default model"),
  modelUpdatedAt:
    typeof raw.modelUpdatedAt === "string" ? raw.modelUpdatedAt : undefined,
  modelUpdatedBy:
    typeof raw.modelUpdatedBy === "string" ? raw.modelUpdatedBy : undefined,
  metricsCount: Number(raw.metricsCount ?? 0),
  dimensionsCount: Number(raw.dimensionsCount ?? 0),
  hierarchiesCount: Number(raw.hierarchiesCount ?? 0),
});

/**
 * Wave W61-list · returns every ChatDocument whose `semanticModel` field
 * is defined, projected to the lightweight index-row shape. The W61-list
 * admin page renders this; W61-detail fetches the full doc per-session.
 *
 * No caching here — the admin index page is a low-traffic surface and
 * staleness would surprise an admin who just edited a model. The
 * existing `sessionListCache` is owner-scoped (per-user); cache here
 * would be global and needs invalidation on every session edit, which
 * is not worth the complexity.
 */
export const getAllSessionsWithSemanticModel = async (): Promise<
  AdminSemanticModelListEntry[]
> => {
  return retryOnConnectionError(
    async () => {
      try {
        const containerInstance = await waitForContainer();
        // `enableCrossPartitionQuery` was dropped in Cosmos SDK v4 — cross-
        // partition is the default. Including it here would introduce a
        // new TS overload error (the existing pre-W61 query sites that
        // still pass it constitute the typecheck baseline).
        const { resources } = await containerInstance.items
          .query(
            { query: ADMIN_SEMANTIC_MODEL_LIST_SELECT },
            { maxItemCount: 1000 },
          )
          .fetchAll();
        console.log(
          `✅ Retrieved ${resources.length} semantic-model sessions from CosmosDB`,
        );
        return resources.map((doc) =>
          finalizeAdminSemanticModelEntry(doc as Record<string, unknown>),
        );
      } catch (error) {
        console.error(
          "❌ Failed to get sessions with semantic model:",
          error,
        );
        throw error;
      }
    },
    3,
    "getAllSessionsWithSemanticModel",
  );
};

/**
 * Get sessions with filtering options
 */
export const getSessionsWithFilters = async (options: {
  username?: string;
  fileName?: string;
  dateFrom?: number;
  dateTo?: number;
  limit?: number;
  orderBy?: 'createdAt' | 'lastUpdatedAt' | 'uploadedAt';
  orderDirection?: 'ASC' | 'DESC';
}): Promise<ChatDocument[]> => {
  try {
    const containerInstance = await waitForContainer();
    
    let query = "SELECT * FROM c WHERE 1=1";
    const parameters: Array<{ name: string; value: any }> = [];
    
    // Add filters based on options
    if (options.username) {
      query += " AND (ARRAY_CONTAINS(c.collaborators, @username) OR c.username = @username)";
      parameters.push({ name: "@username", value: normalizeEmail(options.username) || options.username });
    }
    
    if (options.fileName) {
      query += " AND CONTAINS(c.fileName, @fileName)";
      parameters.push({ name: "@fileName", value: options.fileName });
    }
    
    if (options.dateFrom) {
      query += " AND c.createdAt >= @dateFrom";
      parameters.push({ name: "@dateFrom", value: options.dateFrom });
    }
    
    if (options.dateTo) {
      query += " AND c.createdAt <= @dateTo";
      parameters.push({ name: "@dateTo", value: options.dateTo });
    }
    
    // Add ordering
    const orderBy = options.orderBy || 'createdAt';
    const orderDirection = options.orderDirection || 'DESC';
    query += ` ORDER BY c.${orderBy} ${orderDirection}`;
    
    // Add limit if specified
    if (options.limit) {
      query += ` OFFSET 0 LIMIT ${options.limit}`;
    }
    
    const queryOptions = options.limit ? { maxItemCount: options.limit } : {};
    
    const { resources } = await containerInstance.items
      .query(
        {
          query,
          parameters,
        },
        { ...queryOptions, enableCrossPartitionQuery: true }
      )
      .fetchAll();
    
    console.log(`✅ Retrieved ${resources.length} sessions with filters`);
    return resources.map((doc) => {
      const typed = doc as ChatDocument;
      ensureCollaborators(typed);
      return typed;
    });
  } catch (error) {
    console.error("❌ Failed to get filtered sessions:", error);
    throw error;
  }
};

/**
 * Get session statistics
 */
export const getSessionStatistics = async (): Promise<{
  totalSessions: number;
  totalUsers: number;
  totalMessages: number;
  totalCharts: number;
  sessionsByUser: Record<string, number>;
  sessionsByDate: Record<string, number>;
}> => {
  try {
    const allSessions = await getAllSessions();
    
    // Calculate statistics
    const totalSessions = allSessions.length;
    const uniqueUsers = new Set(allSessions.map(s => s.username));
    const totalUsers = uniqueUsers.size;
    
    const totalMessages = allSessions.reduce(
      (sum, session) => sum + session.messageCount,
      0
    );
    const totalCharts = allSessions.reduce(
      (sum, session) => sum + session.chartCount,
      0
    );
    
    // Sessions by user
    const sessionsByUser: Record<string, number> = {};
    allSessions.forEach(session => {
      sessionsByUser[session.username] = (sessionsByUser[session.username] || 0) + 1;
    });
    
    // Sessions by date (grouped by day)
    const sessionsByDate: Record<string, number> = {};
    allSessions.forEach(session => {
      const date = new Date(session.createdAt).toISOString().split('T')[0];
      sessionsByDate[date] = (sessionsByDate[date] || 0) + 1;
    });
    
    console.log(`✅ Generated session statistics: ${totalSessions} sessions, ${totalUsers} users`);
    
    return {
      totalSessions,
      totalUsers,
      totalMessages,
      totalCharts,
      sessionsByUser,
      sessionsByDate,
    };
  } catch (error) {
    console.error("❌ Failed to get session statistics:", error);
    throw error;
  }
};

/**
 * Generate column statistics for numeric columns
 */
export const generateColumnStatistics = (data: Record<string, any>[], numericColumns: string[]): Record<string, any> => {
  const stats: Record<string, any> = {};
  
  for (const column of numericColumns) {
    const values = data.map(row => Number(row[column])).filter(v => !isNaN(v));
    
    if (values.length > 0) {
      const sortedValues = [...values].sort((a, b) => a - b);
      const sum = values.reduce((a, b) => a + b, 0);
      const mean = sum / values.length;
      
      // Calculate median
      const mid = Math.floor(sortedValues.length / 2);
      const median = sortedValues.length % 2 === 0 
        ? (sortedValues[mid - 1] + sortedValues[mid]) / 2 
        : sortedValues[mid];
      
      // Calculate standard deviation
      const variance = values.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / values.length;
      const standardDeviation = Math.sqrt(variance);
      
      // Calculate quartiles
      const q1Index = Math.floor(sortedValues.length * 0.25);
      const q3Index = Math.floor(sortedValues.length * 0.75);
      const q1 = sortedValues[q1Index];
      const q3 = sortedValues[q3Index];
      
      // Calculate min/max without spread operator to avoid stack overflow on large arrays
      let min = values[0];
      let max = values[0];
      for (let i = 1; i < values.length; i++) {
        if (values[i] < min) min = values[i];
        if (values[i] > max) max = values[i];
      }
      
      stats[column] = {
        count: values.length,
        min: min,
        max: max,
        sum: sum,
        mean: Number(mean.toFixed(2)),
        median: Number(median.toFixed(2)),
        standardDeviation: Number(standardDeviation.toFixed(2)),
        q1: Number(q1.toFixed(2)),
        q3: Number(q3.toFixed(2)),
        range: max - min,
        variance: Number(variance.toFixed(2))
      };
    }
  }
  
  return stats;
};

