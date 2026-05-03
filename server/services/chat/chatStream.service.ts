/**
 * Chat Stream Service
 * Handles streaming chat operations with SSE
 */
import { AgentWorkbenchEntry, Message, ThinkingStep } from "../../shared/schema.js";
import { answerQuestion } from "../../lib/dataAnalyzer.js";
import { generateAISuggestions } from "../../lib/suggestionGenerator.js";
import { 
  getChatBySessionIdForUser, 
  addMessagesBySessionId, 
  updateMessageAndTruncate,
  getChatBySessionIdEfficient,
  setPendingUserMessageForSession,
  ChatDocument 
} from "../../models/chat.model.js";
import { loadChartsFromBlob } from "../../lib/blobStorage.js";
import { enrichCharts, enrichPivotInsightFromEnvelope, validateAndEnrichResponse } from "./chatResponse.service.js";
import { attachAutoLayers } from "../../lib/charts/autoAttachLayers.js";
import { sendSSE, setSSEHeaders, startSseKeepalive } from "../../utils/sse.helper.js";
import { resolveAnswerQuestionDataLoad } from "./answerQuestionContext.js";
import { classifyMode } from "../../lib/agents/modeClassifier.js";
import { extractColumnsFromMessage } from "../../lib/columnExtractor.js";
import { analyzeChatWithColumns } from "../../lib/chatAnalyzer.js";
import { bindSchemaColumnsForAgentic } from "../../lib/schemaColumnBinding.js";
import { parseUserQuery } from "../../lib/queryParser.js";
import { extractColumnsFromHistory } from "../../lib/agents/utils/columnExtractor.js";
import { isAgenticLoopEnabled } from "../../lib/agents/runtime/types.js";
import {
  persistMidTurnAssistantSessionContext,
  extractAndPersistUserHierarchies,
} from "../../lib/sessionAnalysisContext.js";
import { preserveFinalPreview } from "./previewRetention.js";
import { Response } from "express";
import {
  agentSseEventToWorkbenchEntries,
  appendWorkbenchEntry,
} from "./agentWorkbench.util.js";
import { allowedColumnNamesForQueryPlan } from "../../lib/queryPlanExecutor.js";
import {
  derivePivotDefaultsFromExecutionMerged,
  type PivotDefaultsRowsValues,
} from "../../lib/pivotDefaultsFromExecution.js";
import { extractRankingIntent } from "../../lib/agents/runtime/planArgRepairs.js";
import type { RankingMeta } from "../../shared/schema.js";
import { upsertPastAnalysisDoc } from "../../models/pastAnalysis.model.js";
import { appendMemoryEntries } from "../../models/analysisMemory.model.js";
import { scheduleIndexMemoryEntries } from "../../lib/rag/indexSession.js";
import { buildTurnEndMemoryEntries } from "../../lib/agents/runtime/memoryEntryBuilders.js";
import type { PastAnalysisDoc, PastAnalysisOutcome, ChartSpec } from "../../shared/schema.js";
import { takeTurnTotals } from "../../lib/telemetry/turnUsageAggregator.js";
import { indexPastAnalysis } from "../../lib/rag/pastAnalysesStore.js";
import { normalizeQuestionForCache } from "../../lib/cache/normalizeQuestion.js";
import { recordTurnSpend } from "../../models/userBudget.model.js";
import { recordAndCheckTurn as recordAndCheckCostAnomaly } from "../../lib/telemetry/costAnomalyDetector.js";
import {
  tryExactQuestionCacheHit,
  trySemanticQuestionCacheHit,
  type CacheHit,
} from "../../lib/cache/questionCacheLookup.js";
import { normalizePivotValueFieldForBaseTable } from "../../lib/pivotDefaultsFromPreview.js";
import type { DimensionFilter } from "../../shared/queryTypes.js";
import {
  mergePivotSliceDefaults,
  pivotSliceDefaultsFromDimensionFilters,
} from "../../lib/pivotSliceDefaultsFromDimensionFilters.js";
import { mergeIntermediateSegmentPivotDefaults } from "../../lib/diagnosticIntermediatePivot.js";
import {
  sanitisePivotColumnDimensionsInput,
  suggestPivotColumnsFromDimensions,
} from "../../lib/pivotLayoutFromDimensions.js";
import {
  filterProvisionalPivotDefaultsToPreviewKeys,
  intermediatePreviewSignature,
  shouldEmitIntermediatePivotFlush,
} from "./intermediatePivotPolicy.js";

export interface ProcessStreamChatParams {
  sessionId: string;
  message: string;
  targetTimestamp?: number;
  username: string;
  res: Response;
  /** @deprecated Ignored for routing — classifyMode always runs. Accepted for backward compatibility. */
  mode?: 'general' | 'analysis' | 'dataOps' | 'modeling';
}


/**
 * W5.2 · Short-circuit the chat-stream handler when an exact cache match exists.
 * Sends the cached answer over SSE, persists the user/assistant pair, and
 * returns `true` when served; returns `false` on miss (caller continues with
 * the normal agent path).
 *
 * Why this sits here: we want zero LLM cost when a cache hit is found.
 * Placing the check after chatDocument load but before classifyMode /
 * schemaBind / answerQuestion means the hit-path performs no LLM calls.
 */
async function serveCachedExactAnswer(params: {
  hit: CacheHit;
  res: Response;
  sessionId: string;
  username: string;
  userMessage: string;
  chatDocument: ChatDocument;
}): Promise<void> {
  const { hit, res, sessionId, username, userMessage, chatDocument } = params;
  const cachedAnswer = hit.doc.answer || "";

  // Informational SSE for telemetry / UI — purely additive, clients can ignore.
  sendSSE(res, "cache_hit", {
    source: hit.source,
    ageMs: hit.ageMs,
    sourceTurnId: hit.doc.turnId,
    dataVersion: hit.doc.dataVersion,
  });

  // Build a minimal response envelope. Clients that already handle the non-
  // cached shape render this correctly — unused fields are simply empty.
  sendSSE(res, "response", {
    answer: cachedAnswer,
    charts: [],
    suggestions: [],
    cached: true,
    cachedAgeMs: hit.ageMs,
    cachedSourceTurnId: hit.doc.turnId,
  });
  sendSSE(res, "done", {});

  // Persist the pair of messages so the session history stays correct across
  // cache hits. Missing charts/insights on the assistant row are acceptable —
  // the original doc still exists in past_analyses + Cosmos for audit.
  try {
    const nowMs = Date.now();
    await addMessagesBySessionId(sessionId, [
      { role: "user" as const, content: userMessage, timestamp: nowMs - 1 },
      {
        role: "assistant" as const,
        content: cachedAnswer,
        timestamp: nowMs,
      },
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`⚠️ cache-hit message persist failed for ${chatDocument.id}: ${msg}`);
  }

  if (!res.writableEnded && !res.destroyed) {
    res.end();
  }
  // Identity hint in the log for rollup dashboards.
  console.log(
    `💡 served from ${hit.source} cache (ageMs=${hit.ageMs}, sourceTurnId=${hit.doc.turnId}, user=${username})`
  );
}

function hashArgs(args: unknown): string {
  try {
    const s = JSON.stringify(args) ?? "";
    // Simple FNV-1a 32-bit — cheap, deterministic, good enough for dedup.
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
  } catch {
    return "";
  }
}

function classifyTurnOutcome(
  transformedResponse: { answer?: unknown; error?: unknown }
): PastAnalysisOutcome {
  const answer = typeof transformedResponse.answer === "string" ? transformedResponse.answer : "";
  if (/^The analysis agent encountered an error/i.test(answer)) return "verifier_failed";
  if (transformedResponse.error) return "tool_error";
  return "ok";
}

/**
 * Fire-and-forget writer for the `past_analyses` row after a completed turn.
 * Swallows every error internally — telemetry / cache data must never affect
 * the live turn's response path.
 */
function maybeWritePastAnalysisDoc(params: {
  sessionId: string;
  userId: string;
  question: string;
  transformedResponse: any;
  chatDocument: ChatDocument;
  turnStartedAt: number;
}): void {
  if (process.env.PAST_ANALYSIS_WRITER_ENABLED === "false") return;
  try {
    const turnId: string | undefined = params.transformedResponse?.agentTrace?.turnId;
    if (!turnId) return; // non-agentic paths (legacy) — skip for now
    const totals = takeTurnTotals(turnId);
    const answer = typeof params.transformedResponse.answer === "string"
      ? params.transformedResponse.answer
      : "";
    const charts = Array.isArray(params.transformedResponse.charts)
      ? (params.transformedResponse.charts as ChartSpec[])
      : undefined;
    const toolCalls: PastAnalysisDoc["toolCalls"] = (params.transformedResponse?.agentTrace?.toolCalls || [])
      .slice(0, 40) // cap to keep Cosmos row small
      .map((tc: any) => ({
        id: String(tc?.id ?? ""),
        tool: String(tc?.tool ?? ""),
        argsHash: hashArgs(tc?.args),
        ok: Boolean(tc?.ok ?? true),
      }));
    const dataVersion =
      params.chatDocument.currentDataBlob?.version ??
      params.chatDocument.ragIndex?.dataVersion ??
      0;
    const doc: PastAnalysisDoc = {
      id: `${params.sessionId}__${turnId}`,
      sessionId: params.sessionId,
      userId: params.userId.toLowerCase(),
      turnId,
      dataVersion,
      question: params.question,
      normalizedQuestion: normalizeQuestionForCache(params.question),
      answer,
      charts,
      toolCalls,
      costUsd: totals?.costUsd ?? 0,
      latencyMs: Date.now() - params.turnStartedAt,
      tokenTotals: {
        input: totals?.tokensInput ?? 0,
        output: totals?.tokensOutput ?? 0,
      },
      outcome: classifyTurnOutcome(params.transformedResponse),
      feedback: "none",
      // W32 · explicit empty array matches what the schema's `.default([])`
      // would produce; satisfies the inferred output type which has the
      // field as required `string[]` (the input type is optional). Real
      // reasons are appended later via the model's patch helper
      // (`pastAnalysis.model.ts: persistFeedbackReasons`).
      feedbackReasons: [],
      feedbackDetails: [],
      createdAt: Date.now(),
    };
    // W6.2 · accumulate cost/tokens against today's user budget. Fire-and-forget;
    // recordTurnSpend swallows its own errors. Done in parallel with the
    // past_analyses write so neither blocks the other.
    void recordTurnSpend({
      userEmail: params.userId,
      costUsd: totals?.costUsd ?? 0,
      tokensInput: totals?.tokensInput ?? 0,
      tokensOutput: totals?.tokensOutput ?? 0,
    });
    // W6.3 · check the per-turn cost ceiling. Fires only on outliers above
    // COST_ALERT_PER_TURN_USD; persists to cost_alerts container + console.error.
    void recordAndCheckCostAnomaly({
      turnId,
      userEmail: params.userId,
      sessionId: params.sessionId,
    });
    void upsertPastAnalysisDoc(doc)
      .then(() => {
        // W2.4 · mirror into the AI Search index for the semantic cache.
        // Gated by PAST_ANALYSES_INDEX_ENABLED (default off until the index
        // exists and has been created via `npm run create-past-analyses-index`).
        if (process.env.PAST_ANALYSES_INDEX_ENABLED !== "true") return;
        return indexPastAnalysis(doc);
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`⚠️ past_analyses persist failed for turn ${turnId}: ${msg}`);
      });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`⚠️ past_analyses write preflight failed: ${msg}`);
  }
}

function readDimensionFiltersFromParsed(
  parsedQuery: Record<string, unknown> | null | undefined
): DimensionFilter[] | undefined {
  if (!parsedQuery) return undefined;
  const raw = parsedQuery.dimensionFilters;
  if (!Array.isArray(raw)) return undefined;
  const out: DimensionFilter[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (typeof o.column !== "string") continue;
    if (o.op !== "in" && o.op !== "not_in") continue;
    if (!Array.isArray(o.values)) continue;
    out.push({
      column: o.column,
      op: o.op as "in" | "not_in",
      values: o.values.map((v) => String(v)),
      match:
        o.match === "exact" ||
        o.match === "case_insensitive" ||
        o.match === "contains"
          ? o.match
          : undefined,
    });
  }
  return out.length ? out : undefined;
}

export function mergePivotDefaultsForResponse(params: {
  dataSummary: ChatDocument["dataSummary"];
  parsedQuery: Record<string, unknown> | null;
  parserPivot: Message["pivotDefaults"] | undefined;
  executionPivot: PivotDefaultsRowsValues | undefined;
}): Message["pivotDefaults"] | undefined {
  const { dataSummary, parsedQuery, parserPivot, executionPivot } = params;
  // Scalar agent answers (single-row aggregate, no group-by) must not fabricate
  // row dimensions from the parser's schema heuristic — suppress the pivot.
  if (executionPivot?.scalar === true) {
    return undefined;
  }
  const finalRows = executionPivot?.rows?.length
    ? executionPivot.rows
    : parserPivot?.rows;
  const finalValues = executionPivot?.values?.length
    ? executionPivot.values
    : parserPivot?.values;
  const hasRows = finalRows && finalRows.length > 0;
  const hasValues = finalValues && finalValues.length > 0;
  if (!hasRows && !hasValues) return undefined;

  const finalColumns =
    executionPivot?.columns?.length
      ? executionPivot.columns
      : parserPivot?.columns;
  const colKeys = finalColumns?.length ? finalColumns : [];

  const parserSlice = pivotSliceDefaultsFromDimensionFilters(
    dataSummary,
    readDimensionFiltersFromParsed(parsedQuery),
    finalRows ?? [],
    colKeys
  );
  const mergedSlice = mergePivotSliceDefaults(parserSlice, {
    filterFields: executionPivot?.filterFields ?? [],
    filterSelections: executionPivot?.filterSelections ?? {},
  });

  const out: Message["pivotDefaults"] = {
    rows: finalRows ?? [],
    values: finalValues ?? [],
  };
  if (colKeys.length) {
    out.columns = colKeys;
  }
  if (mergedSlice.filterFields.length) {
    out.filterFields = mergedSlice.filterFields;
  }
  if (Object.keys(mergedSlice.filterSelections).length) {
    out.filterSelections = mergedSlice.filterSelections;
  }
  return out;
}

function userExplicitlyAskedForColumnsOrPreview(text: string): boolean {
  const q = String(text || "").toLowerCase();
  return (
    /\b(columns?|column names?|schema|field list|show fields)\b/.test(q) ||
    /\b(preview|sample rows?|show rows?|show data|data preview)\b/.test(q)
  );
}

function derivePivotDefaultsHint(params: {
  parsedQuery: Record<string, unknown> | null;
  requiredColumns: string[];
  dataSummary: ChatDocument["dataSummary"];
}): Message["pivotDefaults"] | undefined {
  const { parsedQuery, requiredColumns, dataSummary } = params;
  const allowed = allowedColumnNamesForQueryPlan(dataSummary);
  const numeric = new Set(dataSummary.numericColumns || []);
  const dateColumns = new Set(dataSummary.dateColumns || []);

  const rows: string[] = [];
  const values: string[] = [];
  const seenRows = new Set<string>();
  const seenValues = new Set<string>();

  const addRow = (col: string) => {
    if (!allowed.has(col) || numeric.has(col) || seenRows.has(col)) return;
    seenRows.add(col);
    rows.push(col);
  };
  const addValue = (col: string) => {
    if (!allowed.has(col) || !numeric.has(col) || seenValues.has(col)) return;
    seenValues.add(col);
    values.push(col);
  };

  const groupBy = Array.isArray(parsedQuery?.groupBy)
    ? (parsedQuery!.groupBy as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
  for (const col of groupBy) addRow(col);

  const aggregations = Array.isArray(parsedQuery?.aggregations)
    ? (parsedQuery!.aggregations as Array<{ column?: unknown }>)
    : [];
  for (const agg of aggregations) {
    if (typeof agg?.column === "string") addValue(agg.column);
  }

  const requiredDimensionColumns = requiredColumns.filter(
    (col) => allowed.has(col) && !numeric.has(col)
  );
  const requiredDateDims = requiredDimensionColumns.filter((col) => dateColumns.has(col));
  // Only backfill row dimensions from required columns when parsed groupBy didn't
  // provide valid row hints. This keeps intent-derived dimensions in the first slot.
  if (rows.length === 0) {
    for (const col of [...requiredDateDims, ...requiredDimensionColumns]) addRow(col);
  }
  for (const col of requiredColumns) addValue(col);

  if (rows.length === 0 && values.length === 0) return undefined;

  const pcd = sanitisePivotColumnDimensionsInput(
    parsedQuery?.pivotColumnDimensions,
    dataSummary
  );
  const laid = suggestPivotColumnsFromDimensions({
    rowCandidates: rows,
    dataSummary,
    pivotColumnDimensions: pcd.length ? pcd : undefined,
  });
  const rowFinal = laid.rows;
  const columnsFinal = laid.columns;

  const seenNorm = new Set<string>();
  const normalizedValues: string[] = [];
  for (const v of values) {
    const n = normalizePivotValueFieldForBaseTable(v, dataSummary);
    if (seenNorm.has(n)) continue;
    seenNorm.add(n);
    normalizedValues.push(n);
  }
  const slice = pivotSliceDefaultsFromDimensionFilters(
    dataSummary,
    readDimensionFiltersFromParsed(parsedQuery),
    rowFinal,
    columnsFinal
  );
  const hint: Message["pivotDefaults"] = {
    rows: rowFinal,
    values: normalizedValues,
  };
  if (columnsFinal.length) {
    hint.columns = columnsFinal;
  }
  if (slice.filterFields.length) {
    hint.filterFields = slice.filterFields;
  }
  if (Object.keys(slice.filterSelections).length) {
    hint.filterSelections = slice.filterSelections;
  }
  if (process.env.NODE_ENV !== "production") {
    console.debug("[chatStream] pivotDefaults hint", {
      groupBy,
      requiredColumns: requiredColumns.slice(0, 8),
      rows: hint.rows,
      columns: hint.columns,
      values: hint.values,
      filterFields: hint.filterFields,
      filterSelections: hint.filterSelections,
    });
  }
  return hint;
}

function derivePivotDefaultsFromExecution(params: {
  agentTrace?: Record<string, unknown>;
  table?: unknown;
  dataSummary: ChatDocument["dataSummary"];
}): PivotDefaultsRowsValues | undefined {
  return derivePivotDefaultsFromExecutionMerged(
    params.dataSummary,
    params.agentTrace,
    params.table
  );
}

/**
 * Process a streaming chat message
 */
export async function processStreamChat(params: ProcessStreamChatParams): Promise<void> {
  const { sessionId, message, targetTimestamp, username, res, mode } = params;

  // Set SSE headers
  setSSEHeaders(res);

  // W10: keepalive comment every 15s to prevent proxy timeouts on long investigations.
  const stopKeepalive = startSseKeepalive(res);

  // Track if client disconnected
  let clientDisconnected = false;

  // F3 · AbortController fired on client disconnect, forwarded into runAgentTurn
  // via ctx.abortSignal so the agent loop can exit early instead of burning
  // LLM budget after the user hangs up.
  const turnAbortController = new AbortController();

  // Handle client disconnect/abort
  const checkConnection = (): boolean => {
    if (res.writableEnded || res.destroyed || !res.writable) {
      clientDisconnected = true;
      return false;
    }
    return true;
  };

  // Set up connection close handlers
  res.on('close', () => {
    clientDisconnected = true;
    if (!turnAbortController.signal.aborted) {
      turnAbortController.abort();
    }
    // res.writableEnded is true when the server called res.end() — that's an expected
    // close, not a client abort. Only log when the client disconnected before we finished.
    if (!res.writableEnded) {
      console.log('🚫 Client disconnected from chat stream early');
    }
  });

  res.on('error', (error: any) => {
    // ECONNRESET, EPIPE, ECONNABORTED are expected when client disconnects
    if (error.code !== 'ECONNRESET' && error.code !== 'EPIPE' && error.code !== 'ECONNABORTED') {
      console.error('SSE connection error:', error);
    }
    clientDisconnected = true;
  });

  try {
    // Get chat document FIRST (with full history) so processing uses complete context
    console.log('🔍 Fetching chat document for sessionId:', sessionId);
    let chatDocument: ChatDocument | null = null;
    
    try {
      chatDocument = await getChatBySessionIdForUser(sessionId, username);
    } catch (dbError: any) {
      // Handle CosmosDB connection errors gracefully
      const errorMessage = dbError instanceof Error ? dbError.message : String(dbError);
      if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('ETIMEDOUT') || dbError.code === 'ECONNREFUSED') {
        console.error('❌ CosmosDB connection error, attempting to continue with blob storage data...');
        sendSSE(res, 'error', {
          error: 'Database connection issue. Please try again in a moment. If the problem persists, check your network connection.',
        });
        res.end();
        return;
      }
      // Re-throw non-connection errors
      throw dbError;
    }

    if (!chatDocument) {
      sendSSE(res, 'error', { error: 'Session not found. Please upload a file first.' });
      res.end();
      return;
    }

    console.log('✅ Chat document found');

    const enrichment = chatDocument.enrichmentStatus;
    if (enrichment === "pending" || enrichment === "in_progress") {
      await setPendingUserMessageForSession(sessionId, username, message);
      sendSSE(res, "queued", {
        reason: "enrichment",
        message:
          "Your message is queued until we finish understanding your data. You will see the reply shortly.",
      });
      res.end();
      return;
    }
    if (enrichment === "failed") {
      sendSSE(res, "error", {
        error:
          "Data enrichment failed for this session. Please try uploading your file again.",
      });
      res.end();
      return;
    }

    // W5.2 · exact-match question cache. No LLM calls on a hit — the cached
    // answer streams back and we persist the user/assistant pair. Feature-
    // flagged via QUESTION_CACHE_EXACT_ENABLED; returns null + no-ops when off.
    const cacheDataVersion =
      chatDocument.currentDataBlob?.version ??
      chatDocument.ragIndex?.dataVersion ??
      0;
    const exactHit = await tryExactQuestionCacheHit({
      sessionId,
      dataVersion: cacheDataVersion,
      question: message,
    });
    if (exactHit) {
      await serveCachedExactAnswer({
        hit: exactHit,
        res,
        sessionId,
        username,
        userMessage: message,
        chatDocument,
      });
      return;
    }
    // W5.3 · semantic-similarity cache. Runs only after exact missed so we
    // never pay the embedding call when the cheaper lookup already answered.
    const semanticHit = await trySemanticQuestionCacheHit({
      sessionId,
      dataVersion: cacheDataVersion,
      question: message,
    });
    if (semanticHit) {
      await serveCachedExactAnswer({
        hit: semanticHit,
        res,
        sessionId,
        username,
        userMessage: message,
        chatDocument,
      });
      return;
    }

    // Get chat-level insights
    const chatLevelInsights = chatDocument.insights && Array.isArray(chatDocument.insights) && chatDocument.insights.length > 0
      ? chatDocument.insights
      : undefined;

    // Track thinking steps
    const thinkingSteps: ThinkingStep[] = [];
    const agentWorkbench: AgentWorkbenchEntry[] = [];

    type PendingIntermediate = {
      assistantTimestamp: number;
      preview: Record<string, unknown>[];
      previewSignature: string;
      thinkingSteps: ThinkingStep[];
      workbench: AgentWorkbenchEntry[];
      pivotDefaults?: Message["pivotDefaults"];
      insight?: string;
    };
    const pendingIntermediates: PendingIntermediate[] = [];
    let intermediateSeq = 0;
    let provisionalPivotDefaults: Message["pivotDefaults"] | undefined;
    let parsedQueryForLoad: Record<string, unknown> | null = null;

    // P-025: cap intermediate preview row count so an aggressive pivot cannot
    // stream a 100k-row SSE frame. Explicit cap keeps the envelope <~1 MB.
    const INTERMEDIATE_PREVIEW_ROW_CAP = Number(
      process.env.AGENT_INTERMEDIATE_PREVIEW_ROW_CAP || 1000
    );

    const flushIntermediateSegment = (
      rawPreview: Record<string, unknown>[],
      insight?: string,
      segmentPivotDefaults?: Message["pivotDefaults"],
      executionScalar?: boolean
    ) => {
      if (!rawPreview.length) return;
      if (!checkConnection()) return;
      const preview =
        rawPreview.length > INTERMEDIATE_PREVIEW_ROW_CAP
          ? rawPreview.slice(0, INTERMEDIATE_PREVIEW_ROW_CAP)
          : rawPreview;
      const previewTruncated = preview.length < rawPreview.length;
      const priorTail = pendingIntermediates[pendingIntermediates.length - 1];
      if (
        !shouldEmitIntermediatePivotFlush({
          priorPendingTail: priorTail
            ? { preview: priorTail.preview, previewSignature: priorTail.previewSignature }
            : undefined,
          incoming: { preview },
        })
      ) {
        return;
      }
      const assistantTimestamp = Date.now() + intermediateSeq++;
      const snapSteps = [...thinkingSteps];
      const snapWb = [...agentWorkbench];
      let pivotDefaultsForSegment: Message["pivotDefaults"] | undefined;
      if (segmentPivotDefaults?.rows?.length && segmentPivotDefaults?.values?.length) {
        pivotDefaultsForSegment = mergeIntermediateSegmentPivotDefaults({
          dataSummary: chatDocument.dataSummary,
          userMessage: message,
          parsedQuery: parsedQueryForLoad,
          segmentPivot: segmentPivotDefaults,
        });
      } else if (executionScalar === true) {
        // Scalar agent step (single-row aggregate, no row dims). Suppress the
        // pivot/chart entirely — the schema-heuristic fallback would render a
        // misleading multi-dim view unrelated to the question.
        pivotDefaultsForSegment = undefined;
      } else {
        pivotDefaultsForSegment = filterProvisionalPivotDefaultsToPreviewKeys(
          provisionalPivotDefaults,
          preview
        );
      }
      if (
        !sendSSE(res, "intermediate", {
          preview,
          thinkingSteps: snapSteps,
          workbench: snapWb,
          assistantTimestamp,
          ...(pivotDefaultsForSegment ? { pivotDefaults: pivotDefaultsForSegment } : {}),
          ...(insight ? { insight } : {}),
          ...(previewTruncated
            ? {
                previewTruncated: true,
                previewTotalRows: rawPreview.length,
              }
            : {}),
        })
      ) {
        return;
      }
      pendingIntermediates.push({
        assistantTimestamp,
        preview,
        previewSignature: intermediatePreviewSignature(preview),
        thinkingSteps: snapSteps,
        workbench: snapWb,
        pivotDefaults: pivotDefaultsForSegment,
        insight,
      });
      thinkingSteps.length = 0;
      agentWorkbench.length = 0;
    };

    // Create callback to emit thinking steps
    const onThinkingStep = (step: ThinkingStep) => {
      thinkingSteps.push(step);
      sendSSE(res, 'thinking', step);
    };

    // Check connection before processing
    if (!checkConnection()) {
      return;
    }

    const allMessages = chatDocument.messages || [];
    const processingChatHistory = targetTimestamp
      ? allMessages
      : allMessages.slice(-15);
    const modeDetectionChatHistory = processingChatHistory;

    const availableColumns = chatDocument.dataSummary.columns.map((c) => c.name);

    onThinkingStep({
      step: "Mapping columns from schema",
      status: "active",
      timestamp: Date.now(),
    });

    const schemaBinding = await bindSchemaColumnsForAgentic(
      message,
      chatDocument.dataSummary,
      processingChatHistory
    );
    console.log(`📌 Schema binding canonical columns:`, schemaBinding.canonicalColumns);

    onThinkingStep({
      step: "Mapping columns from schema",
      status: "completed",
      timestamp: Date.now(),
      details:
        schemaBinding.canonicalColumns.length > 0
          ? `Columns: ${schemaBinding.canonicalColumns.join(", ")}`
          : "Using full schema fallback",
    });

    const extractedColumns = extractColumnsFromMessage(message, availableColumns);
    const columnHintsForIntent = Array.from(
      new Set([...schemaBinding.canonicalColumns, ...extractedColumns])
    );

    onThinkingStep({
      step: "Analyzing user intent",
      status: "active",
      timestamp: Date.now(),
    });

    let chatAnalysis;
    try {
      chatAnalysis = await analyzeChatWithColumns(
        message,
        columnHintsForIntent,
        chatDocument.dataSummary
      );
      const mergedRelevant = Array.from(
        new Set([
          ...schemaBinding.canonicalColumns,
          ...chatAnalysis.relevantColumns,
        ])
      );
      chatAnalysis = { ...chatAnalysis, relevantColumns: mergedRelevant };

      console.log(`🤖 AI Analysis Results:`);
      console.log(`   Intent: ${chatAnalysis.intent}`);
      console.log(`   User Intent: ${chatAnalysis.userIntent}`);
      console.log(`   Relevant Columns:`, chatAnalysis.relevantColumns);
      console.log(`   Analysis: ${chatAnalysis.analysis.substring(0, 200)}...`);

      onThinkingStep({
        step: "Analyzing user intent",
        status: "completed",
        timestamp: Date.now(),
        details: `Intent: ${chatAnalysis.intent}`,
      });
    } catch (error) {
      console.error("⚠️ Chat analysis failed:", error);
      onThinkingStep({
        step: "Analyzing user intent",
        status: "completed",
        timestamp: Date.now(),
        details: "Intent classification failed; using bound columns",
      });
      chatAnalysis = {
        intent: "general",
        analysis: "",
        relevantColumns:
          schemaBinding.canonicalColumns.length > 0
            ? schemaBinding.canonicalColumns
            : extractedColumns,
        userIntent: message,
      };
    }

    console.log(`📊 Column binding & analysis summary:`);
    console.log(
      `   Canonical (schema): ${schemaBinding.canonicalColumns.join(", ") || "(none)"}`
    );
    console.log(
      `   Final relevant: ${chatAnalysis.relevantColumns.join(", ") || "(none)"}`
    );

    try {
      // W32 · `parseUserQuery` returns `QueryParserResult` (extends
      // `ParsedQuery` + `confidence: number`); the local var is widened
      // to `Record<string, unknown> | null` because four downstream sites
      // also use the generic-record shape. Cast at the assignment matches
      // the W27 `agentTrace` pattern — the runtime payload IS a
      // serialisable record, just statically tracked under a richer type.
      parsedQueryForLoad = (await parseUserQuery(
        message,
        chatDocument.dataSummary,
        processingChatHistory
      )) as unknown as Record<string, unknown>;
    } catch {
      parsedQueryForLoad = null;
    }

    const historyColumns = extractColumnsFromHistory(
      processingChatHistory,
      chatDocument.dataSummary
    );
    const requiredColumnsForLoad = Array.from(
      new Set([
        ...schemaBinding.canonicalColumns,
        ...historyColumns,
      ])
    );
    provisionalPivotDefaults = derivePivotDefaultsHint({
      parsedQuery: parsedQueryForLoad,
      requiredColumns: schemaBinding.canonicalColumns,
      dataSummary: chatDocument.dataSummary,
    });
    if (process.env.NODE_ENV !== "production") {
      console.debug("[chatStream] pivot pre-fallback inputs", {
        parserGroupBy: Array.isArray((parsedQueryForLoad as any)?.groupBy)
          ? (parsedQueryForLoad as any).groupBy
          : [],
        canonicalColumns: schemaBinding.canonicalColumns.slice(0, 8),
        mapping: schemaBinding.columnMapping,
        provisionalPivotDefaults,
      });
    }

    // Routing: always classify — client `mode` is ignored (deprecated override removed).
    if (mode != null && mode !== 'general') {
      console.debug(
        `[chat/stream] mode_override_ignored: received ${JSON.stringify(mode)} — using classifyMode only`
      );
    }

    let detectedMode: 'analysis' | 'dataOps' | 'modeling' = 'analysis';
    try {
      onThinkingStep({
        step: 'Detecting query type',
        status: 'active',
        timestamp: Date.now(),
      });

      const modeClassification = await classifyMode(
        message,
        modeDetectionChatHistory,
        chatDocument.dataSummary
      );

      detectedMode = modeClassification.mode;

      onThinkingStep({
        step: 'Detecting query type',
        status: 'completed',
        timestamp: Date.now(),
        details: `Detected: ${detectedMode} (confidence: ${(modeClassification.confidence * 100).toFixed(0)}%)`,
      });

      console.log(
        `🎯 Classified mode: ${detectedMode} (confidence: ${modeClassification.confidence.toFixed(2)})`
      );
    } catch (error) {
      console.error('⚠️ Mode classification failed, defaulting to analysis:', error);
      onThinkingStep({
        step: 'Detecting query type',
        status: 'completed',
        timestamp: Date.now(),
        details: 'Using default: analysis',
      });
      detectedMode = 'analysis';
    }

    // H5 · before the agent loop runs, check if the user message declares
    // a dimension hierarchy ("X is the category", "Y is rolled up", ...).
    // Cheap regex pre-check skips the LLM call on routine analytical
    // questions; on a hit, the merged SAC (with new dimensionHierarchies)
    // is persisted to Cosmos so the agent loop and post-turn assistant
    // merge both see it. The H2 immutability guard stops the assistant
    // merge from wiping it.
    try {
      const userMergedSAC = await extractAndPersistUserHierarchies({
        sessionId,
        username,
        userMessage: message,
        previous: chatDocument.sessionAnalysisContext,
      });
      if (userMergedSAC) {
        chatDocument.sessionAnalysisContext = userMergedSAC;
        sendSSE(res, "session_context_updated", {
          dimensionHierarchies:
            userMergedSAC.dataset?.dimensionHierarchies ?? [],
          priorInvestigations:
            userMergedSAC.sessionKnowledge?.priorInvestigations ?? [],
        });
      }
    } catch (err) {
      console.warn("⚠️ user-hierarchy extraction skipped:", err);
    }

    onThinkingStep({
      step: 'Loading dataset',
      status: 'active',
      timestamp: Date.now(),
    });
    const { latestData, columnarStoragePathOpt, loadFullDataOpt, permanentContext, sessionAnalysisContext } =
      await resolveAnswerQuestionDataLoad({
        chatDocument,
        message,
        processingChatHistory,
        precomputed: {
          requiredColumns: requiredColumnsForLoad,
          parsedQuery: parsedQueryForLoad,
        },
      });
    {
      const rowCount = Array.isArray(latestData) ? latestData.length : 0;
      const colCount = chatDocument.dataSummary?.columns?.length ?? 0;
      onThinkingStep({
        step: 'Loading dataset',
        status: 'completed',
        timestamp: Date.now(),
        details:
          rowCount && colCount
            ? `${rowCount.toLocaleString()} rows · ${colCount} columns`
            : undefined,
      });
    }

    // Hoisted so flow_decision events fire on both agentic and legacy paths.
    const onAgentEvent = (event: string, data: unknown) => {
      if (!checkConnection()) return;
      if (event === "workbench") {
        const payload = data as { entry?: AgentWorkbenchEntry };
        if (payload.entry) {
          const stored = appendWorkbenchEntry(agentWorkbench, payload.entry);
          sendSSE(res, "workbench", { entry: stored });
        }
        return;
      }
      // High-level thinking lines so the panel shows progress before heavy workbench payloads
      const now = Date.now();
      if (event === "plan" && data && typeof data === "object") {
        const p = data as { rationale?: string };
        const r = (p.rationale || "").trim();
        onThinkingStep({
          step: "Agent plan",
          status: "completed",
          timestamp: now,
          details: r || undefined,
        });
      } else if (event === "tool_call" && data && typeof data === "object") {
        const t = data as { name?: string };
        onThinkingStep({
          step: `Running tool: ${t.name || "tool"}`,
          status: "completed",
          timestamp: now,
        });
      } else if (event === "critic_verdict" && data && typeof data === "object") {
        const c = data as { stepId?: string };
        if (c.stepId === "final") {
          onThinkingStep({
            step: "Reviewing answer",
            status: "completed",
            timestamp: now,
          });
        }
      }
      sendSSE(res, event, data);
      for (const entry of agentSseEventToWorkbenchEntries(event, data)) {
        const stored = appendWorkbenchEntry(agentWorkbench, entry);
        sendSSE(res, "workbench", { entry: stored });
      }
    };

    const agentOptions = isAgenticLoopEnabled()
        ? {
            onAgentEvent,
            abortSignal: turnAbortController.signal,
            streamPreAnalysis: {
              intentLabel: chatAnalysis.intent,
              analysis: chatAnalysis.analysis,
              relevantColumns: chatAnalysis.relevantColumns,
              userIntent: chatAnalysis.userIntent,
              canonicalColumns: schemaBinding.canonicalColumns,
              columnMapping: schemaBinding.columnMapping,
            },
            username,
            chatDocument,
            dataBlobVersion: chatDocument.currentDataBlob?.version,
            // W27 · explicit annotations on the callback params so tsc can
            // type-check the body. Parameter shapes match the runtime
            // payloads emitted by the agent loop (see types.ts).
            onMidTurnSessionContext: async (
              p: import("../../lib/agents/runtime/types.js").AgentMidTurnSessionPayload
            ) => {
              await persistMidTurnAssistantSessionContext({
                sessionId,
                username,
                summary: p.summary,
                tool: p.tool,
                ok: p.ok,
                phase: p.phase,
              });
            },
            onIntermediateArtifact: (payload: {
              preview: Record<string, unknown>[];
              insight?: string;
              pivotDefaults?: import("../../shared/schema.js").Message["pivotDefaults"];
              executionScalar?: boolean;
            }) => {
              const {
                preview,
                insight,
                pivotDefaults: segmentPivotDefaults,
                executionScalar,
              } = payload;
              flushIntermediateSegment(
                preview as Record<string, unknown>[],
                insight,
                segmentPivotDefaults,
                executionScalar
              );
            },
          }
        : { chatDocument, onAgentEvent };

    const turnStartedAt = Date.now();
    const result = await answerQuestion(
      latestData,
      message,
      processingChatHistory,
      chatDocument.dataSummary,
      sessionId,
      chatLevelInsights,
      onThinkingStep,
      detectedMode,
      permanentContext,
      sessionAnalysisContext,
      columnarStoragePathOpt,
      loadFullDataOpt,
      agentOptions
    );

    // Check connection after processing
    if (!checkConnection()) {
      return;
    }

    // W12 · load enabled FMCG/Marico domain packs once and pass them down
    // so chart insight generation can fill `businessCommentary`. Loader is
    // process-cached; failures are non-fatal — commentary just won't render.
    // Lifted to enclosing scope so Wave-3 pivot envelope enrichment (after
    // pivotDefaults is merged) can reuse the same context without a reload.
    let domainContextForCharts: string | undefined;
    try {
      const { loadEnabledDomainContext } = await import(
        "../../lib/domainContext/loadEnabledDomainContext.js"
      );
      const { text } = await loadEnabledDomainContext();
      if (text?.trim()) domainContextForCharts = text;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`W12 · domain context load for chart commentary failed: ${msg}`);
    }

    // Enrich charts
    if (result.charts && Array.isArray(result.charts)) {
      result.charts = await enrichCharts(
        result.charts,
        chatDocument,
        chatLevelInsights,
        result.lastAnalyticalRowsForEnrichment,
        {
          userQuestion: message,
          sessionAnalysisContext: chatDocument.sessionAnalysisContext,
          permanentContext,
          domainContext: domainContextForCharts,
        }
      );
      // W19 · per-step LLM-enriched insights (env-gated, default off). Single
      // batched LLM call that ties each workbench step to the analysis arc.
      // Mutates `agentWorkbench` in place; persistence picks up the enriched
      // entries automatically. Failures are non-fatal — deterministic W10
      // insights stay as the fallback.
      try {
        const { enrichStepInsights, isRichStepInsightsEnabled } = await import(
          "../../lib/agents/runtime/enrichStepInsights.js"
        );
        if (isRichStepInsightsEnabled() && agentWorkbench.length > 0) {
          const enrichResult = await enrichStepInsights({
            workbench: agentWorkbench,
            finalAnswer: result.answer ?? "",
            sessionAnalysisContext: chatDocument.sessionAnalysisContext,
            domainContext: domainContextForCharts,
            turnId: (result.agentTrace as { turnId?: string } | undefined)?.turnId ?? sessionId,
          });
          if (enrichResult.ok && enrichResult.enrichedCount > 0) {
            // Push a final replacement event so the live UI updates in place.
            // The persisted message will carry the enriched workbench too via
            // the existing assistantSave path.
            sendSSE(res, "workbench_enriched", { entries: agentWorkbench });
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`W19 · enrichStepInsights failed: ${msg}`);
      }
      // WC7 · auto-attach analytical layers (reference lines / trend / forecast /
      // outliers / comparison) inferred from the user's question. The legacy
      // ChartRenderer ignores `_autoLayers`; the v2 ChartShim forwards them
      // into ChartSpecV2.layers so PremiumChart picks them up.
      // Fix-2: cap input length to bound regex worst-case backtracking.
      const safeQuestion = (message ?? "").slice(0, 4000);
      result.charts = result.charts.map((c) => attachAutoLayers(c, safeQuestion));
    }

    // Check connection after enriching charts
    if (!checkConnection()) {
      return;
    }

    // Validate and enrich response
    const validated = validateAndEnrichResponse(result, chatDocument, chatLevelInsights);

    // Transform data operations response format for frontend compatibility
    // Frontend expects 'preview' and 'summary', but orchestrator returns 'table' and 'operationResult'
    const transformedResponse: any = { ...validated };
    if ((result as any).table && Array.isArray((result as any).table)) {
      transformedResponse.preview = (result as any).table;
      console.log(`📊 Transformed table to preview: ${(result as any).table.length} rows`);
    }
    if ((result as any).operationResult) {
      if ((result as any).operationResult.summary && Array.isArray((result as any).operationResult.summary)) {
        transformedResponse.summary = (result as any).operationResult.summary;
        console.log(`📋 Transformed operationResult.summary to summary: ${(result as any).operationResult.summary.length} items`);
      }
    }
    if ((result as any).agentTrace) {
      transformedResponse.agentTrace = (result as any).agentTrace;
    }
    // Lightweight client hint for smart pivot/table visibility.
    transformedResponse.pivotAutoShow = Boolean(
      ((result as any).table && Array.isArray((result as any).table) && (result as any).table.length > 0) ||
      pendingIntermediates.some((p) => Array.isArray(p.preview) && p.preview.length > 0)
    );
    const parserPivotDefaults = derivePivotDefaultsHint({
      parsedQuery: parsedQueryForLoad,
      requiredColumns: schemaBinding.canonicalColumns,
      dataSummary: chatDocument.dataSummary,
    });
    const executionPivotDefaults = derivePivotDefaultsFromExecution({
      agentTrace: (result as any).agentTrace,
      table: (result as any).table,
      dataSummary: chatDocument.dataSummary,
    });
    transformedResponse.pivotDefaults = mergePivotDefaultsForResponse({
      dataSummary: chatDocument.dataSummary,
      parsedQuery: parsedQueryForLoad,
      parserPivot: parserPivotDefaults,
      executionPivot: executionPivotDefaults,
    });
    if (executionPivotDefaults?.scalar === true) {
      transformedResponse.pivotAutoShow = false;
    }
    // RNK2 · stamp `rankingMeta` when the question is a ranking / leaderboard
    // / entity-max question AND we have row data to surface. This does NOT
    // re-shape the pivot — `mergePivotDefaultsForResponse` already produces
    // rows=[entity], values=[metric_op] for these queries because the planner
    // emitted that shape (see RNK1.3 / RNK1.4). The meta tag drives the
    // "Full leaderboard available below" hint in AnswerCard and labels the
    // message in Cosmos so historical ranking turns render correctly.
    try {
      const rankingIntent = extractRankingIntent(message, chatDocument.dataSummary);
      if (rankingIntent && transformedResponse.pivotDefaults?.rows?.length) {
        const tableRows = Array.isArray((result as any).table)
          ? ((result as any).table as Array<Record<string, unknown>>)
          : [];
        const totalEntities = tableRows.length;
        if (totalEntities > 0) {
          // Cosmos message-doc safety: persist at most 5000 ranking rows on
          // the message preview/table; the user sees the truncationNote in
          // the leaderboard hint when N > 5000. The agent's narrator still
          // sees the true totalEntities via leaderboardSummary (RNK2.2).
          const PERSIST_CAP = 5000;
          let truncationNote: string | undefined;
          if (totalEntities > PERSIST_CAP) {
            truncationNote = `Showing top ${PERSIST_CAP} of ${totalEntities}`;
            if (Array.isArray((result as any).table)) {
              (result as any).table = tableRows.slice(0, PERSIST_CAP);
            }
          }
          const meta: RankingMeta = {
            intentKind: rankingIntent.kind,
            direction: rankingIntent.direction,
            entityColumn: rankingIntent.entityColumn,
            ...(rankingIntent.metricColumn
              ? { metricColumn: rankingIntent.metricColumn }
              : {}),
            totalEntities,
            ...(truncationNote ? { truncationNote } : {}),
          };
          transformedResponse.rankingMeta = meta;
          transformedResponse.pivotAutoShow = true;
        }
      }
    } catch (err) {
      // Non-critical: ranking-meta enrichment failures must never break the
      // response. Log and move on — the user still sees the same answer with
      // pivot defaults; only the leaderboard hint disappears.
      console.warn("[chatStream] rankingMeta enrichment failed", {
        message: (err as Error)?.message?.slice(0, 200),
      });
    }
    if (process.env.NODE_ENV !== "production") {
      console.debug("[chatStream] pivotDefaults merged", {
        parser: parserPivotDefaults,
        execution: executionPivotDefaults,
        value: transformedResponse.pivotDefaults,
      });
    }

    // Wave 3 · when a pivot view is being rendered but the answer envelope
    // didn't supply structured findings (dataOps / legacy turns), generate a
    // narrator-style finding/implication/recommendation envelope from the
    // pivot's primary chart so the pivot tab's "Key insight" matches the
    // chat-analysis InsightCard tone instead of falling through to a single
    // chart-keyInsight sentence. No-op when the envelope was already populated
    // or when no pivot is rendered.
    Object.assign(
      transformedResponse,
      await enrichPivotInsightFromEnvelope(result, transformedResponse, {
        userQuestion: message,
        domainContext: domainContextForCharts,
      })
    );

    const allowPreviewInAnswer = userExplicitlyAskedForColumnsOrPreview(message);
    if (allowPreviewInAnswer) {
      preserveFinalPreview(transformedResponse, pendingIntermediates);
    } else {
      // Suppress preview payloads unless user explicitly asks for columns/preview.
      delete transformedResponse.preview;
      delete transformedResponse.summary;
    }
    const finalThinkingBefore =
      pendingIntermediates.length > 0 &&
      (thinkingSteps.length > 0 || agentWorkbench.length > 0)
        ? { steps: [...thinkingSteps], workbench: [...agentWorkbench] }
        : undefined;
    if (finalThinkingBefore) {
      transformedResponse.thinkingBefore = finalThinkingBefore;
    }

    // Check connection before generating suggestions
    if (!checkConnection()) {
      return;
    }

    // Generate AI suggestions
    let suggestions: string[] = [];
    try {
      const updatedChatHistory = [
        ...allMessages.slice(-15), // Use last 15 messages from DB
        { role: 'user' as const, content: message, timestamp: Date.now() },
        { role: 'assistant' as const, content: transformedResponse.answer, timestamp: Date.now() }
      ];
      suggestions = await generateAISuggestions(
        updatedChatHistory,
        chatDocument.dataSummary,
        transformedResponse.answer,
        result.agentSuggestionHints
      );
    } catch (error) {
      console.error('Failed to generate suggestions:', error);
    }

    const enrichmentFollowUps = [
      ...(chatDocument.sessionAnalysisContext?.suggestedFollowUps ?? []),
      ...(chatDocument.datasetProfile?.suggestedQuestions ?? []),
    ];
    const mergedSuggestedQuestions = [...new Set([...suggestions, ...enrichmentFollowUps])].slice(
      0,
      12
    );

    // Check connection before saving messages
    if (!checkConnection()) {
      console.log('🚫 Client disconnected, skipping message save');
      return;
    }

    // If targetTimestamp is provided, this is an edit operation
    // Truncate history AFTER processing (so processing had full context)
    // Only do this if we're actually editing (message exists), not for new messages
    if (targetTimestamp) {
      // Check if this message actually exists before trying to edit
      const existingMessage = chatDocument.messages?.find(
        (msg) => msg.timestamp === targetTimestamp && msg.role === 'user'
      );
      
      if (existingMessage) {
        console.log('✏️ Editing message with targetTimestamp:', targetTimestamp);
        try {
          await updateMessageAndTruncate(sessionId, targetTimestamp, message);
          console.log('✅ Message updated and messages truncated in database');
        } catch (truncateError) {
          console.error('⚠️ Failed to update message and truncate:', truncateError);
          // Continue - don't fail the entire request
        }
      } else {
        // This is a new message, not an edit - ignore targetTimestamp
        console.log(`ℹ️ targetTimestamp ${targetTimestamp} provided but message not found. Treating as new message.`);
      }
    }

    // Save messages only if client is still connected
    // Use targetTimestamp for the user message to match the frontend's timestamp
    // This prevents duplicate messages when the SSE polling picks up the saved messages
    // IMPORTANT: Pass FULL charts with data to addMessagesBySessionId
    // It will handle saving large charts to blob and stripping data from message charts
    // Use a consistent timestamp for assistant message to prevent duplicates
    const assistantMessageTimestamp = Date.now();
    try {
      const userEmail = username?.toLowerCase();
      const userMessageTimestamp = targetTimestamp || Date.now();
      
      // Pass FULL charts with data - addMessagesBySessionId will:
      // 1. Save large charts to blob storage
      // 2. Store charts in top-level session.charts
      // 3. Strip data from message-level charts to prevent CosmosDB size issues
      // 4. Check for duplicates before adding
      const intermediateCosmosMessages: Message[] = pendingIntermediates.map((pi) => ({
        role: 'assistant',
        content: 'Preliminary results',
        timestamp: pi.assistantTimestamp,
        preview: pi.preview as Message["preview"],
        pivotDefaults: pi.pivotDefaults,
        isIntermediate: true,
        intermediateInsight: pi.insight,
        thinkingBefore: { steps: pi.thinkingSteps, workbench: pi.workbench },
      }));

      const userSave: Message = {
        role: 'user',
        content: message,
        timestamp: userMessageTimestamp,
        userEmail: userEmail,
        ...(pendingIntermediates.length === 0
          ? {
              ...(thinkingSteps.length > 0 ? { thinkingSteps: [...thinkingSteps] } : {}),
              ...(agentWorkbench.length > 0 ? { agentWorkbench: [...agentWorkbench] } : {}),
            }
          : {}),
      };

      const assistantSave: Message = {
        role: 'assistant',
        content: transformedResponse.answer,
        charts: transformedResponse.charts || [],
        insights: transformedResponse.insights,
        preview: transformedResponse.preview || undefined,
        summary: transformedResponse.summary || undefined,
        agentTrace: transformedResponse.agentTrace,
        pivotDefaults: transformedResponse.pivotDefaults,
        ...(transformedResponse.rankingMeta
          ? { rankingMeta: transformedResponse.rankingMeta as RankingMeta }
          : {}),
        timestamp: assistantMessageTimestamp,
        ...(finalThinkingBefore ? { thinkingBefore: finalThinkingBefore } : {}),
        ...(mergedSuggestedQuestions.length > 0
          ? { suggestedQuestions: mergedSuggestedQuestions }
          : {}),
        ...(transformedResponse.followUpPrompts?.length
          ? { followUpPrompts: transformedResponse.followUpPrompts }
          : {}),
        ...((transformedResponse as { magnitudes?: Array<{ label: string; value: string; confidence?: "low" | "medium" | "high" }> }).magnitudes?.length
          ? {
              magnitudes: (
                transformedResponse as { magnitudes: Array<{ label: string; value: string; confidence?: "low" | "medium" | "high" }> }
              ).magnitudes,
            }
          : {}),
        ...((transformedResponse as { unexplained?: string }).unexplained
          ? {
              unexplained: (transformedResponse as { unexplained: string })
                .unexplained,
            }
          : {}),
        // Persist spawned sub-questions with their stable ids so per-question
        // feedback (thumbs up/down) survives reload. The agent loop ships
        // SpawnedQuestion[] under `spawnedQuestions`; we only persist the
        // {id, question} subset since that's all the UI needs.
        ...((result as { spawnedQuestions?: { id?: string; question?: string }[] }).spawnedQuestions?.length
          ? {
              spawnedQuestions: (
                result as { spawnedQuestions: { id?: string; question?: string }[] }
              ).spawnedQuestions
                .filter((q): q is { id: string; question: string } =>
                  typeof q?.id === "string" && typeof q?.question === "string"
                )
                .map((q) => ({ id: q.id, question: q.question })),
            }
          : {}),
        // W3 · structured AnswerEnvelope from narrator (TL;DR, findings,
        // methodology, caveats, nextSteps). Optional — absent on synthesizer
        // fallback turns; the client gracefully falls back to markdown.
        ...((transformedResponse as { answerEnvelope?: Record<string, unknown> }).answerEnvelope
          ? {
              answerEnvelope: (
                transformedResponse as { answerEnvelope: NonNullable<typeof assistantSave.answerEnvelope> }
              ).answerEnvelope,
            }
          : {}),
        ...((transformedResponse as { dashboardDraft?: Record<string, unknown> }).dashboardDraft
          ? {
              dashboardDraft: (
                transformedResponse as { dashboardDraft: Record<string, unknown> }
              ).dashboardDraft,
            }
          : {}),
        ...((transformedResponse as { createdDashboardId?: string }).createdDashboardId
          ? {
              createdDashboardId: (
                transformedResponse as { createdDashboardId: string }
              ).createdDashboardId,
            }
          : {}),
        ...((result as { appliedFilters?: Array<{ column: string; op: 'in' | 'not_in'; values: string[]; match?: 'exact' | 'case_insensitive' | 'contains' }> }).appliedFilters?.length
          ? {
              appliedFilters: (
                result as { appliedFilters: Array<{ column: string; op: 'in' | 'not_in'; values: string[]; match?: 'exact' | 'case_insensitive' | 'contains' }> }
              ).appliedFilters,
            }
          : {}),
        // W13 · persist the compact blackboard digest so the client can
        // render an Investigation summary card above the step-by-step panel.
        ...((result as { investigationSummary?: NonNullable<typeof assistantSave.investigationSummary> }).investigationSummary
          ? {
              investigationSummary: (
                result as { investigationSummary: NonNullable<typeof assistantSave.investigationSummary> }
              ).investigationSummary,
            }
          : {}),
        // W30 · snapshot priorInvestigations AS THEY WERE BEFORE this turn
        // ran. The W21 append happens later in `persistMergeAssistantSessionContext`,
        // so the in-memory chatDocument array still holds the BEFORE state.
        ...((chatDocument.sessionAnalysisContext?.sessionKnowledge?.priorInvestigations?.length ?? 0) > 0
          ? {
              priorInvestigationsSnapshot: chatDocument.sessionAnalysisContext!.sessionKnowledge!.priorInvestigations,
            }
          : {}),
        // Wave A2 · full in-memory turn state (workingMemory, reflector +
        // verifier verdicts, blackboard snapshot, per-step tool I/O). Lets
        // a follow-up turn's `priorTurnState` handle (Wave B9) reach typed
        // structured state instead of TEXT digests.
        ...((result as { agentInternals?: NonNullable<typeof assistantSave.agentInternals> })
          .agentInternals
          ? {
              agentInternals: (result as { agentInternals?: NonNullable<typeof assistantSave.agentInternals> })
                .agentInternals,
            }
          : {}),
      };

      // Wave A3 · route the chat-message persist through the queue so
      // transient Cosmos failures retry (250ms / 1s / 4s backoff) and so
      // the SSE stream emits structured `persist_status` events for client-
      // side observability. We still `await` the queue here so the SSE
      // close happens after Cosmos commits — full client-perceivable
      // parallelism is Wave A4 (streaming partial saves at step end).
      const { enqueuePersist } = await import("../../lib/persistenceQueue.js");
      let persistEmitted = false;
      const { promise: persistPromise } = enqueuePersist({
        sessionId,
        messages: [userSave, ...intermediateCosmosMessages, assistantSave],
        onSuccess: () => {
          if (persistEmitted) return;
          persistEmitted = true;
          sendSSE(res, "persist_status", {
            kind: "messages",
            status: "ok",
            messageTimestamp: assistantMessageTimestamp,
          });
        },
        onAttemptFailed: (err, attempt) => {
          sendSSE(res, "persist_status", {
            kind: "messages",
            status: "retrying",
            attempt,
            error: err.message.slice(0, 400),
          });
        },
        onFailure: (err) => {
          if (persistEmitted) return;
          persistEmitted = true;
          // Wave A5 will surface this to the client as a "Save again"
          // affordance; today we just emit the structured event and log.
          sendSSE(res, "persist_status", {
            kind: "messages",
            status: "failed",
            error: err.message.slice(0, 400),
            messageTimestamp: assistantMessageTimestamp,
          });
        },
      });
      const persistOutcome = await persistPromise;
      if (persistOutcome === "succeeded") {
        console.log(`✅ Messages saved to chat: ${chatDocument.id}`);
      } else {
        console.error(
          `❌ Messages persist failed for chat: ${chatDocument.id} (turn answer streamed; user-visible affordance via persist_status SSE event)`
        );
      }
      // Wave A4 · clear the mid-turn checkpoint now that the final assistant
      // message is durably saved. Best-effort; failures are logged but don't
      // surface to the user (the worst case is a stale checkpoint banner the
      // next time the session loads, which the client handles gracefully).
      void (async () => {
        try {
          const { clearTurnCheckpoint } = await import("../../lib/turnCheckpoint.js");
          await clearTurnCheckpoint(sessionId, username);
        } catch {
          /* swallow */
        }
      })();

      // W58 · Append the turn's analytical events to the durable Memory
      // container (W56) and mirror to AI Search (W57). Best-effort: a Cosmos
      // or Search outage must not surface as a turn failure to the user.
      try {
        const turnIdForMemory: string | undefined =
          (transformedResponse as { agentTrace?: { turnId?: string } })
            .agentTrace?.turnId;
        if (turnIdForMemory) {
          const memoryEntries = buildTurnEndMemoryEntries({
            sessionId,
            username,
            turnId: turnIdForMemory,
            dataVersion:
              chatDocument.currentDataBlob?.version ??
              chatDocument.ragIndex?.dataVersion ??
              1,
            createdAt: assistantMessageTimestamp,
            question: message,
            assistant: assistantSave,
            investigationSummary: (
              result as {
                investigationSummary?: import("../../shared/schema.js").InvestigationSummary;
              }
            ).investigationSummary,
            appliedFilters: (
              result as {
                appliedFilters?: Array<{
                  column: string;
                  op: "in" | "not_in";
                  values: string[];
                  match?: "exact" | "case_insensitive" | "contains";
                }>;
              }
            ).appliedFilters,
          });
          if (memoryEntries.length > 0) {
            await appendMemoryEntries(memoryEntries);
            scheduleIndexMemoryEntries(memoryEntries);
            console.log(
              `📓 Memory: appended ${memoryEntries.length} entries for turn ${turnIdForMemory}`
            );
          }
        }
      } catch (memoryErr) {
        console.warn("⚠️ analysisMemory turn-end write failed:", memoryErr);
      }

      try {
        const { persistMergeAssistantSessionContext } = await import(
          "../../lib/sessionAnalysisContext.js"
        );
        const updatedSAC = await persistMergeAssistantSessionContext({
          sessionId,
          username,
          assistantMessage: transformedResponse.answer,
          agentTrace: transformedResponse.agentTrace,
          analysisBrief: (result as { analysisBrief?: import("../../shared/schema.js").AnalysisBrief })
            .analysisBrief,
          // W21 · feed the turn's question + investigation digest so the
          // session-context merge appends a `priorInvestigation` entry the
          // next turn's planner can chain off of.
          question: message,
          investigationSummary: (result as {
            investigationSummary?: import("../../shared/schema.js").InvestigationSummary;
          }).investigationSummary,
        });
        // W31 · emit the updated priorInvestigations array via SSE so the
        // client's W26 PriorInvestigationsBanner refreshes in place
        // without a page reload. `safeEmit` (closure scope) swallows
        // closed-stream errors. Skipped silently when the persist failed
        // (returns undefined) or no investigations exist yet.
        // H5 · also emit dimensionHierarchies so the UI chip stays in
        // sync after the assistant merge runs.
        const updatedPriors = updatedSAC?.sessionKnowledge?.priorInvestigations ?? [];
        const updatedHierarchies =
          updatedSAC?.dataset?.dimensionHierarchies ?? [];
        if (updatedPriors.length > 0 || updatedHierarchies.length > 0) {
          sendSSE(res, "session_context_updated", {
            priorInvestigations: updatedPriors,
            dimensionHierarchies: updatedHierarchies,
          });
        }
      } catch (ctxErr) {
        console.warn("⚠️ sessionAnalysisContext assistant merge failed:", ctxErr);
      }
    } catch (cosmosError) {
      console.error("⚠️ Failed to save messages to CosmosDB:", cosmosError);
    }

    // Check connection before sending response
    if (!checkConnection()) {
      return;
    }

    // W2.3 · fire-and-forget persist of the completed turn for the semantic
    // cache (W5) and feedback loop (W5.5). Never awaited — response latency
    // must not depend on Cosmos / AI Search round-trips.
    maybeWritePastAnalysisDoc({
      sessionId,
      userId: username,
      question: message,
      transformedResponse,
      chatDocument,
      turnStartedAt,
    });

    // Agentic: emit answer first, then charts so the client can render text before heavy chart payloads.
    const splitCharts =
      isAgenticLoopEnabled() &&
      Array.isArray(transformedResponse.charts) &&
      transformedResponse.charts.length > 0;

    if (splitCharts) {
      if (
        !sendSSE(res, "response", {
          ...transformedResponse,
          charts: [],
          suggestions,
        })
      ) {
        return;
      }
      if (
        !sendSSE(res, "response_charts", {
          charts: transformedResponse.charts,
        })
      ) {
        return;
      }
    } else if (
      !sendSSE(res, "response", {
        ...transformedResponse,
        suggestions,
      })
    ) {
      return; // Client disconnected
    }

    if (!sendSSE(res, 'done', {})) {
      return; // Client disconnected
    }

    if (!res.writableEnded && !res.destroyed) {
    res.end();
    }
    console.log('✅ Stream completed successfully');
  } catch (error) {
    console.error('Chat stream error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to process message';
    if (checkConnection()) {
    sendSSE(res, 'error', { error: errorMessage });
    }
    if (!res.writableEnded && !res.destroyed) {
    res.end();
    }
  } finally {
    // W10: always clear the keepalive timer when the stream ends (success or error).
    stopKeepalive();
  }
}

/**
 * Stream chat messages for a session
 */
export async function streamChatMessages(sessionId: string, username: string, req: Request, res: Response): Promise<void> {
  setSSEHeaders(res);

  try {
    // Normalize username for consistent comparison
    const normalizedUsername = username.trim().toLowerCase();
    
    // Verify user has access to this session
    let chatDocument: ChatDocument | null = null;
    try {
      chatDocument = await getChatBySessionIdForUser(sessionId, normalizedUsername);
    } catch (accessError: any) {
      // Handle authorization errors
      if (accessError?.statusCode === 403) {
        console.warn(`⚠️ Unauthorized SSE access attempt: ${username} tried to access session ${sessionId}`);
        sendSSE(res, 'error', { error: 'Unauthorized to access this session' });
        res.end();
        return;
      }
      
      // Handle CosmosDB connection errors
      const errorMessage = accessError instanceof Error ? accessError.message : String(accessError);
      if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('ETIMEDOUT') || accessError.code === 'ECONNREFUSED') {
        console.error('❌ CosmosDB connection error in streamChatMessages:', errorMessage.substring(0, 100));
        sendSSE(res, 'error', {
          error: 'Database connection issue. Please try again in a moment.',
        });
        res.end();
        return;
      }
      
      // Re-throw if it's not an authorization or connection error
      throw accessError;
    }
    
    if (!chatDocument) {
      sendSSE(res, 'error', { error: 'Session not found' });
      res.end();
      return;
    }

    // Helper function to enrich messages with chart data
    const enrichMessagesWithCharts = async (messages: any[], chartsWithData: any[]): Promise<any[]> => {
      // Build lookup map: chart title+type -> full chart with data
      const chartLookup = new Map<string, any>();
      chartsWithData.forEach(chart => {
        if (chart.title && chart.type) {
          const key = `${chart.type}::${chart.title}`;
          chartLookup.set(key, chart);
        }
      });

      // Enrich message charts with data from top-level charts
      return messages.map(msg => {
        if (!msg.charts || msg.charts.length === 0) {
          return msg;
        }

        const enrichedCharts = msg.charts.map((chart: any) => {
          const key = `${chart.type}::${chart.title}`;
          const fullChart = chartLookup.get(key);
          
          if (fullChart && fullChart.data) {
            return {
              ...chart,
              data: fullChart.data,
              trendLine: fullChart.trendLine,
              xDomain: fullChart.xDomain,
              yDomain: fullChart.yDomain,
            };
          }
          
          return chart;
        });

        return {
          ...msg,
          charts: enrichedCharts,
        };
      });
    };

    // Load charts from blob if needed
    let chartsWithData = chatDocument.charts || [];
    if (chatDocument.chartReferences && chatDocument.chartReferences.length > 0) {
      try {
        const chartsFromBlob = await loadChartsFromBlob(chatDocument.chartReferences);
        if (chartsFromBlob.length > 0) {
          chartsWithData = chartsFromBlob;
        }
      } catch (blobError) {
        console.error('⚠️ Failed to load charts from blob in SSE:', blobError);
      }
    }

    // Also include charts from CosmosDB that might have data
    (chatDocument.charts || []).forEach(chart => {
      if (chart.data && chart.title && chart.type) {
        const key = `${chart.type}::${chart.title}`;
        if (!chartsWithData.find(c => `${c.type}::${c.title}` === key)) {
          chartsWithData.push(chart);
        }
      }
    });

    let lastMessageCount = chatDocument.messages?.length || 0;

    // Function to fetch and send new messages
    const sendMessageUpdate = async () => {
      // Check if connection is still open
      if (res.writableEnded || res.destroyed || !res.writable) {
        return false;
      }

      try {
        const currentChat = await getChatBySessionIdEfficient(sessionId);
        if (!currentChat) {
          return true; // Connection still valid, just no chat found
        }

        // Reload charts if needed
        let currentChartsWithData = currentChat.charts || [];
        if (currentChat.chartReferences && currentChat.chartReferences.length > 0) {
          try {
            const chartsFromBlob = await loadChartsFromBlob(currentChat.chartReferences);
            if (chartsFromBlob.length > 0) {
              currentChartsWithData = chartsFromBlob;
            }
          } catch (blobError) {
            // Continue with CosmosDB charts
          }
        }

        const currentMessageCount = currentChat.messages?.length || 0;
        
        // Only send update if message count changed
        if (currentMessageCount !== lastMessageCount) {
          const newMessages = currentChat.messages?.slice(lastMessageCount) || [];
          
          // Deduplicate new messages before sending (in case backend has duplicates)
          const uniqueNewMessages = newMessages.filter((msg, index, self) => {
            // Check for exact duplicates (same role, content, and timestamp)
            const firstIndex = self.findIndex(m => 
              m.role === msg.role && 
              m.content === msg.content && 
              m.timestamp === msg.timestamp
            );
            
            // If this is not the first occurrence, it's a duplicate
            if (firstIndex !== index) {
              console.log(`🔄 SSE: Filtering duplicate message (exact match): ${msg.content?.substring(0, 50)}`);
              return false;
            }
            
            // Check for similar messages (same role and content, different timestamp within 10 seconds)
            const similarIndex = self.findIndex(m => 
              m.role === msg.role && 
              m.content === msg.content && 
              m !== msg &&
              Math.abs(m.timestamp - msg.timestamp) < 10000
            );
            
            if (similarIndex !== -1 && similarIndex < index) {
              console.log(`🔄 SSE: Filtering duplicate message (similar match): ${msg.content?.substring(0, 50)}`);
              return false;
            }
            
            return true;
          });
          
          if (uniqueNewMessages.length === 0) {
            // No unique new messages, just update the count
            lastMessageCount = currentMessageCount;
            return true;
          }
          
          lastMessageCount = currentMessageCount;
          
          // Enrich new messages with chart data
          const enrichedMessages = await enrichMessagesWithCharts(uniqueNewMessages, currentChartsWithData);
          
          const sent = sendSSE(res, 'messages', {
            messages: enrichedMessages,
            totalCount: currentMessageCount,
          });
          
          if (!sent) {
            return false; // Connection closed
          }
        }
        return true;
      } catch (error) {
        // Only try to send error if connection is still open
        if (!res.writableEnded && !res.destroyed && res.writable) {
          console.error('Error fetching chat messages for SSE:', error);
          sendSSE(res, 'error', {
            error: error instanceof Error ? error.message : 'Failed to fetch messages.',
          });
        }
        return false;
      }
    };

    // Enrich initial messages with chart data
    const allMessages = chatDocument.messages || [];
    
    // Deduplicate initial messages before sending (in case backend has duplicates)
    const uniqueInitialMessages = allMessages.filter((msg, index, self) => {
      // Check for exact duplicates (same role, content, and timestamp)
      const firstIndex = self.findIndex(m => 
        m.role === msg.role && 
        m.content === msg.content && 
        m.timestamp === msg.timestamp
      );
      
      // If this is not the first occurrence, it's a duplicate
      if (firstIndex !== index) {
        console.log(`🔄 SSE init: Filtering duplicate message (exact match): ${msg.content?.substring(0, 50)}`);
        return false;
      }
      
      // Check for similar messages (same role and content, different timestamp within 10 seconds)
      const similarIndex = self.findIndex(m => 
        m.role === msg.role && 
        m.content === msg.content && 
        m !== msg &&
        Math.abs(m.timestamp - msg.timestamp) < 10000
      );
      
      if (similarIndex !== -1 && similarIndex < index) {
        console.log(`🔄 SSE init: Filtering duplicate message (similar match): ${msg.content?.substring(0, 50)}`);
        return false;
      }
      
      return true;
    });
    
    const enrichedInitialMessages = await enrichMessagesWithCharts(
      uniqueInitialMessages,
      chartsWithData
    );

    // Send initial message count
    sendSSE(res, 'init', {
      messageCount: uniqueInitialMessages.length,
      messages: enrichedInitialMessages,
    });

    // Send 'complete' event to indicate initial analysis is done
    sendSSE(res, 'complete', {
      message: 'Initial analysis complete',
    });

    // Close the connection immediately after sending initial messages
    // This prevents continuous polling and duplicate messages
    // The connection should NOT stay open to listen for new chat messages
    try {
      if (!res.writableEnded && !res.destroyed) {
        res.end();
        console.log('✅ SSE connection closed after initial analysis');
      }
    } catch (e) {
      // Ignore errors when ending already closed connection
    }

    // Clean up on client disconnect (though connection should already be closed).
    // W27 · cast through IncomingMessage so tsc resolves `.on()` — Express's
    // Request extends IncomingMessage at runtime but the express-types
    // package strips the listener API in some module-resolution paths.
    const reqAsStream = req as unknown as import("http").IncomingMessage;
    reqAsStream.on('close', () => {
      // Connection already closed, just log
      console.log('🚫 Client disconnected from SSE (initial analysis stream)');
    });

    // Handle errors - only log unexpected errors
    reqAsStream.on('error', (error: any) => {
      // ECONNRESET is expected when clients disconnect normally
      if (error.code !== 'ECONNRESET' && error.code !== 'EPIPE' && error.code !== 'ECONNABORTED') {
        console.error('SSE connection error:', error);
      }
    });

  } catch (error) {
    console.error("streamChatMessages error:", error);
    const message = error instanceof Error ? error.message : "Failed to stream chat messages.";
    sendSSE(res, 'error', { error: message });
    res.end();
  }
}

