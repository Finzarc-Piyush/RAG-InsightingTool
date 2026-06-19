import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AgentWorkbenchEntry,
  Message,
  UploadResponse,
  ChatResponse,
  ThinkingStep,
  TemporalDisplayGrain,
  type TemporalFacetColumnMeta,
} from '@/shared/schema';
import { uploadFile, streamChatRequest, snowflakeApi, getUploadJobStatus, type StreamIntermediatePayload } from '@/lib/api';
import type { DatasetEnrichmentPollSnapshot, UploadJobStatusResponse, UploadPhase } from '@/lib/api/uploadStatus';
import type { SnowflakeImportResponse } from '@/lib/api/snowflake';
import { sessionsApi } from '@/lib/api/sessions';
import { useToast } from '@/hooks/use-toast';
import { getUserEmail } from '@/utils/userStorage';
import { useLocation } from 'wouter';
import { useRef, useEffect, useState } from 'react';
import { findBusinessActionsTargetIndex } from '@/lib/chat/findBusinessActionsTarget';
import { useSessionBroadcast } from '@/lib/sessionBroadcast.hook';
import { logger } from '@/lib/logger';
import { temporalGrainsFromSummaryColumns } from '@/lib/dataSummaryGrains';
import {
  buildSyntheticInitialAssistantContent,
  suggestedFollowUpsFromSession,
} from '@/lib/initialAnalysisMessage';
import {
  DATASET_ENRICHMENT_LOADING_CONTENT,
  DATASET_PREVIEW_LOADING_CONTENT,
  isDatasetEnrichmentSystemMessage,
  isDatasetPreviewSystemMessage,
  normalizeDatasetSystemMessages,
} from './uploadSystemMessages';
import {
  type QueuedEarlyQuestion,
  shouldRefireEarlyQuestion,
  shouldHoldPollForRefire,
  persistQueuedQuestion,
  readQueuedQuestion,
  clearQueuedQuestion,
} from '@/lib/chat/earlyQuestionRefire';

interface UseHomeMutationsProps {
  sessionId: string | null;
  messages: Message[];
  setSessionId: (id: string | null) => void;
  setFileName: (fileName: string | null) => void;
  setInitialCharts: (charts: UploadResponse['charts']) => void;
  setInitialInsights: (insights: UploadResponse['insights']) => void;
  setSampleRows: (rows: Record<string, any>[]) => void;
  setColumns: (columns: string[]) => void;
  setNumericColumns: (columns: string[]) => void;
  setDateColumns: (columns: string[]) => void;
  setTemporalDisplayGrainsByColumn: (grains: Record<string, TemporalDisplayGrain>) => void;
  setTemporalFacetColumns: (cols: TemporalFacetColumnMeta[]) => void;
  setTotalRows: (rows: number) => void;
  setTotalColumns: (columns: number) => void;
  setCurrencyByColumn?: (
    map: Record<string, import('@/shared/schema').ColumnCurrency>
  ) => void;
  setWideFormatTransform?: (
    t: import('@/shared/schema').WideFormatTransform | undefined
  ) => void;
  /** SU-UX1 — populate from dataSummary.dateTimeColumnPairs on session load + upload. */
  setDateTimeColumnPairs?: (
    next: import('@/shared/schema').DateTimeColumnPair[]
  ) => void;
  /** SU-UX1 — populate from dataSummary.columns[].indicator on session load + upload. */
  setIndicators?: (
    next: import('@/components/IndicatorColumnsBanner').IndicatorEntry[]
  ) => void;
  setMessages: (messages: Message[] | ((prev: Message[]) => Message[])) => void;
  setSuggestions?: (suggestions: string[]) => void;
  setIsDatasetPreviewLoading?: (v: boolean) => void;
  setIsDatasetEnriching?: (v: boolean) => void;
  setEnrichmentPollSnapshot?: (snapshot: DatasetEnrichmentPollSnapshot | null) => void;
  onUploadProcessingStarted?: () => void;
  onUploadError?: (message?: string) => void;
  /**
   * W31 · receiver for the `session_context_updated` SSE event so the
   * W26 PriorInvestigationsBanner refreshes in place after each turn
   * without a page reload. Optional — when absent, the banner stays
   * stale until the next chat reload (today's behaviour).
   */
  setSessionAnalysisContext?: (
    updater: (prev: import('@/shared/schema').SessionAnalysisContext | undefined) =>
      import('@/shared/schema').SessionAnalysisContext | undefined
  ) => void;
}

export const useHomeMutations = ({
  sessionId,
  messages,
  setSessionId,
  setFileName,
  setInitialCharts,
  setInitialInsights,
  setSampleRows,
  setColumns,
  setNumericColumns,
  setDateColumns,
  setTemporalDisplayGrainsByColumn,
  setTemporalFacetColumns,
  setTotalRows,
  setTotalColumns,
  setCurrencyByColumn,
  setWideFormatTransform,
  setDateTimeColumnPairs,
  setIndicators,
  setMessages,
  setSuggestions,
  setIsDatasetPreviewLoading,
  setIsDatasetEnriching,
  setEnrichmentPollSnapshot,
  onUploadProcessingStarted,
  onUploadError,
  setSessionAnalysisContext,
}: UseHomeMutationsProps) => {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [location, setLocation] = useLocation();
  const userEmail = getUserEmail();
  const abortControllerRef = useRef<AbortController | null>(null);
  /**
   * Wave C2 · mounted-flag ref. Flipped to false in the unmount cleanup
   * useEffect below. Long-lived SSE callbacks (`onAgentEvent`,
   * `onThinkingStep`, `onIntermediate`) check this and bail before
   * calling any setX setter. Without this guard, an in-flight SSE chunk
   * delivered AFTER the user navigated away calls setMessages /
   * setColumns / etc. on an unmounted component — React 18 warns but
   * the deeper hazard is leaked work + stale promise chains.
   *
   * Note: the existing P-017 cleanup ALSO aborts the chat fetch. The
   * abort tells the server to stop streaming, but bytes already in
   * flight on the wire still trigger `onAgentEvent` callbacks once
   * before the abort surfaces in the stream reader. This ref catches
   * those tail-end callbacks.
   */
  const isMountedRef = useRef(true);
  /**
   * Captures the dashboard the agent auto-created during a streaming turn.
   * onSuccess inspects this to navigate the user to /dashboard?open=<id>
   * once the answer settles. Cleared on each new turn.
   */
  const autoCreatedDashboardRef = useRef<{ id: string; name?: string } | null>(
    null
  );
  const uploadPollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const uploadPollInFlightRef = useRef(false);

  // Wave E3 · Cross-tab broadcast. Peer-tab events fire when ANOTHER
  // browser tab on the same session completes a turn / updates SAC /
  // changes columns. We refetch the sessions cache so this tab's
  // messages + lifted state aren't stale.
  //
  // We deliberately invalidate the TanStack Query cache rather than
  // re-loading lifted state directly — the prefetched `sessions` query
  // key (warmed in App.tsx) is the authoritative source, and
  // invalidating it triggers TanStack to refetch and the relevant
  // selectors (Home.tsx) to re-read.
  const { emitSessionBroadcast } = useSessionBroadcast(sessionId, (event) => {
    if (!isMountedRef.current) return;
    if (
      event.kind === 'messages' ||
      event.kind === 'columns' ||
      event.kind === 'hierarchies' ||
      event.kind === 'permanent_context'
    ) {
      // Refresh the sidebar list (live query — per-session count + lastUpdated).
      queryClient.invalidateQueries({ queryKey: ['sessions', userEmail] });
      // E3-fix · The open chat's messages live in LOCAL React state, not a
      // TanStack query — the old `invalidateQueries(['session', sessionId])`
      // targeted a key no useQuery registers, so a peer tab never refreshed
      // its on-screen chat (the cross-tab "changes not reflected" bug). Do a
      // message-only refetch instead (keeps lifted preview/column state
      // untouched). Skip while THIS tab is mid-stream so we don't clobber its
      // in-flight answer — BroadcastChannel never echoes the sender, so every
      // event here is from a peer tab.
      if (sessionId && !abortControllerRef.current) {
        void sessionsApi
          .getSessionDetails(sessionId)
          .then((data) => {
            if (!isMountedRef.current || abortControllerRef.current) return;
            const s = ((data as any)?.session ?? data) as Record<string, any>;
            if (!Array.isArray(s?.messages)) return;
            setMessages(
              normalizeDatasetSystemMessages(s.messages as Message[], {
                hasPreview: previewStateRef.current.columns.length > 0,
                isEnriching:
                  s.enrichmentStatus === 'pending' ||
                  s.enrichmentStatus === 'in_progress',
              })
            );
          })
          .catch(() => {
            /* peer-tab refresh is best-effort */
          });
      }
    }
  });
  const pendingUserMessageRef = useRef<{ content: string; timestamp: number } | null>(null);
  /**
   * A question the user asked WHILE the dataset was still enriching. The server
   * can't answer yet (data table not materialized), so we hold it here and
   * re-fire it as a normal streaming turn once the upload poll reports the data
   * is truly ready (`status === 'completed'`). Survives a tab reload via
   * sessionStorage (see Wave 4 wiring). Single slot — latest queued wins.
   */
  const queuedEarlyQuestionRef = useRef<QueuedEarlyQuestion | null>(null);
  const previewStateRef = useRef<{ rows: Record<string, any>[]; columns: string[] }>({
    rows: [],
    columns: [],
  });
  const messagesRef = useRef<Message[]>(messages);
  /** Survives onDone state clears so onSuccess can attach trace to the user message. */
  const turnTraceRef = useRef<{ steps: ThinkingStep[]; workbench: AgentWorkbenchEntry[] }>({
    steps: [],
    workbench: [],
  });
  /** When SSE sends text before charts (agentic split), we append the assistant bubble early with this timestamp. */
  const earlyAssistantReplyTsRef = useRef<number | null>(null);
  const [thinkingSteps, setThinkingSteps] = useState<ThinkingStep[]>([]);
  const [agentWorkbenchLive, setAgentWorkbenchLive] = useState<AgentWorkbenchEntry[]>([]);
  // W12: live sub-questions spawned during deep investigation. Carry a stable
  // id per spawn so per-question feedback (thumbs up/down) can target it.
  // The SSE event still ships the legacy `questions: string[]` field for
  // back-compat; if `spawnedQuestions` is present we prefer it.
  const [spawnedSubQuestions, setSpawnedSubQuestions] = useState<
    { id: string; question: string }[]
  >([]);
  // Which spawned sub-questions have been INVESTIGATED by the follow-up pass
  // (keyed by id), with the number of charts each produced. Lets the
  // "Investigating further" chips flip from pending to investigated.
  const [investigatedSubQuestions, setInvestigatedSubQuestions] = useState<
    Record<string, { chartCount: number }>
  >({});
  // W38 · accumulating "drafting answer…" text from server streaming
  // narrator (`answer_chunk` SSE events). Empty until streaming starts;
  // reset between turns. The future UX surface for this preview lives in
  // a separate wave — for now the data flows so consumers can opt in.
  const [streamingNarratorPreview, setStreamingNarratorPreview] = useState<string>("");
  const [thinkingTargetTimestamp, setThinkingTargetTimestamp] = useState<number | null>(null);
  const [thinkingLiveAnchorTimestamp, setThinkingLiveAnchorTimestamp] = useState<number | null>(null);
  const hadIntermediateSegmentsRef = useRef(false);
  
  // Keep messagesRef in sync with messages
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    return () => {
      // Wave C2 · Flip the mounted flag BEFORE aborting so any callback
      // racing with the abort sees `isMountedRef.current === false` and
      // bails before calling setX.
      isMountedRef.current = false;
      if (uploadPollIntervalRef.current) {
        clearInterval(uploadPollIntervalRef.current);
        uploadPollIntervalRef.current = null;
      }
      // P-017: abort any in-flight chat stream on unmount so the fetch does
      // not try to setState on a gone component (and so SSE bytes stop).
      if (abortControllerRef.current) {
        try {
          abortControllerRef.current.abort();
        } catch {
          /* ignore */
        }
        abortControllerRef.current = null;
      }
    };
  }, []);

  const clearUploadPoll = () => {
    if (uploadPollIntervalRef.current) {
      clearInterval(uploadPollIntervalRef.current);
      uploadPollIntervalRef.current = null;
    }
    setEnrichmentPollSnapshot?.(null);
  };

  const upsertPreviewSystemMessage = () => {
    setMessages((prev) => {
      const existingIndex = prev.findIndex((m) => isDatasetPreviewSystemMessage(m));
      if (existingIndex >= 0) return prev;
      const previewMessage: Message = {
        role: 'assistant',
        content: DATASET_PREVIEW_LOADING_CONTENT,
        charts: [],
        insights: [],
        timestamp: Date.now(),
      };
      return [previewMessage, ...prev.filter((m) => !isDatasetEnrichmentSystemMessage(m))];
    });
  };

  const upsertEnrichmentSystemMessage = () => {
    setMessages((prev) => {
      const previewIndex = prev.findIndex((m) => isDatasetPreviewSystemMessage(m));
      if (previewIndex < 0) return prev;
      const existingIndex = prev.findIndex((m) => isDatasetEnrichmentSystemMessage(m));
      const message: Message = {
        role: 'assistant',
        content: DATASET_ENRICHMENT_LOADING_CONTENT,
        charts: [],
        insights: [],
        timestamp: prev[existingIndex]?.timestamp ?? Date.now(),
      };
      if (existingIndex >= 0) {
        const updated = [...prev];
        updated[existingIndex] = message;
        return updated;
      }
      const next = [...prev];
      next.splice(previewIndex + 1, 0, message);
      return next;
    });
  };

  const removeEnrichmentSystemMessage = () => {
    setMessages((prev) => prev.filter((m) => !isDatasetEnrichmentSystemMessage(m)));
  };

  const applyPreviewState = (payload: {
    rows?: Record<string, any>[];
    columns?: string[];
    numericColumns?: string[];
    dateColumns?: string[];
    rowCount?: number;
    columnCount?: number;
    summaryColumns?: Array<{
      name: string;
      currency?: import('@/shared/schema').ColumnCurrency;
      indicator?: {
        kind: 'boolean' | 'categorical';
        positiveValues?: string[];
        negativeValues?: string[];
        sentinelValues?: string[];
        source: 'auto' | 'llm' | 'user';
      };
      answersQuestions?: string[];
    }>;
    temporalFacetColumns?: TemporalFacetColumnMeta[];
    wideFormatTransform?: import('@/shared/schema').WideFormatTransform;
    dateTimeColumnPairs?: import('@/shared/schema').DateTimeColumnPair[];
    allowEmptyRowsOverwrite?: boolean;
  }) => {
    const nextColumns = payload.columns ?? [];
    const hasColumns = nextColumns.length > 0;
    const nextRows = Array.isArray(payload.rows) ? payload.rows : [];
    const hasRows = nextRows.length > 0;

    if (hasColumns) {
      setColumns(nextColumns);
      previewStateRef.current.columns = nextColumns;
    }
    if (hasRows || payload.allowEmptyRowsOverwrite) {
      setSampleRows(nextRows);
      previewStateRef.current.rows = nextRows;
    }
    if (payload.numericColumns) setNumericColumns(payload.numericColumns);
    if (payload.dateColumns) setDateColumns(payload.dateColumns);
    if (payload.summaryColumns) {
      setTemporalDisplayGrainsByColumn(temporalGrainsFromSummaryColumns(payload.summaryColumns));
      // WF9 — derive per-column currency map from the summary so the
      // banner and column chips can render currency badges.
      if (setCurrencyByColumn) {
        const map: Record<string, import('@/shared/schema').ColumnCurrency> = {};
        for (const col of payload.summaryColumns) {
          if (col.currency) map[col.name] = col.currency;
        }
        setCurrencyByColumn(map);
      }
    }
    if (payload.temporalFacetColumns !== undefined) {
      setTemporalFacetColumns(payload.temporalFacetColumns);
    }
    if (typeof payload.rowCount === 'number') setTotalRows(payload.rowCount);
    if (typeof payload.columnCount === 'number') setTotalColumns(payload.columnCount);
    if (setWideFormatTransform) {
      setWideFormatTransform(payload.wideFormatTransform);
    }
    // SU-UX1 · populate the per-session date×time pairs + indicator lists
    // from the dataSummary we just hydrated. Both come back in lockstep
    // with the rest of the schema metadata so the banners refresh on
    // every session-load + upload-complete event.
    if (setDateTimeColumnPairs) {
      setDateTimeColumnPairs(payload.dateTimeColumnPairs ?? []);
    }
    if (setIndicators && payload.summaryColumns) {
      const next: import('@/components/IndicatorColumnsBanner').IndicatorEntry[] =
        [];
      for (const c of payload.summaryColumns) {
        if (!c.indicator) continue;
        next.push({
          column: c.name,
          kind: c.indicator.kind,
          ...(c.indicator.positiveValues
            ? { positiveValues: c.indicator.positiveValues }
            : {}),
          ...(c.indicator.negativeValues
            ? { negativeValues: c.indicator.negativeValues }
            : {}),
          ...(c.indicator.sentinelValues
            ? { sentinelValues: c.indicator.sentinelValues }
            : {}),
          source: c.indicator.source,
          ...(c.answersQuestions ? { answersQuestions: c.answersQuestions } : {}),
        });
      }
      setIndicators(next);
    }

    return {
      hasColumns: hasColumns || previewStateRef.current.columns.length > 0,
      hasRows: hasRows || previewStateRef.current.rows.length > 0,
    };
  };

  const applySessionHydration = (
    session: Record<string, any>,
    opts: { syncMessages?: boolean; allowEmptyRowsOverwrite?: boolean } = {}
  ) => {
    if (!session) return;
    setFileName(session.fileName || null);
    setInitialCharts(session.charts || []);
    setInitialInsights(session.insights || []);
    if (session.dataSummary) {
      const previewState = applyPreviewState({
        rows: Array.isArray(session.sampleRows) ? session.sampleRows : [],
        columns: session.dataSummary.columns?.map((c: { name: string }) => c.name) || [],
        numericColumns: session.dataSummary.numericColumns || [],
        dateColumns: session.dataSummary.dateColumns || [],
        summaryColumns: session.dataSummary.columns,
        temporalFacetColumns: session.dataSummary.temporalFacetColumns ?? [],
        wideFormatTransform: session.dataSummary.wideFormatTransform,
        dateTimeColumnPairs: session.dataSummary.dateTimeColumnPairs ?? [],
        rowCount: session.dataSummary.rowCount || 0,
        columnCount: session.dataSummary.columnCount || 0,
        allowEmptyRowsOverwrite: opts.allowEmptyRowsOverwrite,
      });

      if (opts.syncMessages && Array.isArray(session.messages)) {
        const enriching =
          session.enrichmentStatus === 'pending' || session.enrichmentStatus === 'in_progress';
        setMessages(
          normalizeDatasetSystemMessages(session.messages as Message[], {
            hasPreview: previewState.hasColumns,
            isEnriching: enriching,
          })
        );
      }
    }
  };

  const hydrateSessionWithRetry = async (
    sid: string,
    opts: { retries?: number; backoffMs?: number; syncMessages?: boolean } = {}
  ) => {
    const retries = opts.retries ?? 3;
    const backoffMs = opts.backoffMs ?? 350;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const sessionData = await sessionsApi.getSessionDetails(sid);
      const session = (sessionData.session || sessionData) as Record<string, any>;
      const hasColumns = !!session?.dataSummary?.columns?.length;
      const rowCount = Number(session?.dataSummary?.rowCount || 0);
      const hasPreviewLike = hasColumns || rowCount > 0;
      applySessionHydration(session, {
        syncMessages: opts.syncMessages,
        allowEmptyRowsOverwrite: attempt === retries,
      });
      if (hasPreviewLike || attempt === retries) return session;
      await new Promise((resolve) => setTimeout(resolve, backoffMs * (attempt + 1)));
    }
  };

  const applyPreviewFromStatus = (
    status: UploadJobStatusResponse
  ): 'none' | 'partial' | 'full' => {
    const summary = status.previewSummary;
    if (!summary || !Array.isArray(summary.columns) || summary.columns.length === 0) {
      return 'none';
    }
    const rows = Array.isArray(status.previewSampleRows) ? status.previewSampleRows : [];
    const hasRows = rows.length > 0;
    applyPreviewState({
      rows,
      columns: summary.columns.map((c) => c.name),
      numericColumns: summary.numericColumns || [],
      dateColumns: summary.dateColumns || [],
      summaryColumns: summary.columns as any,
      // SU-UX1 · forward the upload-time pair detection so the banner
      // appears the moment the dataset preview finishes (no need to wait
      // for the next session-load round-trip).
      dateTimeColumnPairs:
        (summary as { dateTimeColumnPairs?: import('@/shared/schema').DateTimeColumnPair[] })
          .dateTimeColumnPairs ?? [],
      rowCount: summary.rowCount || 0,
      columnCount: summary.columnCount || 0,
      allowEmptyRowsOverwrite: false,
    });
    return hasRows ? 'full' : 'partial';
  };

  const startUploadJobPolling = (jobId: string, sessionId: string) => {
    clearUploadPoll();
    const deriveClientPhase = (st: UploadJobStatusResponse): UploadPhase => {
      if (st.phase) return st.phase;
      if (st.status === 'failed') return 'failed';
      if (st.status === 'completed') return 'completed';
      if (st.enrichmentStatus === 'pending' || st.enrichmentStatus === 'in_progress') return 'enriching';
      if (st.previewReady || st.status === 'preview_ready') return 'preparing_preview';
      if (st.status === 'saving') return 'finalizing';
      if (st.status === 'parsing') return 'preparing_preview';
      return 'queued';
    };
    const tick = async () => {
      if (uploadPollInFlightRef.current) return;
      uploadPollInFlightRef.current = true;
      try {
        const st = await getUploadJobStatus(jobId, sessionId);
        const phase = deriveClientPhase(st);
        setEnrichmentPollSnapshot?.({
          uploadProgress: st.progress,
          phase,
          phaseMessage: st.phaseMessage,
          enrichmentPhase: st.enrichmentPhase,
          enrichmentStep: st.enrichmentStep,
          understandingReady: !!st.understandingReady,
        });
        if (Array.isArray(st.suggestedQuestions) && st.suggestedQuestions.length > 0 && setSuggestions) {
          setSuggestions(st.suggestedQuestions);
        }
        if (st.status === 'failed') {
          clearUploadPoll();
          setIsDatasetPreviewLoading?.(false);
          setIsDatasetEnriching?.(false);
          // An early-queued question can never be answered now — drop it and say so.
          if (queuedEarlyQuestionRef.current) {
            queuedEarlyQuestionRef.current = null;
            clearQueuedQuestion(sessionId);
          }
          toast({
            title: 'Processing failed',
            description: st.error || 'Upload job failed.',
            variant: 'destructive',
          });
          return;
        }

        // A question asked during enrichment is held until the data is TRULY
        // ready (`status === 'completed'`), not the early `enrichmentStatus`
        // signal. While holding, keep the poll alive and keep showing the
        // "preparing" indicator so the user knows their question is pending.
        const holdForRefire = shouldHoldPollForRefire(st, !!queuedEarlyQuestionRef.current);

        // previewReady stays true through analyzing/saving/completed (see GET /api/upload/status)
        if (st.previewReady || st.status === 'preview_ready') {
          upsertPreviewSystemMessage();
          const fastPathState = applyPreviewFromStatus(st);
          let hydratedSession: Record<string, any> | null | undefined = null;
          if (fastPathState !== 'full') {
            hydratedSession = await hydrateSessionWithRetry(sessionId, {
              retries: fastPathState === 'partial' ? 1 : 2,
              syncMessages: true,
            });
          }

          // Only stop the preview loading state once we actually have sample
          // rows for display, or enrichment has completed.
          const rowsNow =
            previewStateRef.current.rows.length ||
            (Array.isArray(hydratedSession?.sampleRows) ? hydratedSession.sampleRows.length : 0);
          const previewStillLoading =
            !(rowsNow > 0 || st.enrichmentStatus === 'complete' || st.status === 'completed');
          setIsDatasetPreviewLoading?.(previewStillLoading);
          const enriching =
            !st.understandingReady &&
            st.enrichmentStatus === 'pending' ||
            (!st.understandingReady && st.enrichmentStatus === 'in_progress') ||
            (!st.understandingReady && st.enrichmentPhase === 'enriching') ||
            (!st.understandingReady && st.enrichmentPhase === 'waiting');
          setIsDatasetEnriching?.(enriching || holdForRefire);
          if (enriching || holdForRefire) {
            upsertEnrichmentSystemMessage();
          } else {
            removeEnrichmentSystemMessage();
          }
        }

        // `holdForRefire` keeps us here (still polling) until the TRUE
        // `status === 'completed'` lands, so we don't tear down on the early
        // `enrichmentStatus === 'complete'` and miss the re-fire window.
        if ((st.enrichmentStatus === 'complete' || st.status === 'completed') && !holdForRefire) {
          const queued = queuedEarlyQuestionRef.current;
          const wantsRefire = shouldRefireEarlyQuestion(st, queued);
          // If a manual turn is mid-flight, keep polling and retry the re-fire
          // on the next tick rather than dropping it.
          if (wantsRefire && chatMutation.isPending) {
            return;
          }

          clearUploadPoll();
          setIsDatasetPreviewLoading?.(false);
          setIsDatasetEnriching?.(false);
          removeEnrichmentSystemMessage();
          // Phase 0 · surface non-fatal warnings (e.g. Snowflake 500k truncation)
          // so large-data caveats aren't silent. Completion block runs once.
          if (Array.isArray(st.warnings) && st.warnings.length > 0) {
            toast({
              title: 'Heads up about your data',
              description: st.warnings.join(' '),
            });
          }
          await hydrateSessionWithRetry(sessionId, { retries: 3, syncMessages: true });

          // Data is fully materialized — re-fire the early question as a normal
          // streaming turn. `targetTimestamp` makes the mutation replace the
          // optimistic bubble in place (no duplicate user message); the hydrate
          // above already cleared the stale optimistic copy, so it re-appends.
          if (wantsRefire && queued) {
            queuedEarlyQuestionRef.current = null;
            clearQueuedQuestion(sessionId);
            chatMutation.mutate({ message: queued.content, targetTimestamp: queued.timestamp });
          }
        }
      } catch (e) {
        logger.error('Upload job poll error:', e);
      } finally {
        uploadPollInFlightRef.current = false;
      }
    };
    uploadPollIntervalRef.current = setInterval(() => {
      void tick();
    }, 1500);
    void tick();
  };

  // Don't sanitize markdown - we'll render it properly in MessageBubble
  // This preserves formatting like **bold** for headings

  const uploadMutation = useMutation({
    mutationFn: async ({
      file,
      fileSize,
      sheetName,
    }: {
      file: File;
      fileSize: number;
      sheetName?: string;
    }) => {
      // Store fileSize in a way we can access it in onSuccess
      (file as any)._fileSize = fileSize;
      return await uploadFile<any>('/api/upload', file, sheetName ? { sheetName } : undefined);
    },
    onSuccess: async (data, variables) => {
      logger.log("upload response from the backend", data);
      
      // Handle new async format (202 response with jobId and sessionId)
      if (data.jobId && data.sessionId && data.status === 'processing') {
        onUploadProcessingStarted?.();
        setSessionId(data.sessionId);
        setIsDatasetPreviewLoading?.(true);
        setIsDatasetEnriching?.(true);
        previewStateRef.current = { rows: [], columns: [] };
        setMessages([]);
        upsertPreviewSystemMessage();
        upsertEnrichmentSystemMessage();
        startUploadJobPolling(data.jobId, data.sessionId);
        toast({
          title: 'Upload started',
          description: 'Your dataset is queued and preview will appear shortly.',
        });
      } 
      // Handle old synchronous format (backward compatibility)
      else if (data.sessionId && data.summary) {
        onUploadProcessingStarted?.();
        setSessionId(data.sessionId);
        setFileName(data.fileName || null);
        setInitialCharts(data.charts || []);
        setInitialInsights(data.insights || []);
        
        if (data.sampleRows && data.sampleRows.length > 0) {
          setSampleRows(data.sampleRows);
          setColumns(data.summary.columns.map((c: any) => c.name));
          setNumericColumns(data.summary.numericColumns);
          setDateColumns(data.summary.dateColumns);
          setTemporalDisplayGrainsByColumn(temporalGrainsFromSummaryColumns(data.summary.columns));
          setTemporalFacetColumns(data.summary.temporalFacetColumns ?? []);
          setTotalRows(data.summary.rowCount);
          setTotalColumns(data.summary.columnCount);
          // WF9 — currency map + wide-format transform.
          if (setCurrencyByColumn) {
            const map: Record<string, import('@/shared/schema').ColumnCurrency> = {};
            for (const col of data.summary.columns ?? []) {
              if (col?.currency) map[col.name] = col.currency;
            }
            setCurrencyByColumn(map);
          }
          if (setWideFormatTransform) {
            setWideFormatTransform(data.summary.wideFormatTransform);
          }
        }
        
        const sac = (data as { sessionAnalysisContext?: import('@/shared/schema').SessionAnalysisContext })
          .sessionAnalysisContext;
        const prof = (data as { datasetProfile?: import('@/shared/schema').DatasetProfile }).datasetProfile;
        const followUps =
          suggestedFollowUpsFromSession({ sessionAnalysisContext: sac, datasetProfile: prof }) ??
          (data.suggestions && data.suggestions.length > 0 ? data.suggestions : undefined);
        const initialMessage: Message = {
          role: 'assistant',
          content: buildSyntheticInitialAssistantContent(data.summary, {
            sessionAnalysisContext: sac,
            datasetProfile: prof,
          }),
          charts: [],
          insights: [],
          suggestedQuestions: followUps,
          timestamp: Date.now(),
        };
        setMessages([initialMessage]);

        if (followUps && followUps.length > 0 && setSuggestions) {
          setSuggestions(followUps);
        }
        
        toast({
          title: 'Analysis Complete',
          description: 'Your data has been analyzed successfully!',
        });
      }
      
      // Invalidate sessions query to refresh the analysis list
      if (userEmail) {
        queryClient.invalidateQueries({ queryKey: ['sessions', userEmail] });
        logger.log('🔄 Invalidated sessions query for user:', userEmail);
      }
    },
    onError: (error) => {
      onUploadError?.(error instanceof Error ? error.message : 'Failed to upload file');
      clearUploadPoll();
      setIsDatasetPreviewLoading?.(false);
      setIsDatasetEnriching?.(false);
      toast({
        title: 'Upload Failed',
        description: error instanceof Error ? error.message : 'Failed to upload file',
        variant: 'destructive',
      });
    },
  });

  const applyImportStarted = async (data: { jobId: string; sessionId: string; fileName: string }) => {
    setSessionId(data.sessionId);
    setIsDatasetPreviewLoading?.(true);
    setIsDatasetEnriching?.(true);
    previewStateRef.current = { rows: [], columns: [] };
    setMessages([]);
    upsertPreviewSystemMessage();
    upsertEnrichmentSystemMessage();
    startUploadJobPolling(data.jobId, data.sessionId);
    toast({
      title: 'Import Started',
      description: 'Your Snowflake table is being processed.',
    });
    if (userEmail) {
      queryClient.invalidateQueries({ queryKey: ['sessions', userEmail] });
    }
  };

  const snowflakeImportMutation = useMutation({
    mutationFn: (params: { database: string; schema: string; tableName: string }) => snowflakeApi.importTable(params),
    onSuccess: async (data: SnowflakeImportResponse) => {
      if (data.jobId && data.sessionId && data.fileName) {
        await applyImportStarted({
          jobId: data.jobId,
          sessionId: data.sessionId,
          fileName: data.fileName,
        });
      }
    },
    onError: (error) => {
      clearUploadPoll();
      setIsDatasetPreviewLoading?.(false);
      setIsDatasetEnriching?.(false);
      toast({
        title: 'Snowflake Import Failed',
        description: error instanceof Error ? error.message : 'Failed to import table',
        variant: 'destructive',
      });
    },
  });

  const chatMutation = useMutation({
    mutationFn: async ({ message, targetTimestamp }: { message: string; targetTimestamp?: number }): Promise<ChatResponse> => {
      // Cancel previous request if any
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        // Remove the previous pending user message if it exists
        if (pendingUserMessageRef.current) {
          setMessages((prev) => {
            const updated = [...prev];
            const indexToRemove = updated.findIndex(
              m => m.role === 'user' && 
              m.content === pendingUserMessageRef.current!.content &&
              m.timestamp === pendingUserMessageRef.current!.timestamp
            );
            if (indexToRemove >= 0) {
              updated.splice(indexToRemove, 1);
            }
            return updated;
          });
          pendingUserMessageRef.current = null;
        }
      }
      
      // Create new abort controller
      abortControllerRef.current = new AbortController();
      
      // Track the current pending message - use the targetTimestamp if provided (from handleSendMessage)
      // or find the matching message in state by content
      const currentTimestamp = targetTimestamp || Date.now();
      // Find the actual message in state to get the exact timestamp
      const actualMessage = messagesRef.current
        .slice()
        .reverse()
        .find(m => m.role === 'user' && m.content === message);
      
      pendingUserMessageRef.current = { 
        content: message, 
        timestamp: actualMessage?.timestamp || currentTimestamp 
      };
      
      logger.log('📌 Tracking pending message:', pendingUserMessageRef.current);
      
      // Optimistic update: Add user message immediately before server confirmation
      const optimisticUserMessage: Message = {
        role: 'user',
        content: message,
        timestamp: actualMessage?.timestamp || currentTimestamp,
        userEmail: getUserEmail() || undefined,
      };
      
      // Add optimistic message to state immediately
      setMessages((prev) => {
        // Check if message already exists (for edit scenarios)
        const existingIndex = prev.findIndex(
          m => m.role === 'user' && 
          m.timestamp === optimisticUserMessage.timestamp
        );
        if (existingIndex >= 0) {
          // Replace existing message
          const updated = [...prev];
          updated[existingIndex] = optimisticUserMessage;
          return updated;
        }
        // Append new message
        return [...prev, optimisticUserMessage];
      });
      
      // Clear previous thinking / workbench trace
      turnTraceRef.current = { steps: [], workbench: [] };
      hadIntermediateSegmentsRef.current = false;
      setThinkingSteps([]);
      setAgentWorkbenchLive([]);
      setSpawnedSubQuestions([]);
      setInvestigatedSubQuestions({});
      setThinkingTargetTimestamp(null);
      setThinkingLiveAnchorTimestamp(null);
      // W38 · reset the streaming-narrator preview between turns.
      setStreamingNarratorPreview("");
      
      logger.log('📤 Sending chat message:', message);
      logger.log('📋 SessionId:', sessionId);
      
      if (!sessionId) {
        throw new Error('Session ID is required');
      }
      
      // Use ref to get latest messages (important for edit functionality)
      const currentMessages = messagesRef.current;
      logger.log('💬 Chat history length:', currentMessages.length);
      
      const lastUserMessage = targetTimestamp
        ? { timestamp: targetTimestamp }
        : [...currentMessages].reverse().find(msg => msg.role === 'user');
      if (lastUserMessage) {
        setThinkingTargetTimestamp(lastUserMessage.timestamp);
        setThinkingLiveAnchorTimestamp(lastUserMessage.timestamp);
      } else {
        setThinkingTargetTimestamp(null);
        setThinkingLiveAnchorTimestamp(null);
      }
      
      // Backend will fetch last 15 messages from Cosmos DB
      logger.log('📤 Request payload:', {
        sessionId,
        message,
      });
      
      // Routing is server-side (classifyMode); do not send client mode override.
      autoCreatedDashboardRef.current = null;
      return new Promise<ChatResponse>((resolve, reject) => {
        let responseData: ChatResponse | null = null;
        let pendingCharts: ChatResponse["charts"] | undefined;
        let streamResolved = false;

        streamChatRequest(
          sessionId,
          message,
          {
            onDashboardCreated: (payload) => {
              autoCreatedDashboardRef.current = {
                id: payload.dashboardId,
                name: payload.name,
              };
            },
            onQueued: () => {
              if (streamResolved) return;
              streamResolved = true;
              turnTraceRef.current = { steps: [], workbench: [] };
              hadIntermediateSegmentsRef.current = false;
              setThinkingSteps([]);
              setAgentWorkbenchLive([]);
              setThinkingTargetTimestamp(null);
              setThinkingLiveAnchorTimestamp(null);
              // Hold the question so the upload poll can re-fire it as a normal
              // streaming turn once the data is truly ready. The optimistic user
              // bubble + its timestamp are already in `messages` (added above) —
              // don't add it again. Persist for reload durability.
              const queued = pendingUserMessageRef.current;
              if (queued) {
                queuedEarlyQuestionRef.current = queued;
                if (sessionId) persistQueuedQuestion(sessionId, queued);
              }
              resolve({
                answer: '',
                charts: [],
                insights: [],
                suggestions: [],
                queuedUntilEnrichment: true,
              } as ChatResponse & { queuedUntilEnrichment?: boolean });
            },
            onThinkingStep: (step: ThinkingStep) => {
              // Wave C2 · Bail if unmounted (catches tail-end SSE chunks
              // that arrive after the user navigated away).
              if (!isMountedRef.current) return;
              logger.log('🧠 Thinking step received:', step);
              setThinkingSteps((prev) => {
                const existingIndex = prev.findIndex(s => s.step === step.step);
                const next =
                  existingIndex >= 0
                    ? (() => {
                        const updated = [...prev];
                        updated[existingIndex] = step;
                        logger.log('🔄 Updated thinking steps:', updated);
                        return updated;
                      })()
                    : (() => {
                        const newSteps = [...prev, step];
                        logger.log('➕ Added thinking step. Total steps:', newSteps.length);
                        return newSteps;
                      })();
                turnTraceRef.current = { ...turnTraceRef.current, steps: next };
                return next;
              });
            },
            onAgentEvent: (event: string, data: unknown) => {
              // Wave C2 · Bail if unmounted. Every SSE event handled
              // below (workbench, workbench_enriched, session_context_updated,
              // business_actions, answer_chunk, thinking, flow_decision,
              // …) calls setX setters; this early-return covers them all.
              if (!isMountedRef.current) return;
              if (event === 'workbench') {
                const entry = (data as { entry?: AgentWorkbenchEntry }).entry;
                if (!entry) return;
                setAgentWorkbenchLive((prev) => {
                  const next = [...prev, entry];
                  turnTraceRef.current = { ...turnTraceRef.current, workbench: next };
                  return next;
                });
              } else if (event === 'workbench_enriched') {
                // W19 · single-batched end-of-turn enrichment replaces the
                // entire workbench with entries whose `insight` field has
                // been backfilled by an LLM call. The client just swaps the
                // array reference; StepByStepInsightsPanel + ThinkingPanel
                // re-render with richer commentary.
                const entries = (data as { entries?: AgentWorkbenchEntry[] }).entries;
                if (Array.isArray(entries) && entries.length > 0) {
                  setAgentWorkbenchLive(entries);
                  turnTraceRef.current = {
                    ...turnTraceRef.current,
                    workbench: entries,
                  };
                }
              } else if (event === 'session_context_updated') {
                // W31 · server emits this after `persistMergeAssistantSessionContext`
                // appends the W21 priorInvestigation entry. Refresh the
                // lifted SAC state so the W26 PriorInvestigationsBanner
                // re-renders without a page reload. Optional setter — if
                // the host page didn't lift SAC (older mounts), the
                // banner stays stale until reload (today's behaviour).
                // H6 · also surfaces dimensionHierarchies updates so the
                // chip in ColumnsDisplay refreshes the same turn the user
                // declares "X is the category".
                const payload = data as {
                  priorInvestigations?: import('@/shared/schema').SessionAnalysisContext['sessionKnowledge']['priorInvestigations'];
                  dimensionHierarchies?: import('@/shared/schema').SessionAnalysisContext['dataset']['dimensionHierarchies'];
                };
                const hasPriors = Array.isArray(payload.priorInvestigations);
                const hasHierarchies = Array.isArray(payload.dimensionHierarchies);
                if ((hasPriors || hasHierarchies) && setSessionAnalysisContext) {
                  setSessionAnalysisContext((prev) => {
                    if (!prev) return prev;
                    return {
                      ...prev,
                      sessionKnowledge: hasPriors
                        ? {
                            ...prev.sessionKnowledge,
                            priorInvestigations: payload.priorInvestigations,
                          }
                        : prev.sessionKnowledge,
                      dataset: hasHierarchies
                        ? {
                            ...prev.dataset,
                            dimensionHierarchies: payload.dimensionHierarchies,
                          }
                        : prev.dataset,
                    };
                  });
                }
                // Wave E3 · Broadcast to peer tabs so they refetch this
                // session's chat doc. Both hierarchy and priorInvestigations
                // changes go through this single event — peer tabs need
                // a refresh regardless.
                if (hasPriors || hasHierarchies) {
                  emitSessionBroadcast('hierarchies');
                }
              } else if (event === 'business_actions') {
                // Server emits this after the post-verifier
                // businessActionsAgent resolves with non-empty items.
                // Arrives AFTER the response event.
                //
                // Wave C1 · Prefer EXACT messageTimestamp match (within
                // ±2000ms tolerance) over the pre-C1 recency-only
                // strategy. Pre-C1 we matched the "most recent
                // assistant message" because client/server clocks
                // diverge in the W38 streaming-narrator path. That was
                // FINE while the user only had one turn in flight, but
                // broke when the user regenerated mid-stream OR fired
                // a fresh turn before the prior turn's BAI promise
                // resolved (the 12-second post-verifier timeout window
                // is large). In those cases the items attached to the
                // wrong message. Now: exact match first, recency as
                // fallback only.
                const payload = data as {
                  messageTimestamp?: number;
                  items?: Array<{
                    title: string;
                    rationale: string;
                    horizon: 'now' | 'this_quarter' | 'strategic';
                    confidence: 'low' | 'medium' | 'high';
                    dependencies?: string;
                    expectedImpact?: string;
                  }>;
                };
                const items = Array.isArray(payload.items) ? payload.items : [];
                const serverTs = typeof payload.messageTimestamp === 'number'
                  ? payload.messageTimestamp
                  : null;
                if (items.length > 0) {
                  setMessages((prev) => {
                    const targetIdx = findBusinessActionsTargetIndex(prev, serverTs);
                    if (targetIdx === -1) return prev;
                    const next = [...prev];
                    next[targetIdx] = {
                      ...next[targetIdx],
                      businessActions: items,
                    };
                    return next;
                  });
                }
              } else if (event === 'answer_chunk') {
                // W38 · streaming narrator chunk. The server emits this
                // when STREAMING_NARRATOR_ENABLED=true; each chunk's
                // `delta` is the latest token slice from the LLM. We
                // accumulate into `streamingNarratorPreview` so future
                // UI can render a live "drafting answer…" preview before
                // the final structured envelope arrives. Reset by the
                // next turn's `onUserSent` reset path.
                const delta = (data as { delta?: string }).delta ?? "";
                if (delta) {
                  setStreamingNarratorPreview((prev) => prev + delta);
                }
              } else if (event === 'sub_question_spawned') {
                // W12: track spawned sub-questions for ThinkingPanel display.
                // Prefer the `spawnedQuestions: {id, question}[]` shape; fall
                // back to the legacy `questions: string[]` for back-compat.
                const payload = data as {
                  questions?: string[];
                  spawnedQuestions?: { id?: string; question?: string }[];
                };
                if (payload.spawnedQuestions?.length) {
                  const next = payload.spawnedQuestions
                    .filter((q): q is { id: string; question: string } =>
                      typeof q?.id === "string" && typeof q?.question === "string"
                    )
                    .map((q) => ({ id: q.id, question: q.question }));
                  if (next.length) setSpawnedSubQuestions((prev) => [...prev, ...next]);
                } else if (payload.questions?.length) {
                  // Legacy server: synthesise a hash-based id so feedback still
                  // addresses the question consistently within the session.
                  const next = payload.questions.map((q) => {
                    let h = 5381;
                    for (let i = 0; i < q.length; i++) h = ((h << 5) + h + q.charCodeAt(i)) | 0;
                    return { id: `legacy-${(h >>> 0).toString(36)}`, question: q };
                  });
                  setSpawnedSubQuestions((prev) => [...prev, ...next]);
                }
              } else if (event === 'sub_question_investigated') {
                // The follow-up pass investigated a spawned sub-question — flip
                // its chip from pending to investigated (with its chart count).
                const payload = data as { id?: string; chartCount?: number };
                if (typeof payload.id === 'string') {
                  const id = payload.id;
                  const chartCount = payload.chartCount ?? 0;
                  setInvestigatedSubQuestions((prev) => ({
                    ...prev,
                    [id]: { chartCount },
                  }));
                }
              } else if (event === 'persist_status') {
                // Wave A5 · server emits this when the chat-message Cosmos
                // write retries or terminally fails. Today we surface only
                // the terminal failure as a toast — the retry status is
                // observability-only. A future wave wires a "Save again"
                // affordance that re-POSTs the assistant message envelope.
                const payload = data as {
                  kind?: string;
                  status?: 'ok' | 'retrying' | 'failed';
                  attempt?: number;
                  error?: string;
                  messageTimestamp?: number;
                };
                if (payload?.status === 'failed') {
                  toast({
                    variant: 'destructive',
                    title: "Couldn't save your last answer",
                    description:
                      payload.error?.slice(0, 200) ??
                      'A database write failed after retries. Reload may not show this turn.',
                  });
                }
              } else if (event === 'directive_added') {
                // Wave W-UD9 · server emitted a per-dataset directive
                // chip after the W-UD5 extractor persisted a new
                // `UserDirective`. Surface a confirmation toast so the
                // user can SEE the rule took ("✓ Will exclude Hair Oil
                // from now on"). The full audit + revoke UI lives in
                // `ContextModal` — the toast is just the immediate
                // acknowledgement chip from plan §2.8.
                const payload = data as {
                  directive?: {
                    id?: string;
                    text?: string;
                    kind?: string;
                    structured?: {
                      column?: string;
                      op?: string;
                      values?: string[];
                    };
                  };
                };
                const d = payload.directive;
                if (d?.text) {
                  const structSummary =
                    d.structured?.column && d.structured?.op
                      ? ` (${d.structured.column} ${d.structured.op} ${(d.structured.values ?? []).join(', ')})`
                      : '';
                  toast({
                    title: 'Saved as a persistent rule',
                    description: `${d.text.slice(0, 200)}${structSummary}`,
                  });
                }
              } else if (event === 'session_renamed') {
                // V-AT3 · the server auto-titled this analysis from its first
                // Q&A. Refresh the sidebar so the new name appears immediately.
                queryClient.invalidateQueries({
                  queryKey: ['sessions', userEmail],
                });
              }
            },
            onIntermediate: (payload: StreamIntermediatePayload) => {
              // Wave C2 · bail if unmounted (mid-stream tail callbacks).
              if (!isMountedRef.current) return;
              hadIntermediateSegmentsRef.current = true;
              setThinkingLiveAnchorTimestamp(payload.assistantTimestamp);
              turnTraceRef.current = { steps: [], workbench: [] };
              setThinkingSteps([]);
              setAgentWorkbenchLive([]);
              setMessages((prev) => [
                ...prev,
                {
                  role: 'assistant' as const,
                  content: '',
                  timestamp: payload.assistantTimestamp,
                  preview: payload.preview as Message['preview'],
                  pivotDefaults: payload.pivotDefaults,
                  isIntermediate: true,
                  intermediateInsight: payload.insight,
                  thinkingBefore: {
                    steps: payload.thinkingSteps ?? [],
                    workbench: payload.workbench ?? [],
                  },
                  // PVT5 · ride the unavailable flag onto the intermediate
                  // assistant row so DataPreviewTable renders the elegant
                  // fallback in the Pivot tab.
                  ...((payload as { pivotUnavailable?: boolean }).pivotUnavailable
                    ? { pivotUnavailable: true }
                    : {}),
                } as Message,
              ]);
            },
            onResponse: (response: ChatResponse) => {
              // Wave C2 · bail if unmounted.
              if (!isMountedRef.current) return;
              logger.log('✅ API response received:', response);
              responseData = response;
              if (pendingCharts !== undefined && responseData) {
                responseData = { ...responseData, charts: pendingCharts };
                pendingCharts = undefined;
              }
              // Agentic split: show answer text immediately; charts arrive in response_charts.
              const textFirst =
                Boolean(response.answer?.trim()) &&
                Array.isArray(response.charts) &&
                response.charts.length === 0;
              if (textFirst) {
                const ts = Date.now();
                earlyAssistantReplyTsRef.current = ts;
                const pendingTs = pendingUserMessageRef.current?.timestamp;
                const traceSnapshot = turnTraceRef.current;
                const skipUserThinkingAttach = hadIntermediateSegmentsRef.current;
                setMessages((prev) => {
                  const withTrace =
                    !skipUserThinkingAttach &&
                    pendingTs != null &&
                    (traceSnapshot.steps.length > 0 || traceSnapshot.workbench.length > 0)
                      ? prev.map((m) =>
                          m.role === 'user' && m.timestamp === pendingTs
                            ? {
                                ...m,
                                ...(traceSnapshot.steps.length > 0
                                  ? { thinkingSteps: [...traceSnapshot.steps] }
                                  : {}),
                                ...(traceSnapshot.workbench.length > 0
                                  ? { agentWorkbench: [...traceSnapshot.workbench] }
                                  : {}),
                              }
                            : m
                        )
                      : prev;
                  return [
                    ...withTrace,
                    {
                      role: 'assistant' as const,
                      content: response.answer,
                      charts: [],
                      insights: response.insights ?? [],
                      timestamp: ts,
                      agentTrace: (response as { agentTrace?: Message['agentTrace'] }).agentTrace,
                      preview: (response as unknown as Message & { preview?: Message['preview'] }).preview,
                      // Honor the server's explicit pivot auto-show hint. Without
                      // this the field was dropped, so computeAllowPivotAutoShow
                      // fell back to row-presence heuristics and the server's
                      // scalar-suppression / explicit-show signal was ignored.
                      ...((response as { pivotAutoShow?: boolean }).pivotAutoShow !== undefined
                        ? { pivotAutoShow: (response as { pivotAutoShow?: boolean }).pivotAutoShow }
                        : {}),
                      summary: (response as unknown as Message & { summary?: Message['summary'] }).summary,
                      pivotDefaults:
                        (response as unknown as Message & { pivotDefaults?: Message['pivotDefaults'] })
                          .pivotDefaults,
                      // PVT5 · ride the unavailable flag onto the assistant
                      // message so DataPreviewTable renders the elegant
                      // fallback when the agent ran an analytical step but
                      // pivot defaults failed the safety contract.
                      ...((response as { pivotUnavailable?: boolean }).pivotUnavailable
                        ? { pivotUnavailable: true }
                        : {}),
                      thinkingBefore: (response as unknown as Message & { thinkingBefore?: Message['thinkingBefore'] })
                        .thinkingBefore,
                      // Forward the structured answerEnvelope so AnswerCard
                      // renders the TL;DR / findings / implications /
                      // recommendations / domainLens block on the active turn
                      // (not just on session refresh).
                      ...((response as { answerEnvelope?: Message['answerEnvelope'] }).answerEnvelope
                        ? {
                            answerEnvelope: (
                              response as { answerEnvelope: Message['answerEnvelope'] }
                            ).answerEnvelope,
                          }
                        : {}),
                      // BAI1 · top-level businessActions when the chatResponse
                      // shipped them inline (rare today — the field is
                      // typically populated via the separate `business_actions`
                      // SSE event after the response, but the schema allows it
                      // and we forward it for forward-compatibility).
                      ...((response as { businessActions?: Message['businessActions'] }).businessActions
                        ? {
                            businessActions: (
                              response as { businessActions: Message['businessActions'] }
                            ).businessActions,
                          }
                        : {}),
                      // AMR5 · cross-session recall provenance + rich payload.
                      // Set on a cache-hit response; absent on fresh turns.
                      // Drives the "Recalled from prior analysis" chip in
                      // MessageBubble and tells DataPreviewTable to mount the
                      // rehydrated pivot directly (inline rows) or fetch the
                      // offloaded artifact on demand (AMR6).
                      ...((response as { recalledFromPriorAnalysis?: Message['recalledFromPriorAnalysis'] })
                        .recalledFromPriorAnalysis
                        ? {
                            recalledFromPriorAnalysis: (
                              response as { recalledFromPriorAnalysis: Message['recalledFromPriorAnalysis'] }
                            ).recalledFromPriorAnalysis,
                          }
                        : {}),
                      ...((response as { pivotArtifacts?: Message['pivotArtifacts'] }).pivotArtifacts
                        ? {
                            pivotArtifacts: (
                              response as { pivotArtifacts: Message['pivotArtifacts'] }
                            ).pivotArtifacts,
                          }
                        : {}),
                      ...((response as { investigationSummary?: Message['investigationSummary'] })
                        .investigationSummary
                        ? {
                            investigationSummary: (
                              response as { investigationSummary: Message['investigationSummary'] }
                            ).investigationSummary,
                          }
                        : {}),
                      ...(response.followUpPrompts?.length
                        ? { followUpPrompts: response.followUpPrompts }
                        : {}),
                    },
                  ];
                });
              }
            },
            onResponseCharts: (payload) => {
              if (responseData) {
                responseData = { ...responseData, charts: payload.charts };
              } else {
                pendingCharts = payload.charts;
              }
              const earlyTs = earlyAssistantReplyTsRef.current;
              if (earlyTs != null && payload.charts?.length) {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.role === 'assistant' && m.timestamp === earlyTs
                      ? { ...m, charts: payload.charts }
                      : m
                  )
                );
              }
            },
            onError: (error: Error) => {
              logger.error('❌ API request failed:', error);
              toast({
                title: 'Request failed',
                description: error.message || 'The server reported an error during streaming.',
                variant: 'destructive',
              });
              earlyAssistantReplyTsRef.current = null;
              hadIntermediateSegmentsRef.current = false;
              turnTraceRef.current = { steps: [], workbench: [] };
              setThinkingSteps([]);
              setAgentWorkbenchLive([]);
              setThinkingTargetTimestamp(null);
              setThinkingLiveAnchorTimestamp(null);
              reject(error);
            },
            onDone: () => {
              logger.log('✅ Stream completed');
              setThinkingSteps([]);
              setAgentWorkbenchLive([]);
              setThinkingTargetTimestamp(null);
              setThinkingLiveAnchorTimestamp(null);
              if (streamResolved) return;
              if (responseData) {
                resolve(responseData);
              } else {
                reject(new Error('No response received'));
              }
            },
          },
          abortControllerRef.current!.signal,
          targetTimestamp
        ).catch((error: any) => {
            earlyAssistantReplyTsRef.current = null;
            hadIntermediateSegmentsRef.current = false;
            setThinkingLiveAnchorTimestamp(null);
            if (error?.name === 'AbortError' || abortControllerRef.current?.signal.aborted) {
            logger.log('🚫 Request was cancelled by user');
              turnTraceRef.current = { steps: [], workbench: [] };
              setThinkingSteps([]);
              setAgentWorkbenchLive([]);
              setThinkingTargetTimestamp(null);
            reject(new Error('Request cancelled'));
          } else {
            turnTraceRef.current = { steps: [], workbench: [] };
            setThinkingSteps([]);
              setAgentWorkbenchLive([]);
              setThinkingTargetTimestamp(null);
            reject(error);
          }
        });
      });
    },
    onSuccess: (data, variables) => {
      logger.log('✅ Chat response received:', data);
      logger.log('📝 Answer:', data.answer);
      logger.log('📊 Charts:', data.charts?.length || 0);
      logger.log('💡 Insights:', data.insights?.length || 0);
      logger.log('💬 Suggestions:', data.suggestions?.length || 0);

      if ((data as ChatResponse & { queuedUntilEnrichment?: boolean }).queuedUntilEnrichment) {
        // Keep queuedEarlyQuestionRef — the upload poll re-fires it once the
        // data is fully ready. Only the per-turn pending ref is cleared.
        pendingUserMessageRef.current = null;
        turnTraceRef.current = { steps: [], workbench: [] };
        toast({
          title: 'Got your question',
          description:
            "Your data is still being prepared. I'll answer this automatically as soon as it's ready.",
        });
        return;
      }

      const pendingTs = pendingUserMessageRef.current?.timestamp;
      pendingUserMessageRef.current = null;
      const segmentedTurn = hadIntermediateSegmentsRef.current;
      hadIntermediateSegmentsRef.current = false;
      setThinkingLiveAnchorTimestamp(null);

      if (!data.answer || data.answer.trim().length === 0) {
        logger.error('❌ Empty answer received from server!');
        earlyAssistantReplyTsRef.current = null;
        turnTraceRef.current = { steps: [], workbench: [] };
        toast({
          title: 'Error',
          description: 'Received empty response from server. Please try again.',
          variant: 'destructive',
        });
        return;
      }
      
      // Prefer the SSE-captured id (fires before `response` over the wire);
      // fall back to whatever the response payload carried, in case the
      // dedicated event was missed.
      const autoDashboardId =
        autoCreatedDashboardRef.current?.id ??
        (data as { createdDashboardId?: string }).createdDashboardId;

      const assistantMessage: Message & { preview?: any[]; summary?: any[] } = {
        role: 'assistant',
        content: data.answer, // Keep markdown formatting for proper rendering
        charts: data.charts,
        insights: data.insights,
        timestamp: Date.now(),
        preview: (data as any).preview,
        summary: (data as any).summary,
        pivotDefaults: (data as unknown as Message & { pivotDefaults?: Message['pivotDefaults'] }).pivotDefaults,
        thinkingBefore: (data as unknown as Message & { thinkingBefore?: Message['thinkingBefore'] }).thinkingBefore,
        // Forward the structured answerEnvelope so AnswerCard renders on the
        // active turn. Without this, message.answerEnvelope is undefined and
        // MessageBubble falls back to the markdown-only block.
        ...((data as { answerEnvelope?: Message['answerEnvelope'] }).answerEnvelope
          ? {
              answerEnvelope: (
                data as { answerEnvelope: Message['answerEnvelope'] }
              ).answerEnvelope,
            }
          : {}),
        // Top-level businessActions if shipped inline. The standard path is
        // the separate `business_actions` SSE event that fires AFTER the
        // response — but if the server ever pre-populates it, surface it.
        ...((data as { businessActions?: Message['businessActions'] }).businessActions
          ? {
              businessActions: (
                data as { businessActions: Message['businessActions'] }
              ).businessActions,
            }
          : {}),
        // AMR5 · cross-session recall provenance + rich payload (cache hit).
        ...((data as { recalledFromPriorAnalysis?: Message['recalledFromPriorAnalysis'] })
          .recalledFromPriorAnalysis
          ? {
              recalledFromPriorAnalysis: (
                data as { recalledFromPriorAnalysis: Message['recalledFromPriorAnalysis'] }
              ).recalledFromPriorAnalysis,
            }
          : {}),
        ...((data as { pivotArtifacts?: Message['pivotArtifacts'] }).pivotArtifacts
          ? {
              pivotArtifacts: (
                data as { pivotArtifacts: Message['pivotArtifacts'] }
              ).pivotArtifacts,
            }
          : {}),
        ...((data as { investigationSummary?: Message['investigationSummary'] })
          .investigationSummary
          ? {
              investigationSummary: (
                data as { investigationSummary: Message['investigationSummary'] }
              ).investigationSummary,
            }
          : {}),
        ...(data.followUpPrompts?.length ? { followUpPrompts: data.followUpPrompts } : {}),
        ...(autoDashboardId ? { createdDashboardId: autoDashboardId } : {}),
      };
      
      logger.log('💬 Adding assistant message to chat:', assistantMessage.content.substring(0, 50));
      logger.log('📊 Message includes:', {
        hasCharts: !!assistantMessage.charts?.length,
        hasInsights: !!assistantMessage.insights?.length,
        contentLength: assistantMessage.content?.length || 0
      });
      logger.log('📌 Pivot defaults in stream payload:', {
        hasPivotDefaults: Boolean(
          (data as unknown as Message & { pivotDefaults?: Message['pivotDefaults'] }).pivotDefaults
        ),
        pivotDefaults:
          (data as unknown as Message & { pivotDefaults?: Message['pivotDefaults'] }).pivotDefaults,
      });
      
      const traceSnapshot = turnTraceRef.current;
      turnTraceRef.current = { steps: [], workbench: [] };

      const earlyTs = earlyAssistantReplyTsRef.current;
      earlyAssistantReplyTsRef.current = null;

      setMessages((prev) => {
        if (earlyTs != null) {
          const aiIdx = prev.findIndex(
            (m) => m.role === 'assistant' && m.timestamp === earlyTs
          );
          if (aiIdx >= 0) {
            const next = [...prev];
            const existingEnvelope = (
              next[aiIdx] as { answerEnvelope?: Message['answerEnvelope'] }
            ).answerEnvelope;
            const incomingEnvelope = (
              data as { answerEnvelope?: Message['answerEnvelope'] }
            ).answerEnvelope;
            const existingActions = (
              next[aiIdx] as { businessActions?: Message['businessActions'] }
            ).businessActions;
            const incomingActions = (
              data as { businessActions?: Message['businessActions'] }
            ).businessActions;
            next[aiIdx] = {
              ...next[aiIdx],
              content: data.answer,
              charts: data.charts,
              insights: data.insights,
              preview: (data as any).preview,
              summary: (data as any).summary,
              pivotDefaults:
                (data as unknown as Message & { pivotDefaults?: Message['pivotDefaults'] }).pivotDefaults,
              agentTrace: (data as { agentTrace?: Message['agentTrace'] }).agentTrace,
              thinkingBefore: (data as unknown as Message & { thinkingBefore?: Message['thinkingBefore'] }).thinkingBefore,
              // Prefer the freshly-arrived envelope from the response payload;
              // keep the early-bubble envelope (if onResponse already attached
              // one) as a fallback so a missing field on the final payload
              // can never erase it.
              ...(incomingEnvelope || existingEnvelope
                ? { answerEnvelope: incomingEnvelope ?? existingEnvelope }
                : {}),
              // BAI1 · businessActions land via a dedicated `business_actions`
              // SSE event AFTER the response; the SSE handler may have
              // populated `next[aiIdx].businessActions` already. Only overwrite
              // with the response payload if it actually carries them.
              ...(incomingActions || existingActions
                ? { businessActions: incomingActions ?? existingActions }
                : {}),
              // AMR5 · merge recall provenance + rich payload into the
              // early-bubble updated path. Same incoming-OR-existing pattern
              // so a missing field on the final response can never erase one
              // already attached.
              ...(((data as { recalledFromPriorAnalysis?: Message['recalledFromPriorAnalysis'] })
                .recalledFromPriorAnalysis ??
                (next[aiIdx] as { recalledFromPriorAnalysis?: Message['recalledFromPriorAnalysis'] })
                  .recalledFromPriorAnalysis)
                ? {
                    recalledFromPriorAnalysis:
                      (data as { recalledFromPriorAnalysis?: Message['recalledFromPriorAnalysis'] })
                        .recalledFromPriorAnalysis ??
                      (next[aiIdx] as { recalledFromPriorAnalysis?: Message['recalledFromPriorAnalysis'] })
                        .recalledFromPriorAnalysis,
                  }
                : {}),
              ...(((data as { pivotArtifacts?: Message['pivotArtifacts'] }).pivotArtifacts ??
                (next[aiIdx] as { pivotArtifacts?: Message['pivotArtifacts'] }).pivotArtifacts)
                ? {
                    pivotArtifacts:
                      (data as { pivotArtifacts?: Message['pivotArtifacts'] }).pivotArtifacts ??
                      (next[aiIdx] as { pivotArtifacts?: Message['pivotArtifacts'] }).pivotArtifacts,
                  }
                : {}),
              ...(((data as { investigationSummary?: Message['investigationSummary'] })
                .investigationSummary ??
                (next[aiIdx] as { investigationSummary?: Message['investigationSummary'] })
                  .investigationSummary)
                ? {
                    investigationSummary:
                      (data as { investigationSummary?: Message['investigationSummary'] })
                        .investigationSummary ??
                      (next[aiIdx] as { investigationSummary?: Message['investigationSummary'] })
                        .investigationSummary,
                  }
                : {}),
              ...(data.followUpPrompts?.length ? { followUpPrompts: data.followUpPrompts } : {}),
              ...(autoDashboardId ? { createdDashboardId: autoDashboardId } : {}),
            };
            const withFinalTrace =
              !segmentedTurn &&
              pendingTs != null &&
              (traceSnapshot.steps.length > 0 || traceSnapshot.workbench.length > 0)
                ? next.map((m) =>
                    m.role === 'user' && m.timestamp === pendingTs
                      ? {
                          ...m,
                          ...(traceSnapshot.steps.length > 0
                            ? { thinkingSteps: [...traceSnapshot.steps] }
                            : {}),
                          ...(traceSnapshot.workbench.length > 0
                            ? { agentWorkbench: [...traceSnapshot.workbench] }
                            : {}),
                        }
                      : m
                  )
                : next;
            logger.log('📋 Total messages now (text-first merge):', withFinalTrace.length);
            return withFinalTrace;
          }
        }

        const withTrace =
          !segmentedTurn &&
          pendingTs != null &&
          (traceSnapshot.steps.length > 0 || traceSnapshot.workbench.length > 0)
            ? prev.map((m) =>
                m.role === 'user' && m.timestamp === pendingTs
                  ? {
                      ...m,
                      ...(traceSnapshot.steps.length > 0
                        ? { thinkingSteps: [...traceSnapshot.steps] }
                        : {}),
                      ...(traceSnapshot.workbench.length > 0
                        ? { agentWorkbench: [...traceSnapshot.workbench] }
                        : {}),
                    }
                  : m
              )
            : prev;
        const updated = [...withTrace, assistantMessage];
        logger.log('📋 Total messages now:', updated.length);
        return updated;
      });

      // Update suggestions if provided
      if (data.suggestions && setSuggestions) {
        setSuggestions(data.suggestions);
      }

      // Auto-navigate when the agent persisted a dashboard for this turn.
      // The user explicitly asked for one, so route them straight to it.
      // Only fire on /analysis to avoid stealing focus from /history etc.
      if (autoDashboardId && location.startsWith('/analysis')) {
        const dashName =
          autoCreatedDashboardRef.current?.name ??
          (autoDashboardId ? 'Dashboard' : '');
        toast({
          title: 'Dashboard saved',
          description: dashName ? `Opening "${dashName}"…` : 'Opening dashboard…',
        });
        setLocation(`/dashboard?open=${encodeURIComponent(autoDashboardId)}`);
      }
      autoCreatedDashboardRef.current = null;
      // Wave E3 · Broadcast to peer tabs that this session got a new
      // assistant message so they can refresh their history. Fires at
      // the END of onSuccess so the broadcast carries the FULL turn
      // state (including business actions, charts, pivot artifacts if
      // present inline).
      emitSessionBroadcast('messages');
    },
    onError: (error, variables) => {
      // Clear pending message ref
      const pendingMessage = pendingUserMessageRef.current;
      pendingUserMessageRef.current = null;
      earlyAssistantReplyTsRef.current = null;
      hadIntermediateSegmentsRef.current = false;
      turnTraceRef.current = { steps: [], workbench: [] };
      setThinkingSteps([]);
      setAgentWorkbenchLive([]);
      setThinkingTargetTimestamp(null);
      setThinkingLiveAnchorTimestamp(null);

      // Don't show toast for cancelled requests
      if (error instanceof Error && error.message === 'Request cancelled') {
        // Remove the user message that was added when the request was sent
        // since the request was cancelled and won't be saved
        if (pendingMessage) {
          setMessages((prev) => {
            const updated = [...prev];
            // Find and remove the user message that matches the cancelled request
            const indexToRemove = updated.findIndex(
              m => m.role === 'user' && 
              m.content === pendingMessage.content &&
              m.timestamp === pendingMessage.timestamp
            );
            if (indexToRemove >= 0) {
              updated.splice(indexToRemove, 1);
            }
            return updated;
          });
        }
        return;
      }
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to send message',
        variant: 'destructive',
      });
    },
  });

  // Wave 4 · reload durability. If the user asked a question during enrichment
  // and then reloaded the tab, the in-memory upload-job poll (and its
  // `status === 'completed'` signal) is gone — but the question was persisted
  // to sessionStorage. Restore it and re-fire once the SESSION reports its data
  // is fully materialized. We gate on the session-level marker
  // (enrichmentStatus complete + a materialized data pointer) rather than the
  // early `enrichmentStatus === 'complete'` alone, so we never answer against an
  // unmaterialized table.
  useEffect(() => {
    if (!sessionId) return;
    // Same-page capture already owns the re-fire (the upload poll handles it).
    if (queuedEarlyQuestionRef.current) return;
    const restored = readQueuedQuestion(sessionId);
    if (!restored) return;
    queuedEarlyQuestionRef.current = restored;

    let cancelled = false;
    let ticks = 0;
    let interval: ReturnType<typeof setInterval> | null = null;
    const MAX_TICKS = 150; // ~5 min at 2s — safety cap so we don't poll forever
    const isMaterialized = (s: Record<string, any> | null | undefined) =>
      s?.enrichmentStatus === 'complete' && !!(s?.columnarStoragePath || s?.currentDataBlob);
    const stop = () => {
      cancelled = true;
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    };
    const finish = () => {
      stop();
      queuedEarlyQuestionRef.current = null;
      clearQueuedQuestion(sessionId);
    };
    const poll = async () => {
      if (cancelled || !isMountedRef.current) return;
      ticks += 1;
      try {
        const data = await sessionsApi.getSessionDetails(sessionId);
        const s = ((data as any)?.session ?? data) as Record<string, any>;
        if (s?.enrichmentStatus === 'failed') {
          finish();
          return;
        }
        const ready = isMaterialized(s);
        if (ready || ticks >= MAX_TICKS) {
          const queued = queuedEarlyQuestionRef.current;
          finish();
          if (ready && queued && !chatMutation.isPending) {
            chatMutation.mutate({ message: queued.content, targetTimestamp: queued.timestamp });
          }
        }
      } catch {
        if (ticks >= MAX_TICKS) finish();
      }
    };
    interval = setInterval(() => {
      void poll();
    }, 2000);
    void poll();

    return () => {
      stop();
    };
    // chatMutation.mutate is referentially stable (React Query); keying on
    // sessionId only so we don't restart the poll on every mutation status tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Function to cancel ongoing chat request
  const cancelChatRequest = () => {
    if (abortControllerRef.current) {
      // Get the pending message before aborting
      const pendingMessage = pendingUserMessageRef.current;
      
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
      turnTraceRef.current = { steps: [], workbench: [] };
      hadIntermediateSegmentsRef.current = false;
      setThinkingSteps([]);
      setAgentWorkbenchLive([]);
      setThinkingTargetTimestamp(null);
      setThinkingLiveAnchorTimestamp(null);
      
      // Remove the user message that was added when the request was sent
      // since the request was cancelled and won't be saved
      setMessages((prev) => {
        const updated = [...prev];
        
        if (pendingMessage) {
          // Try to find by exact match (content + timestamp)
          let indexToRemove = updated.findIndex(
            m => m.role === 'user' && 
            m.content === pendingMessage.content &&
            m.timestamp === pendingMessage.timestamp
          );
          
          // If not found by exact match, try to find by content only (in case timestamp doesn't match)
          if (indexToRemove < 0) {
            // Find the last user message that matches the content
            for (let i = updated.length - 1; i >= 0; i--) {
              if (updated[i].role === 'user' && updated[i].content === pendingMessage.content) {
                indexToRemove = i;
                break;
              }
            }
          }
          
          if (indexToRemove >= 0) {
            updated.splice(indexToRemove, 1);
            logger.log('🗑️ Removed cancelled user message:', pendingMessage.content);
          }
        } else {
          // If no pending message tracked, remove the last user message (most recent)
          // This handles the case where stop is clicked very quickly before tracking is set
          for (let i = updated.length - 1; i >= 0; i--) {
            if (updated[i].role === 'user') {
              // Only remove if there's no assistant response after it
              if (i === updated.length - 1 || updated[i + 1].role !== 'assistant') {
                logger.log('🗑️ Removed last user message (no response yet):', updated[i].content);
                updated.splice(i, 1);
              }
              break;
            }
          }
        }
        
        return updated;
      });
      
      pendingUserMessageRef.current = null;

      // Reset mutation state to clear loading state
      chatMutation.reset();
    }
  };

  /**
   * Apply a partial-update to a message's pivotState (pinned / customName)
   * with optimistic local mutation + server PATCH. Used by the sidebar
   * pin and rename affordances. Reverts local state on PATCH failure.
   *
   * Reads the current pivotState from `messagesRef` (kept in sync with the
   * messages array) so concurrent setMessages calls don't fight us.
   */
  const mutateMessagePivotMeta = (
    messageTimestamp: number,
    patch: { pinned?: boolean; customName?: string | undefined }
  ) => {
    if (!sessionId) return;
    const idx = messagesRef.current.findIndex(
      (m) => m.role === 'assistant' && m.timestamp === messageTimestamp
    );
    if (idx < 0) return;
    const current = messagesRef.current[idx];
    const currentPivot = (current as Message & { pivotState?: import('@/shared/schema').PivotState })
      .pivotState;
    if (!currentPivot) return; // legacy message — sidebar already hides icons
    const nextPivot: import('@/shared/schema').PivotState = {
      ...currentPivot,
      ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
      ...('customName' in patch ? { customName: patch.customName } : {}),
    };

    const prevSnapshot = current;
    setMessages((prev) =>
      prev.map((m, i) =>
        i === idx
          ? ({ ...m, pivotState: nextPivot } as Message)
          : m
      )
    );

    void (async () => {
      try {
        await sessionsApi.updateMessagePivotState(
          sessionId,
          messageTimestamp,
          nextPivot
        );
      } catch (e) {
        logger.debug('[useHomeMutations] pivotState pin/rename PATCH failed', e);
        // Revert local state.
        setMessages((prev) =>
          prev.map((m, i) => (i === idx ? prevSnapshot : m))
        );
      }
    })();
  };

  const togglePivotPin = (messageTimestamp: number) => {
    const idx = messagesRef.current.findIndex(
      (m) => m.role === 'assistant' && m.timestamp === messageTimestamp
    );
    if (idx < 0) return;
    const cur = (messagesRef.current[idx] as Message & {
      pivotState?: import('@/shared/schema').PivotState;
    }).pivotState;
    if (!cur) return;
    mutateMessagePivotMeta(messageTimestamp, { pinned: !cur.pinned });
  };

  const renamePivot = (messageTimestamp: number, name: string | null) => {
    // Empty / null clears the override (falls back to auto-name).
    const trimmed = name?.trim() ? name.trim() : undefined;
    mutateMessagePivotMeta(messageTimestamp, { customName: trimmed });
  };

  return {
    uploadMutation,
    snowflakeImportMutation,
    chatMutation,
    cancelChatRequest,
    thinkingSteps,
    agentWorkbenchLive,
    spawnedSubQuestions,
    investigatedSubQuestions,
    thinkingTargetTimestamp,
    thinkingLiveAnchorTimestamp,
    // W38 · accumulating live narrator preview text. Empty when streaming
    // is disabled or no chunks have arrived yet.
    streamingNarratorPreview,
    togglePivotPin,
    renamePivot,
  };
};
