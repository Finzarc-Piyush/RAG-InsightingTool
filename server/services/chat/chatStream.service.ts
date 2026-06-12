/**
 * Chat Stream Service
 * Handles streaming chat operations with SSE
 */
import { randomUUID } from "node:crypto";
import { AgentWorkbenchEntry, Message, ThinkingStep, chartIdentityKey } from "../../shared/schema.js";
import { answerQuestion } from "../../lib/dataAnalyzer.js";
import { toPersistedSpawnedQuestions } from "../../lib/agents/runtime/spawnedQuestionPersist.js";
import { generateAISuggestions } from "../../lib/suggestionGenerator.js";
import {
  getChatBySessionIdForUser,
  addMessagesBySessionId,
  updateMessageAndTruncate,
  getChatBySessionIdEfficient,
  ensureDatasetFingerprintForSession,
  ChatDocument
} from "../../models/chat.model.js";
import { decideEnrichmentGate } from "./enrichmentGate.js";
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
import { kickOffPreClassifyWork } from "./chatStreamPreClassifyKickoff.js";
import { persistDirectivesFromUserMessage } from "./chatStreamDirectivePersist.js";
import { fingerprintFromSummary } from "../../lib/datasetFingerprint.js";
import {
  appendDirective,
  hydrateDirectivesForSession,
} from "../../models/datasetDirectives.model.js";
import type { UserDirective } from "../../shared/schema.js";
import {
  formatContextTrimmedPayload,
  type TrimmedBlockInfo,
} from "../../lib/agents/runtime/promptBudget.js";
import { extractColumnsFromHistory } from "../../lib/agents/utils/columnExtractor.js";
import { isAgenticLoopEnabled } from "../../lib/agents/runtime/types.js";
import {
  persistMidTurnAssistantSessionContext,
  extractAndPersistUserHierarchies,
} from "../../lib/sessionAnalysisContext.js";
import { preserveFinalPreview } from "./previewRetention.js";
import { Request, Response } from "express";
import {
  agentSseEventToWorkbenchEntries,
  appendWorkbenchEntry,
} from "./agentWorkbench.util.js";
import { extractRankingIntent } from "../../lib/agents/runtime/planArgRepairs.js";
import type { RankingMeta } from "../../shared/schema.js";
import {
  patchPastAnalysisBusinessActions,
  patchPastAnalysisPivotArtifacts,
  upsertPastAnalysisDoc,
} from "../../models/pastAnalysis.model.js";
import { stripChartDataForPastAnalysis } from "../../lib/pastAnalysisChartStrip.js";
import { recordUsageEvent } from "../../models/usageEvent.model.js";
import {
  materializePivotArtifact,
  type RawPivotArtifact,
} from "../../lib/pastAnalysisPivotArtifact.js";
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
import { mergeIntermediateSegmentPivotDefaults } from "../../lib/diagnosticIntermediatePivot.js";
import {
  filterProvisionalPivotDefaultsToPreviewKeys,
  intermediatePreviewSignature,
  shouldEmitIntermediatePivotFlush,
} from "./intermediatePivotPolicy.js";
// Wave R-decompose · pivot-defaults derivation cluster moved to a sibling
// module. Imported here for internal use and re-exported below so existing
// importers of `chatStream.service.js` (e.g. tests) resolve unchanged.
import {
  derivePivotDefaultsFromExecution,
  derivePivotDefaultsHint,
  mergePivotDefaultsForResponse,
} from "./chatStreamPivotDefaults.js";
export { mergePivotDefaultsForResponse } from "./chatStreamPivotDefaults.js";
import { logger } from "../../lib/logger.js";

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
  const sourceSessionId = hit.doc.sessionId;
  const sourceTurnId = hit.doc.turnId;
  const sourceDocId = `${sourceSessionId}__${sourceTurnId}`;

  // AMR4 · fetch the full Cosmos doc by id so we can rehydrate the rich
  // payload (answerEnvelope, businessActions, charts with insights, pivot
  // artifact metadata, investigation summary). AI Search projects only the
  // lookup-relevant subset of fields; the rest live in Cosmos. Failure to
  // fetch is non-fatal — we degrade to the text-only cache-hit shape.
  let richDoc: PastAnalysisDoc | null = null;
  try {
    const { getPastAnalysisDoc } = await import(
      "../../models/pastAnalysis.model.js"
    );
    richDoc = await getPastAnalysisDoc(sourceSessionId, sourceDocId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      `⚠️ AMR4 · failed to fetch rich past_analyses doc on cache hit (${msg})`
    );
  }

  const { buildCachedResponsePayload } = await import(
    "../../lib/cache/buildCachedResponsePayload.js"
  );
  const { responsePayload, assistantMessageExtras } = buildCachedResponsePayload(
    {
      richDoc,
      matchKind: hit.source as "exact" | "semantic",
      originalSessionId: sourceSessionId,
      originalTurnId: sourceTurnId,
      fallbackAnswer: cachedAnswer,
      fallbackCreatedAt: hit.doc.createdAt,
      cachedAgeMs: hit.ageMs,
    }
  );

  // Informational SSE for telemetry / UI — purely additive, clients can ignore.
  sendSSE(res, "cache_hit", {
    source: hit.source,
    ageMs: hit.ageMs,
    sourceTurnId,
    dataVersion: hit.doc.dataVersion,
  });

  // AMR4 · rich response payload. Legacy clients render `answer` markdown
  // unchanged; AMR5-aware clients pick up the envelope / charts / pivot /
  // business actions / provenance chip.
  sendSSE(res, "response", responsePayload);
  sendSSE(res, "done", {});

  // Persist the pair of messages so the session history stays correct across
  // cache hits. The assistant row now carries the rich shape so a reload
  // reproduces the same AnswerCard / charts / pivot / BusinessActionsCard
  // mount that the live render just got.
  try {
    const nowMs = Date.now();
    await addMessagesBySessionId(sessionId, [
      { role: "user" as const, content: userMessage, timestamp: nowMs - 1 },
      {
        role: "assistant" as const,
        content: cachedAnswer,
        timestamp: nowMs,
        // Wave AD1 NOTE · cache-hit messages mark agentTrace.fromCache=true
        // (no turnId) so the client's FeedbackButtons mount-gate skips this
        // path. Routing cache-hit feedback back to the source past_analyses
        // doc via cacheSource hints is tracked as a follow-up wave.
        agentTrace: { fromCache: true } as Record<string, unknown>,
        ...assistantMessageExtras,
      },
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`⚠️ cache-hit message persist failed for ${chatDocument.id}: ${msg}`);
  }

  // Wave AD-CH · Count this cache-served question as a usage event so the
  // superadmin metrics (which derive "Questions"/active users from
  // past_analyses, and cache hits DON'T write a fresh past_analyses doc) stay
  // honest. Fire-and-forget — recordUsageEvent never throws. One event per
  // (user, analysis served).
  void recordUsageEvent({
    eventType: "analysis.cache_hit",
    userEmail: username,
    sessionId,
    metadata: {
      source: hit.source,
      sourceSessionId,
      sourceTurnId,
      dataVersion: hit.doc.dataVersion,
      ageMs: hit.ageMs,
    },
  });

  if (!res.writableEnded && !res.destroyed) {
    res.end();
  }
  // Identity hint in the log for rollup dashboards.
  logger.log(
    `💡 served from ${hit.source} cache (ageMs=${hit.ageMs}, sourceTurnId=${sourceTurnId}, user=${username}, rich=${richDoc ? "yes" : "no"})`
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
  // Wave A1 · Skip cache writes when an active filter is set. Otherwise
  // future identical questions on the same dataVersion (filter cleared)
  // would hit a cached answer that was actually computed against the
  // filtered slice, silently serving wrong numbers. Mirror of the
  // lookup-side gate in `questionCacheLookup.ts`.
  if ((params.chatDocument.activeFilter?.conditions?.length ?? 0) > 0) return;
  try {
    const turnId: string | undefined = params.transformedResponse?.agentTrace?.turnId;
    if (!turnId) return; // non-agentic paths (legacy) — skip for now
    // Wave R1 · Never cache a direct-answer front-door reply. Conversational /
    // general-knowledge answers are not grounded in this dataset's rows, so a
    // semantic cache hit could replay e.g. a "hi" answer for an unrelated later
    // question. The `planRationale` marker is set by directAnswerPath.ts.
    if (params.transformedResponse?.agentTrace?.planRationale === "direct_answer") {
      return;
    }
    const totals = takeTurnTotals(turnId);
    const answer = typeof params.transformedResponse.answer === "string"
      ? params.transformedResponse.answer
      : "";
    const rawCharts = Array.isArray(params.transformedResponse.charts)
      ? (params.transformedResponse.charts as ChartSpec[])
      : undefined;
    const charts = rawCharts ? stripChartDataForPastAnalysis(rawCharts) : undefined;
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
    // AMR2 · capture the structured envelope + investigation digest so a
    // future cache-hit on this question can restore the rich AnswerCard +
    // InvestigationSummaryCard instead of plain markdown. Business actions
    // are NOT captured here — they resolve after this fire-and-forget write
    // (see the `business_actions` SSE branch below); the corresponding
    // `patchPastAnalysisBusinessActions` call in that branch attaches them
    // to this same doc once the agent returns.
    const answerEnvelope =
      params.transformedResponse?.answerEnvelope &&
      typeof params.transformedResponse.answerEnvelope === "object"
        ? (params.transformedResponse.answerEnvelope as PastAnalysisDoc["answerEnvelope"])
        : undefined;
    const investigationSummary =
      params.transformedResponse?.investigationSummary &&
      typeof params.transformedResponse.investigationSummary === "object"
        ? (params.transformedResponse.investigationSummary as PastAnalysisDoc["investigationSummary"])
        : undefined;
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
      ...(answerEnvelope ? { answerEnvelope } : {}),
      ...(investigationSummary ? { investigationSummary } : {}),
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
      .then(async () => {
        // W2.4 · mirror into the AI Search index for the semantic cache.
        // Gated by PAST_ANALYSES_INDEX_ENABLED (default off until the index
        // exists and has been created via `npm run create-past-analyses-index`).
        if (process.env.PAST_ANALYSES_INDEX_ENABLED === "true") {
          await indexPastAnalysis(doc);
        }
        // AMR3 · materialize pivot captures (inline-vs-blob policy) and
        // patch the resulting `PastAnalysisPivotArtifact[]` onto the doc.
        // Runs AFTER the initial upsert so the row exists; uses the same
        // read-modify-upsert pattern as `patchPastAnalysisBusinessActions`.
        // Fire-and-forget — pivot recall is a nice-to-have, not load-bearing
        // for the cache-hit text path. Errors are swallowed and logged so a
        // single blob-upload failure never blocks the next live turn.
        const rawPivots = (
          params.transformedResponse as {
            pivotArtifacts?: RawPivotArtifact[];
          }
        )?.pivotArtifacts;
        if (rawPivots && rawPivots.length > 0) {
          try {
            const materialized = await Promise.all(
              rawPivots
                .slice(0, 12) // hard cap matches schema's `.max(12)` on the doc field
                .map((raw) => materializePivotArtifact(raw))
            );
            if (materialized.length > 0) {
              const patch = await patchPastAnalysisPivotArtifacts({
                sessionId: doc.sessionId,
                turnId: doc.turnId,
                artifacts: materialized,
              });
              if (!patch.ok) {
                logger.warn(
                  `⚠️ past_analyses pivotArtifacts patch skipped: ${patch.reason}`
                );
              }
            }
          } catch (pivotErr) {
            const msg =
              pivotErr instanceof Error ? pivotErr.message : String(pivotErr);
            logger.warn(
              `⚠️ past_analyses pivotArtifacts materialize/patch failed for turn ${turnId}: ${msg}`
            );
          }
        }
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`⚠️ past_analyses persist failed for turn ${turnId}: ${msg}`);
      });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`⚠️ past_analyses write preflight failed: ${msg}`);
  }
}

function userExplicitlyAskedForColumnsOrPreview(text: string): boolean {
  const q = String(text || "").toLowerCase();
  return (
    /\b(columns?|column names?|schema|field list|show fields)\b/.test(q) ||
    /\b(preview|sample rows?|show rows?|show data|data preview)\b/.test(q)
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
      logger.log('🚫 Client disconnected from chat stream early');
    }
  });

  res.on('error', (error: any) => {
    // ECONNRESET, EPIPE, ECONNABORTED are expected when client disconnects
    if (error.code !== 'ECONNRESET' && error.code !== 'EPIPE' && error.code !== 'ECONNABORTED') {
      logger.error('SSE connection error:', error);
    }
    clientDisconnected = true;
  });

  try {
    // Get chat document FIRST (with full history) so processing uses complete context
    logger.log('🔍 Fetching chat document for sessionId:', sessionId);
    let chatDocument: ChatDocument | null = null;
    
    try {
      chatDocument = await getChatBySessionIdForUser(sessionId, username);
    } catch (dbError: any) {
      // Handle CosmosDB connection errors gracefully
      const errorMessage = dbError instanceof Error ? dbError.message : String(dbError);
      if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('ETIMEDOUT') || dbError.code === 'ECONNREFUSED') {
        logger.error('❌ CosmosDB connection error, attempting to continue with blob storage data...');
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

    logger.log('✅ Chat document found');

    const gate = decideEnrichmentGate(chatDocument.enrichmentStatus);
    if (gate === "queued") {
      // The client holds this question and re-fires it as a normal streaming
      // turn once the data is fully materialized (see client
      // `earlyQuestionRefire`). We no longer persist a server-side
      // `pendingUserMessage` — just signal "not ready yet" and close.
      sendSSE(res, "queued", {
        reason: "enrichment",
        message:
          "Your message is queued until we finish understanding your data. You will see the reply shortly.",
      });
      res.end();
      return;
    }
    if (gate === "failed") {
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
    const activeFilterConditionCount =
      chatDocument.activeFilter?.conditions?.length ?? 0;
    const exactHit = await tryExactQuestionCacheHit({
      sessionId,
      dataVersion: cacheDataVersion,
      question: message,
      activeFilterConditionCount,
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
      activeFilterConditionCount,
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
      pivotUnavailable?: boolean;
    };
    const pendingIntermediates: PendingIntermediate[] = [];
    let intermediateSeq = 0;
    // `provisionalPivotDefaults` is genuinely reassigned (derivePivotDefaultsHint
    // site below); eslint mis-sees it because its only same-scope read is inside
    // the flushIntermediateSegment closure. `const` breaks tsc (TS2588 + the
    // declaration has no initializer). Hence the targeted disable on the next line.
    // eslint-disable-next-line prefer-const
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
      executionScalar?: boolean,
      pivotUnavailable?: boolean
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
      // PVT1 · accept rows-only segment pivots (filter-projection). Previously
      // required both rows AND values, which silently dropped filter-projection
      // hints from the agent and replaced them with parser-side defaults.
      if (segmentPivotDefaults?.rows?.length || segmentPivotDefaults?.values?.length) {
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
      } else if (pivotUnavailable === true) {
        // PVT5 · the agent ran an analytical step but its pivot-defaults
        // failed the unified safety contract (too many fields / unresolvable
        // values). Do NOT fall back to the parser-side provisional pivot —
        // we explicitly want the elegant "pivot unavailable" fallback to
        // render on this segment, not a backup pivot from the NL parser.
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
          ...(pivotUnavailable ? { pivotUnavailable: true } : {}),
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
        ...(pivotUnavailable ? { pivotUnavailable: true } : {}),
      } as PendingIntermediate);
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

    // Wave W-UD-integration · resolve the dataset fingerprint for this
    // session. When the chat doc already carries one (assigned at upload
    // or set by an earlier turn), reuse it; otherwise compute from the
    // dataset summary and fire a write-through that persists it under
    // `withSessionWriteLock` for future turns. The write is awaited only
    // because we need the resolved fingerprint to drive directive
    // hydration in the kickoff below — the cost is one fast Cosmos RMW
    // and only on first-touch sessions.
    const datasetFingerprint = await (async (): Promise<string | undefined> => {
      const existing = (chatDocument.datasetFingerprint ?? "").trim();
      if (existing.length > 0) return existing;
      const computed = fingerprintFromSummary(chatDocument.dataSummary);
      if (!computed || computed.length === 0) return undefined;
      // Mirror onto the in-memory chat doc so downstream callers (extractor,
      // appendDirective) see the same value even if the write is still
      // settling. The persisted-write below is fire-and-forget because the
      // in-memory value is enough for this turn.
      chatDocument.datasetFingerprint = computed;
      void ensureDatasetFingerprintForSession(
        sessionId,
        username,
        computed
      );
      return computed;
    })();

    // Wave WS2-pre-classify-parallel · the three pre-classify operations
    // with no data dependency on each other (schemaBind, parseUserQuery,
    // domainContext) fire concurrently here, then each is awaited at its
    // existing consumption point below. SSE thinking-step emissions stay
    // at their original line positions so on-wire ordering is byte-identical
    // to the pre-wave sequential code; the floor savings come from
    // parseUserQuery + domainContext overlapping with the
    // schemaBind → analyzeChatWithColumns serial chain.
    //
    // Wave W-UD-integration · the dataset-directive hydration also joins
    // this fan-out so the agent's `activeDirectives` are ready by the time
    // `buildAgentExecutionContext` runs inside `answerQuestion`.
    const kickoff = kickOffPreClassifyWork({
      bindSchemaColumns: () =>
        bindSchemaColumnsForAgentic(
          message,
          chatDocument.dataSummary,
          processingChatHistory
        ),
      parseUserQuery: () =>
        parseUserQuery(
          message,
          chatDocument.dataSummary,
          processingChatHistory
        ),
      loadDomainContext: async () => {
        const { loadEnabledDomainContext } = await import(
          "../../lib/domainContext/loadEnabledDomainContext.js"
        );
        return loadEnabledDomainContext();
      },
      // W-QL-FIX3 · mode classification depends only on domainContext (not
      // schemaBinding or intent analysis), so it chains after domainContext
      // and runs in parallel with the schemaBind → intent serial chain.
      classifyMode: (domainCtx) =>
        classifyMode(
          message,
          modeDetectionChatHistory,
          chatDocument.dataSummary,
          undefined,
          {
            permanentContext: chatDocument.permanentContext,
            domainContext: domainCtx?.text || undefined,
            userIntentVerbatim:
              chatDocument.sessionAnalysisContext?.userIntent?.verbatimNotes,
            userIntentConstraints:
              chatDocument.sessionAnalysisContext?.userIntent?.interpretedConstraints,
          }
        ),
      // Wave W-UD-integration · fetch the active per-dataset directives
      // for this `(username, datasetFingerprint)` in parallel with the
      // other pre-classify thunks. Returns `[]` when either field is
      // missing or the Cosmos read fails — a directives outage must
      // never block a chat turn.
      hydrateDirectives: () =>
        hydrateDirectivesForSession(username, datasetFingerprint),
    });

    onThinkingStep({
      step: "Mapping columns from schema",
      status: "active",
      timestamp: Date.now(),
    });

    const schemaBinding = await kickoff.schemaBinding;
    logger.log(`📌 Schema binding canonical columns:`, schemaBinding.canonicalColumns);

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

      logger.log(`🤖 AI Analysis Results:`);
      logger.log(`   Intent: ${chatAnalysis.intent}`);
      logger.log(`   User Intent: ${chatAnalysis.userIntent}`);
      logger.log(`   Relevant Columns:`, chatAnalysis.relevantColumns);
      logger.log(`   Analysis: ${chatAnalysis.analysis.substring(0, 200)}...`);

      onThinkingStep({
        step: "Analyzing user intent",
        status: "completed",
        timestamp: Date.now(),
        details: `Intent: ${chatAnalysis.intent}`,
      });
    } catch (error) {
      logger.error("⚠️ Chat analysis failed:", error);
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

    logger.log(`📊 Column binding & analysis summary:`);
    logger.log(
      `   Canonical (schema): ${schemaBinding.canonicalColumns.join(", ") || "(none)"}`
    );
    logger.log(
      `   Final relevant: ${chatAnalysis.relevantColumns.join(", ") || "(none)"}`
    );

    // W32 · `parseUserQuery` returns `QueryParserResult` (extends
    // `ParsedQuery` + `confidence: number`); the local var is widened
    // to `Record<string, unknown> | null` because four downstream sites
    // also use the generic-record shape. The cast matches the W27
    // `agentTrace` pattern — the runtime payload IS a serialisable
    // record, just statically tracked under a richer type.
    // WS2-pre-classify-parallel · kickoff catches throws → null so the
    // local try/catch is collapsed; on-wire semantics unchanged.
    parsedQueryForLoad = (await kickoff.parsedQuery) as
      | Record<string, unknown>
      | null;

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
      logger.debug("[chatStream] pivot pre-fallback inputs", {
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
      logger.debug(
        `[chat/stream] mode_override_ignored: received ${JSON.stringify(mode)} — using classifyMode only`
      );
    }

    // Wave D1 + D2 · Multi-part question detection. When
    // DEEP_INVESTIGATION_ENABLED=true AND the question matches a
    // multi-part conjunction shape ("show X AND tell me Y", "compare A,
    // also explain B"), surface a `flow_decision` SSE row using the
    // existing `{layer, chosen, candidates, reason}` schema (W8 / W11
    // contract) so the workbench renders it via the existing
    // `agentWorkbench.util.ts:260` converter — no client UI work needed.
    // The actual decomposition wiring (parallel agent turns, merged
    // narrator envelope) lands in Wave D3; today this is
    // observability-only so we can validate the detector against real
    // questions before committing to behaviour change.
    if (process.env.DEEP_INVESTIGATION_ENABLED === "true") {
      try {
        const { detectMultiPartQuestion } = await import(
          "../../lib/agents/runtime/detectMultiPartQuestion.js"
        );
        const intent = detectMultiPartQuestion(message);
        if (intent && intent.subQuestions.length > 1) {
          sendSSE(res, "flow_decision", {
            layer: "coordinator",
            chosen: `single_flow (${intent.subQuestions.length}-part question — decomposition deferred to Wave D3)`,
            overriddenBy: "single_flow_policy",
            candidates: intent.subQuestions,
            reason: `Multi-part question detected (trigger: ${intent.trigger}). With DEEP_INVESTIGATION_ENABLED=true, this would decompose into ${intent.subQuestions.length} parallel sub-investigations once the orchestrator wiring lands.`,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`D1 · multi-part detection failed: ${msg}`);
      }
    }

    // W-QL-FIX3 · mode classification was kicked off in the parallel
    // pre-classify block (chained after domainContext). Await the result
    // here at the original consumption site so SSE ordering is unchanged.
    let detectedMode: 'analysis' | 'dataOps' | 'modeling' = 'analysis';
    try {
      onThinkingStep({
        step: 'Detecting query type',
        status: 'active',
        timestamp: Date.now(),
      });

      const modeClassification = await kickoff.modeClassification;
      if (modeClassification) {
        detectedMode = modeClassification.mode;
        onThinkingStep({
          step: 'Detecting query type',
          status: 'completed',
          timestamp: Date.now(),
          details: `Detected: ${detectedMode} (confidence: ${(modeClassification.confidence * 100).toFixed(0)}%)`,
        });
        logger.log(
          `🎯 Classified mode: ${detectedMode} (confidence: ${modeClassification.confidence.toFixed(2)})`
        );
      } else {
        onThinkingStep({
          step: 'Detecting query type',
          status: 'completed',
          timestamp: Date.now(),
          details: 'Using default: analysis',
        });
      }
    } catch (error) {
      logger.error('⚠️ Mode classification failed, defaulting to analysis:', error);
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
      logger.warn("⚠️ user-hierarchy extraction skipped:", err);
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

    // Wave W-UD-integration · await the directive-hydration kickoff so the
    // active list is available when `buildAgentExecutionContext` runs inside
    // `answerQuestion`. The kickoff swallows errors to `[]` so this await is
    // never the source of a thrown chat turn.
    const activeDirectivesForTurn: UserDirective[] =
      (await kickoff.activeDirectives) ?? [];

    // Wave W-UD8 · per-turn sink for prompt-budget truncation events.
    // Threaded through `agentOptions.contextTrimmedSink` into the agent
    // execution context, where the synthesis / narrator / business-actions
    // helpers push one row per cap site that actually trimmed. After the
    // turn ends we emit a single coalesced `context_trimmed` SSE row.
    const contextTrimmedSink: TrimmedBlockInfo[] = [];

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
            activeDirectives: activeDirectivesForTurn,
            contextTrimmedSink,
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
            // Pivot disabled — intermediate artifacts skipped to speed up
            // time-to-answer. Re-enable by restoring the onIntermediateArtifact
            // callback here.
            onIntermediateArtifact: undefined,
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

    // ── PHASE 1: Immediate response ──────────────────────────────────
    // Response-first pipeline: send the answer + un-enriched charts to the
    // user immediately. All LLM enrichments (chart keyInsight, workbench
    // step insights, pivot insight, AI suggestions) run AFTER the response
    // SSE so the user sees the answer within ~100ms of answerQuestion().

    // attachAutoLayers is sync (~50ms) — keep before response
    if (result.charts && Array.isArray(result.charts)) {
      const safeQuestion = (message ?? "").slice(0, 4000);
      result.charts = result.charts.map((c) => attachAutoLayers(c, safeQuestion));
    }

    // Validate and enrich response
    const validated = validateAndEnrichResponse(result, chatDocument, chatLevelInsights);

    // Transform data operations response format for frontend compatibility
    // Frontend expects 'preview' and 'summary', but orchestrator returns 'table' and 'operationResult'
    const transformedResponse: any = { ...validated };
    if ((result as any).table && Array.isArray((result as any).table)) {
      transformedResponse.preview = (result as any).table;
      logger.log(`📊 Transformed table to preview: ${(result as any).table.length} rows`);
    }
    if ((result as any).operationResult) {
      if ((result as any).operationResult.summary && Array.isArray((result as any).operationResult.summary)) {
        transformedResponse.summary = (result as any).operationResult.summary;
        logger.log(`📋 Transformed operationResult.summary to summary: ${(result as any).operationResult.summary.length} items`);
      }
    }
    if ((result as any).agentTrace) {
      transformedResponse.agentTrace = (result as any).agentTrace;
    }
    // Wave AD1 · ensure every assistant message carries a stable turnId so
    // FeedbackButtons mount and past_analyses persistence has a valid doc id
    // (`${sessionId}__${turnId}`). Non-agentic paths (dataOps, synthesis-fallback
    // edge cases, repair branches) historically left agentTrace undefined, which
    // silently hid thumbs-up/down on the rendered message.
    {
      const existingTurnId = (transformedResponse.agentTrace as { turnId?: string } | undefined)?.turnId;
      if (!existingTurnId) {
        transformedResponse.agentTrace = {
          ...(transformedResponse.agentTrace || {}),
          turnId: randomUUID(),
        };
      }
    }
    // Pivot disabled — suppress auto-show unconditionally.
    transformedResponse.pivotAutoShow = false;
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
    // PVT5 · the agent ran an analytical step (we have a non-scalar trace
    // table) but `mergePivotDefaultsForResponse` couldn't ship a usable
    // pivot — the unified safety contract suppressed it. Signal the client
    // to render an elegant "pivot unavailable" fallback instead of silently
    // hiding the pivot or showing an empty drag-and-drop area.
    const hadAnalyticalTable = (() => {
      const t = (result as { table?: { rows?: unknown[] } }).table;
      return Array.isArray(t?.rows) && (t!.rows!.length ?? 0) > 0;
    })();
    if (
      hadAnalyticalTable
      && executionPivotDefaults?.scalar !== true
      && !transformedResponse.pivotDefaults
    ) {
      (transformedResponse as { pivotUnavailable?: boolean }).pivotUnavailable = true;
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
      logger.warn("[chatStream] rankingMeta enrichment failed", {
        message: (err as Error)?.message?.slice(0, 200),
      });
    }
    if (process.env.NODE_ENV !== "production") {
      logger.debug("[chatStream] pivotDefaults merged", {
        parser: parserPivotDefaults,
        execution: executionPivotDefaults,
        value: transformedResponse.pivotDefaults,
      });
    }

    // Pivot insight enrichment deferred to Phase 2 (after response SSE).

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

    // ── Send response SSE immediately (Phase 1) ──────────────────────
    // User sees the answer + un-enriched charts NOW. Enrichments stream
    // in later via response_charts / workbench_enriched SSE events.
    if (!checkConnection()) {
      return;
    }

    const splitCharts =
      isAgenticLoopEnabled() &&
      Array.isArray(transformedResponse.charts) &&
      transformedResponse.charts.length > 0;

    if (splitCharts) {
      if (
        !sendSSE(res, "response", {
          ...transformedResponse,
          charts: [],
          suggestions: [],
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
        suggestions: [],
      })
    ) {
      return;
    }

    // ── PHASE 2: Parallel enrichments ──────────────────────────────────
    // User already sees the answer. All LLM enrichments run in parallel.
    // Each emits its own SSE update as it completes.
    const safeSSE = (event: string, data: unknown): boolean => {
      if (checkConnection()) return sendSSE(res, event, data);
      return false;
    };

    // Wave W-UD8 · emit a single coalesced `context_trimmed` SSE row when
    // any of the prompt-budget cap sites trimmed user-bearing input during
    // the turn. The client renders this as a non-blocking toast so the user
    // knows their saved context was clipped to fit the model window.
    {
      const payload = formatContextTrimmedPayload(contextTrimmedSink);
      if (payload) safeSSE("context_trimmed", payload);
    }

    let domainContextForCharts: string | undefined;
    try {
      const { loadEnabledDomainContext } = await import(
        "../../lib/domainContext/loadEnabledDomainContext.js"
      );
      const { text } = await loadEnabledDomainContext();
      if (text?.trim()) domainContextForCharts = text;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`W12 · domain context load for chart commentary failed: ${msg}`);
    }

    let mergedSuggestedQuestions: string[] = [];
    const enrichSettled = await Promise.allSettled([
      // 1. Chart enrichment → send enriched response_charts
      (async () => {
        if (!result.charts?.length) return;
        const enriched = await enrichCharts(
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
        result.charts = enriched;
        transformedResponse.charts = enriched;
        safeSSE("response_charts", { charts: enriched });
      })(),

      // 2. Workbench step insights → send workbench_enriched
      (async () => {
        try {
          const { enrichStepInsights, isRichStepInsightsEnabled } = await import(
            "../../lib/agents/runtime/enrichStepInsights.js"
          );
          if (!isRichStepInsightsEnabled() || agentWorkbench.length === 0) return;
          const enrichResult = await enrichStepInsights({
            workbench: agentWorkbench,
            finalAnswer: result.answer ?? "",
            sessionAnalysisContext: chatDocument.sessionAnalysisContext,
            domainContext: domainContextForCharts,
            turnId: (result.agentTrace as { turnId?: string } | undefined)?.turnId ?? sessionId,
          });
          if (enrichResult.ok && enrichResult.enrichedCount > 0) {
            safeSSE("workbench_enriched", { entries: agentWorkbench });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn(`W19 · enrichStepInsights failed: ${msg}`);
        }
      })(),

      // 3. Pivot insight enrichment
      (async () => {
        const patch = await enrichPivotInsightFromEnvelope(result, transformedResponse, {
          userQuestion: message,
          domainContext: domainContextForCharts,
          intentEnvelope: (result as any)?.intentEnvelope,
        });
        Object.assign(transformedResponse, patch);
      })(),

      // 5. Wave W-UD-integration · per-dataset directive extraction +
      // persistence. Runs in parallel with the other enrichments so the
      // chat-turn critical path is untouched. Each extracted draft is
      // appended to the `dataset_directives` Cosmos doc and a sibling
      // `directive_added` SSE row is emitted so the client can render a
      // confirmation chip. No-op when no fingerprint is available
      // (legacy session) or when the deterministic extractor finds no
      // persistence-qualifier clause in the user message.
      (async () => {
        if (!datasetFingerprint || !username) return;
        try {
          await persistDirectivesFromUserMessage({
            username,
            fingerprint: datasetFingerprint,
            message,
            summary: chatDocument.dataSummary,
            existingDirectives: activeDirectivesForTurn,
            sourceSessionId: sessionId,
            sourceTurnId: String(targetTimestamp ?? turnStartedAt),
            appendDirective: (u, f, draft) => appendDirective(u, f, draft),
            onAdded: (directive) => {
              safeSSE("directive_added", {
                directive,
                fingerprint: datasetFingerprint,
              });
            },
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn(`W-UD-integration · directive persistence failed: ${msg}`);
        }
      })(),

      // 4. AI suggestions
      (async () => {
        try {
          const updatedChatHistory = [
            ...allMessages.slice(-15),
            { role: 'user' as const, content: message, timestamp: Date.now() },
            { role: 'assistant' as const, content: transformedResponse.answer, timestamp: Date.now() }
          ];
          const suggestions = await generateAISuggestions(
            updatedChatHistory,
            chatDocument.dataSummary,
            transformedResponse.answer,
            result.agentSuggestionHints
          );
          const enrichmentFollowUps = [
            ...(chatDocument.sessionAnalysisContext?.suggestedFollowUps ?? []),
            ...(chatDocument.datasetProfile?.suggestedQuestions ?? []),
          ];
          // UX · cap suggested questions at 5 (product rule: never more than 5).
          mergedSuggestedQuestions = [...new Set([...suggestions, ...enrichmentFollowUps])].slice(0, 5);
        } catch (error) {
          logger.error('Failed to generate suggestions:', error);
        }
      })(),
    ]);

    // ── Wave I3 · mirror the chat answer's per-chart insights onto the
    // dashboard ─────────────────────────────────────────────────────────
    // The dashboard is assembled inside `answerQuestion` BEFORE `enrichCharts`
    // runs, so its charts are bare. Now that `transformedResponse.charts`
    // carry the enriched `keyInsight`/`businessCommentary`, copy the SAME ones
    // onto (a) the in-memory draft — so the persisted message and the
    // offer-track "Build Dashboard" inherit them — and (b) the already-
    // persisted auto-created dashboard. No new LLM calls; best-effort, never
    // blocks the turn.
    try {
      const enrichedCharts = (transformedResponse.charts ?? []) as ChartSpec[];
      if (enrichedCharts.length > 0) {
        const { applyChartInsightsBySignature } = await import(
          "../../lib/applyChartInsightsBySignature.js"
        );
        const draft = (
          transformedResponse as {
            dashboardDraft?: { sheets?: Array<{ charts?: ChartSpec[] }> };
          }
        ).dashboardDraft;
        if (draft?.sheets?.length) {
          for (const sheet of draft.sheets) {
            if (Array.isArray(sheet.charts) && sheet.charts.length > 0) {
              sheet.charts = applyChartInsightsBySignature(
                sheet.charts,
                enrichedCharts
              ).charts;
            }
          }
        }
        const createdId = (
          transformedResponse as { createdDashboardId?: string }
        ).createdDashboardId;
        if (createdId && username) {
          const { patchDashboardChartInsights } = await import(
            "../../lib/patchDashboardChartInsights.js"
          );
          const res = await patchDashboardChartInsights({
            dashboardId: createdId,
            username,
            charts: enrichedCharts,
          });
          if (!res.ok) {
            logger.warn(`I3 · dashboard chart-insight patch skipped: ${res.reason}`);
          }
        }
      }
    } catch (insightPatchErr) {
      logger.warn("⚠️ dashboard chart-insight patch failed:", insightPatchErr);
    }

    // ── PHASE 3: Persistence ──────────────────────────────────────────
    // Persist enriched data so reload gets the full version. Persistence
    // runs even if the client disconnected during enrichment.

    // If targetTimestamp is provided, this is an edit operation
    // Truncate history AFTER processing (so processing had full context)
    // Only do this if we're actually editing (message exists), not for new messages
    if (targetTimestamp) {
      // Check if this message actually exists before trying to edit
      const existingMessage = chatDocument.messages?.find(
        (msg) => msg.timestamp === targetTimestamp && msg.role === 'user'
      );
      
      if (existingMessage) {
        logger.log('✏️ Editing message with targetTimestamp:', targetTimestamp);
        try {
          await updateMessageAndTruncate(sessionId, targetTimestamp, message);
          logger.log('✅ Message updated and messages truncated in database');
        } catch (truncateError) {
          logger.error('⚠️ Failed to update message and truncate:', truncateError);
          // Continue - don't fail the entire request
        }
      } else {
        // This is a new message, not an edit - ignore targetTimestamp
        logger.log(`ℹ️ targetTimestamp ${targetTimestamp} provided but message not found. Treating as new message.`);
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
        ...(pi.pivotUnavailable ? { pivotUnavailable: true } : {}),
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
        // PVT5 · persist the elegant-fallback signal so refreshing the
        // session shows the same "pivot unavailable" card as the active
        // turn, never silently drops the user back to a broken pivot.
        ...((transformedResponse as { pivotUnavailable?: boolean }).pivotUnavailable
          ? { pivotUnavailable: true }
          : {}),
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
        // {id, question} subset since that's all the UI needs. (C6: this only
        // populates now that answerQuestion forwards spawnedQuestions.)
        ...((() => {
          const persisted = toPersistedSpawnedQuestions(
            (result as { spawnedQuestions?: { id?: unknown; question?: unknown }[] }).spawnedQuestions
          );
          return persisted.length ? { spawnedQuestions: persisted } : {};
        })()),
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
        logger.log(`✅ Messages saved to chat: ${chatDocument.id}`);
      } else {
        logger.error(
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
            // AMR7 · raw pivot captures from execute_query_plan steps. The
            // `pivot_computed` analysis_memory entries reference the same
            // deterministic artifactId that past_analyses uses, so the
            // AnalysisMemory page can deep-link to the captured rows via
            // the AMR3c recall endpoint without duplicating storage.
            pivotArtifacts: (
              result as {
                pivotArtifacts?: import("../../lib/pastAnalysisPivotArtifact.js").RawPivotArtifact[];
              }
            ).pivotArtifacts,
          });
          if (memoryEntries.length > 0) {
            void appendMemoryEntries(memoryEntries).catch((e) =>
              logger.warn("⚠️ appendMemoryEntries fire-and-forget failed:", e)
            );
            scheduleIndexMemoryEntries(memoryEntries);
            logger.log(
              `📓 Memory: appended ${memoryEntries.length} entries for turn ${turnIdForMemory}`
            );
          }
        }
      } catch (memoryErr) {
        logger.warn("⚠️ analysisMemory turn-end write failed:", memoryErr);
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
        logger.warn("⚠️ sessionAnalysisContext assistant merge failed:", ctxErr);
      }
    } catch (cosmosError) {
      logger.error("⚠️ Failed to save messages to CosmosDB:", cosmosError);
    }

    // W2.3 · fire-and-forget persist of the completed turn for the semantic
    // cache (W5) and feedback loop (W5.5). Runs after enrichments so the
    // cached version includes keyInsight/businessCommentary.
    maybeWritePastAnalysisDoc({
      sessionId,
      userId: username,
      question: message,
      transformedResponse,
      chatDocument,
      turnStartedAt,
    });

    // Post-verifier business-actions seam. The agent loop spawned this
    // promise after the verifier returned `pass`; we await here so the
    // response event has already fired (giving the user immediate
    // AnswerCard) but `done` is held back until the agent resolves or
    // times out. On non-empty resolution, fire a dedicated SSE event the
    // client can fold into the rendered envelope, and patch the persisted
    // message in Cosmos so a refresh shows the same actions.
    try {
      const baPromise = (
        result as { businessActionsPromise?: Promise<unknown> }
      ).businessActionsPromise;
      if (baPromise) {
        const timeoutMs = Number(
          process.env.BUSINESS_ACTIONS_TIMEOUT_MS ?? "12000"
        );
        const timeoutSentinel: { __timeout: true } = { __timeout: true };
        const raced = await Promise.race([
          baPromise,
          new Promise<typeof timeoutSentinel>((resolve) =>
            setTimeout(() => resolve(timeoutSentinel), Math.max(1000, timeoutMs))
          ),
        ]);
        if (raced && (raced as typeof timeoutSentinel).__timeout) {
          logger.warn("⌛ businessActionsAgent timed out — skipping section");
        } else if (Array.isArray(raced) && raced.length > 0) {
          const items = raced as NonNullable<
            import("../../shared/schema.js").Message["businessActions"]
          >;
          sendSSE(res, "business_actions", {
            messageTimestamp: assistantMessageTimestamp,
            items,
          });
          try {
            const { patchAssistantBusinessActions } = await import(
              "../../lib/patchAssistantBusinessActions.js"
            );
            const patchResult = await patchAssistantBusinessActions({
              sessionId,
              username,
              messageTimestamp: assistantMessageTimestamp,
              items,
            });
            if (!patchResult.ok) {
              logger.warn(
                `⚠️ businessActions patch skipped: ${patchResult.reason}`
              );
            }
          } catch (patchErr) {
            logger.warn("⚠️ businessActions patch failed:", patchErr);
          }
          // AMR2 · also patch the cross-session past_analyses cache row so a
          // future cache-hit serves the same business actions. Read-modify-
          // upsert (mirrors `patchAssistantBusinessActions`). Fire-and-
          // forget — failures are swallowed; the live response is already
          // out the door at this point.
          try {
            const turnIdForCache: string | undefined = (
              transformedResponse as { agentTrace?: { turnId?: string } }
            )?.agentTrace?.turnId;
            if (turnIdForCache) {
              const cachePatchResult = await patchPastAnalysisBusinessActions({
                sessionId,
                turnId: turnIdForCache,
                items,
              });
              if (!cachePatchResult.ok) {
                logger.warn(
                  `⚠️ past_analyses businessActions patch skipped: ${cachePatchResult.reason}`
                );
              }
            }
          } catch (cachePatchErr) {
            logger.warn(
              "⚠️ past_analyses businessActions patch failed:",
              cachePatchErr
            );
          }
          // DPF2 · also patch the auto-created dashboard for this turn (if
          // any) so the dashboard view shows the same business actions the
          // chat message does. Best-effort, fire-and-forget — failure to
          // patch the dashboard never blocks the message-level patch above
          // or the SSE `done` event.
          try {
            const { getChatBySessionIdForUser } = await import(
              "../../models/chat.model.js"
            );
            const chatDoc = await getChatBySessionIdForUser(sessionId, username);
            const dashboardId = chatDoc?.lastCreatedDashboardId;
            if (dashboardId) {
              const { patchDashboardBusinessActions } = await import(
                "../../lib/patchDashboardBusinessActions.js"
              );
              const dashPatchResult = await patchDashboardBusinessActions({
                dashboardId,
                username,
                items,
              });
              if (!dashPatchResult.ok) {
                logger.warn(
                  `⚠️ dashboard businessActions patch skipped: ${dashPatchResult.reason}`
                );
              }
            }
          } catch (dashPatchErr) {
            logger.warn(
              "⚠️ dashboard businessActions patch failed:",
              dashPatchErr
            );
          }
        }
      }
    } catch (baErr) {
      logger.warn("⚠️ businessActions post-verifier hook errored:", baErr);
    }

    if (!sendSSE(res, 'done', {})) {
      return; // Client disconnected
    }

    if (!res.writableEnded && !res.destroyed) {
    res.end();
    }
    logger.log('✅ Stream completed successfully');
  } catch (error) {
    logger.error('Chat stream error:', error);
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
        logger.warn(`⚠️ Unauthorized SSE access attempt: ${username} tried to access session ${sessionId}`);
        sendSSE(res, 'error', { error: 'Unauthorized to access this session' });
        res.end();
        return;
      }
      
      // Handle CosmosDB connection errors
      const errorMessage = accessError instanceof Error ? accessError.message : String(accessError);
      if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('ETIMEDOUT') || accessError.code === 'ECONNREFUSED') {
        logger.error('❌ CosmosDB connection error in streamChatMessages:', errorMessage.substring(0, 100));
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
      // Build lookup map: chart axis-identity -> full chart with data. Keying on
      // the full identity (type::title::x::y::series) — not just type::title —
      // is what lets an investigated follow-up chart that shares a primary
      // chart's title but breaks the metric down differently re-attach its OWN
      // data instead of colliding and rendering empty on reload.
      const chartLookup = new Map<string, any>();
      chartsWithData.forEach(chart => {
        if (chart.title && chart.type) {
          chartLookup.set(chartIdentityKey(chart), chart);
        }
      });

      // Enrich message charts with data from top-level charts
      return messages.map(msg => {
        if (!msg.charts || msg.charts.length === 0) {
          return msg;
        }

        const enrichedCharts = msg.charts.map((chart: any) => {
          const key = chartIdentityKey(chart);
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
        logger.error('⚠️ Failed to load charts from blob in SSE:', blobError);
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
              logger.log(`🔄 SSE: Filtering duplicate message (exact match): ${msg.content?.substring(0, 50)}`);
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
              logger.log(`🔄 SSE: Filtering duplicate message (similar match): ${msg.content?.substring(0, 50)}`);
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
          logger.error('Error fetching chat messages for SSE:', error);
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
        logger.log(`🔄 SSE init: Filtering duplicate message (exact match): ${msg.content?.substring(0, 50)}`);
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
        logger.log(`🔄 SSE init: Filtering duplicate message (similar match): ${msg.content?.substring(0, 50)}`);
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
        logger.log('✅ SSE connection closed after initial analysis');
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
      logger.log('🚫 Client disconnected from SSE (initial analysis stream)');
    });

    // Handle errors - only log unexpected errors
    reqAsStream.on('error', (error: any) => {
      // ECONNRESET is expected when clients disconnect normally
      if (error.code !== 'ECONNRESET' && error.code !== 'EPIPE' && error.code !== 'ECONNABORTED') {
        logger.error('SSE connection error:', error);
      }
    });

  } catch (error) {
    logger.error("streamChatMessages error:", error);
    const message = error instanceof Error ? error.message : "Failed to stream chat messages.";
    sendSSE(res, 'error', { error: message });
    res.end();
  }
}

