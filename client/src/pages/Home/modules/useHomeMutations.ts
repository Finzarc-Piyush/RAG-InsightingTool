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
import { useRef, useEffect, useState } from 'react';
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
  setMessages: (messages: Message[] | ((prev: Message[]) => Message[])) => void;
  setSuggestions?: (suggestions: string[]) => void;
  setIsDatasetPreviewLoading?: (v: boolean) => void;
  setIsDatasetEnriching?: (v: boolean) => void;
  setEnrichmentPollSnapshot?: (snapshot: DatasetEnrichmentPollSnapshot | null) => void;
  onUploadProcessingStarted?: () => void;
  onUploadError?: (message?: string) => void;
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
  setMessages,
  setSuggestions,
  setIsDatasetPreviewLoading,
  setIsDatasetEnriching,
  setEnrichmentPollSnapshot,
  onUploadProcessingStarted,
  onUploadError,
}: UseHomeMutationsProps) => {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const userEmail = getUserEmail();
  const abortControllerRef = useRef<AbortController | null>(null);
  const uploadPollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const uploadPollInFlightRef = useRef(false);
  const pendingUserMessageRef = useRef<{ content: string; timestamp: number } | null>(null);
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
  // W12: live sub-questions spawned during deep investigation
  const [spawnedSubQuestions, setSpawnedSubQuestions] = useState<string[]>([]);
  const [thinkingTargetTimestamp, setThinkingTargetTimestamp] = useState<number | null>(null);
  const [thinkingLiveAnchorTimestamp, setThinkingLiveAnchorTimestamp] = useState<number | null>(null);
  const hadIntermediateSegmentsRef = useRef(false);
  
  // Keep messagesRef in sync with messages
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    return () => {
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
    summaryColumns?: Array<{ name: string }>;
    temporalFacetColumns?: TemporalFacetColumnMeta[];
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
    }
    if (payload.temporalFacetColumns !== undefined) {
      setTemporalFacetColumns(payload.temporalFacetColumns);
    }
    if (typeof payload.rowCount === 'number') setTotalRows(payload.rowCount);
    if (typeof payload.columnCount === 'number') setTotalColumns(payload.columnCount);

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
        const st = await getUploadJobStatus(jobId);
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
          toast({
            title: 'Processing failed',
            description: st.error || 'Upload job failed.',
            variant: 'destructive',
          });
          return;
        }

        // previewReady stays true through analyzing/saving/completed (see GET /api/upload/status)
        if (st.previewReady || st.status === 'preview_ready') {
          upsertPreviewSystemMessage();
          const fastPathState = applyPreviewFromStatus(st);
          let hydratedSession: Record<string, any> | null = null;
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
          const stopPreviewLoading =
            rowsNow > 0 || st.enrichmentStatus === 'complete' || st.status === 'completed';
          setIsDatasetPreviewLoading?.(stopPreviewLoading);
          const enriching =
            !st.understandingReady &&
            st.enrichmentStatus === 'pending' ||
            (!st.understandingReady && st.enrichmentStatus === 'in_progress') ||
            (!st.understandingReady && st.enrichmentPhase === 'enriching') ||
            (!st.understandingReady && st.enrichmentPhase === 'waiting');
          setIsDatasetEnriching?.(enriching);
          if (enriching) {
            upsertEnrichmentSystemMessage();
          } else {
            removeEnrichmentSystemMessage();
          }
        }

        if (st.enrichmentStatus === 'complete' || st.status === 'completed') {
          clearUploadPoll();
          setIsDatasetPreviewLoading?.(false);
          setIsDatasetEnriching?.(false);
          removeEnrichmentSystemMessage();
          await hydrateSessionWithRetry(sessionId, { retries: 3, syncMessages: true });
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
        setIsDatasetEnriching?.(false);
        previewStateRef.current = { rows: [], columns: [] };
        setMessages([]);
        upsertPreviewSystemMessage();
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
    setIsDatasetEnriching?.(false);
    previewStateRef.current = { rows: [], columns: [] };
    setMessages([]);
    upsertPreviewSystemMessage();
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
      setThinkingTargetTimestamp(null);
      setThinkingLiveAnchorTimestamp(null);
      
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
      return new Promise<ChatResponse>((resolve, reject) => {
        let responseData: ChatResponse | null = null;
        let pendingCharts: ChatResponse["charts"] | undefined;
        let streamResolved = false;

        streamChatRequest(
          sessionId,
          message,
          {
            onQueued: () => {
              if (streamResolved) return;
              streamResolved = true;
              turnTraceRef.current = { steps: [], workbench: [] };
              hadIntermediateSegmentsRef.current = false;
              setThinkingSteps([]);
              setAgentWorkbenchLive([]);
              setThinkingTargetTimestamp(null);
              setThinkingLiveAnchorTimestamp(null);
              resolve({
                answer: '',
                charts: [],
                insights: [],
                suggestions: [],
                queuedUntilEnrichment: true,
              } as ChatResponse & { queuedUntilEnrichment?: boolean });
            },
            onThinkingStep: (step: ThinkingStep) => {
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
              } else if (event === 'sub_question_spawned') {
                // W12: track spawned sub-questions for ThinkingPanel display
                const questions = (data as { questions?: string[] }).questions;
                if (questions?.length) {
                  setSpawnedSubQuestions((prev) => [...prev, ...questions]);
                }
              }
            },
            onIntermediate: (payload: StreamIntermediatePayload) => {
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
                },
              ]);
            },
            onResponse: (response: ChatResponse) => {
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
                      preview: (response as Message & { preview?: Message['preview'] }).preview,
                      summary: (response as Message & { summary?: Message['summary'] }).summary,
                      pivotDefaults:
                        (response as Message & { pivotDefaults?: Message['pivotDefaults'] })
                          .pivotDefaults,
                      thinkingBefore: (response as Message & { thinkingBefore?: Message['thinkingBefore'] })
                        .thinkingBefore,
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
          abortControllerRef.current.signal,
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
        pendingUserMessageRef.current = null;
        turnTraceRef.current = { steps: [], workbench: [] };
        toast({
          title: 'Message queued',
          description:
            'We are enriching data understanding and preparing suggested analysis questions. Your reply will appear when that finishes.',
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
      
      const assistantMessage: Message & { preview?: any[]; summary?: any[] } = {
        role: 'assistant',
        content: data.answer, // Keep markdown formatting for proper rendering
        charts: data.charts,
        insights: data.insights,
        timestamp: Date.now(),
        preview: (data as any).preview,
        summary: (data as any).summary,
        pivotDefaults: (data as Message & { pivotDefaults?: Message['pivotDefaults'] }).pivotDefaults,
        thinkingBefore: (data as Message & { thinkingBefore?: Message['thinkingBefore'] }).thinkingBefore,
        ...(data.followUpPrompts?.length ? { followUpPrompts: data.followUpPrompts } : {}),
      };
      
      console.log('💬 Adding assistant message to chat:', assistantMessage.content.substring(0, 50));
      console.log('📊 Message includes:', {
        hasCharts: !!assistantMessage.charts?.length,
        hasInsights: !!assistantMessage.insights?.length,
        contentLength: assistantMessage.content?.length || 0
      });
      logger.log('📌 Pivot defaults in stream payload:', {
        hasPivotDefaults: Boolean(
          (data as Message & { pivotDefaults?: Message['pivotDefaults'] }).pivotDefaults
        ),
        pivotDefaults:
          (data as Message & { pivotDefaults?: Message['pivotDefaults'] }).pivotDefaults,
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
            next[aiIdx] = {
              ...next[aiIdx],
              content: data.answer,
              charts: data.charts,
              insights: data.insights,
              preview: (data as any).preview,
              summary: (data as any).summary,
              pivotDefaults:
                (data as Message & { pivotDefaults?: Message['pivotDefaults'] }).pivotDefaults,
              agentTrace: (data as { agentTrace?: Message['agentTrace'] }).agentTrace,
              thinkingBefore: (data as Message & { thinkingBefore?: Message['thinkingBefore'] }).thinkingBefore,
              ...(data.followUpPrompts?.length ? { followUpPrompts: data.followUpPrompts } : {}),
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
            console.log('📋 Total messages now (text-first merge):', withFinalTrace.length);
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
        console.log('📋 Total messages now:', updated.length);
        return updated;
      });

      // Update suggestions if provided
      if (data.suggestions && setSuggestions) {
        setSuggestions(data.suggestions);
      }
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
            console.log('🗑️ Removed cancelled user message:', pendingMessage.content);
          }
        } else {
          // If no pending message tracked, remove the last user message (most recent)
          // This handles the case where stop is clicked very quickly before tracking is set
          for (let i = updated.length - 1; i >= 0; i--) {
            if (updated[i].role === 'user') {
              // Only remove if there's no assistant response after it
              if (i === updated.length - 1 || updated[i + 1].role !== 'assistant') {
                console.log('🗑️ Removed last user message (no response yet):', updated[i].content);
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

  return {
    uploadMutation,
    snowflakeImportMutation,
    chatMutation,
    cancelChatRequest,
    thinkingSteps,
    agentWorkbenchLive,
    spawnedSubQuestions,
    thinkingTargetTimestamp,
    thinkingLiveAnchorTimestamp,
  };
};
