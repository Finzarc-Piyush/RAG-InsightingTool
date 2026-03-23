import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AgentWorkbenchEntry,
  Message,
  UploadResponse,
  ChatResponse,
  ThinkingStep,
  TemporalDisplayGrain,
} from '@/shared/schema';
import { uploadFile, streamChatRequest, streamDataOpsChatRequest, DataOpsResponse, snowflakeApi, getUploadJobStatus } from '@/lib/api';
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

interface UseHomeMutationsProps {
  sessionId: string | null;
  messages: Message[];
  mode?: 'general' | 'analysis' | 'dataOps' | 'modeling';
  setSessionId: (id: string | null) => void;
  setFileName: (fileName: string | null) => void;
  setInitialCharts: (charts: UploadResponse['charts']) => void;
  setInitialInsights: (insights: UploadResponse['insights']) => void;
  setSampleRows: (rows: Record<string, any>[]) => void;
  setColumns: (columns: string[]) => void;
  setNumericColumns: (columns: string[]) => void;
  setDateColumns: (columns: string[]) => void;
  setTemporalDisplayGrainsByColumn: (grains: Record<string, TemporalDisplayGrain>) => void;
  setTotalRows: (rows: number) => void;
  setTotalColumns: (columns: number) => void;
  setMessages: (messages: Message[] | ((prev: Message[]) => Message[])) => void;
  setSuggestions?: (suggestions: string[]) => void;
  setIsDatasetPreviewLoading?: (v: boolean) => void;
  setIsDatasetEnriching?: (v: boolean) => void;
}

export const useHomeMutations = ({
  sessionId,
  messages,
  mode = 'general',
  setSessionId,
  setFileName,
  setInitialCharts,
  setInitialInsights,
  setSampleRows,
  setColumns,
  setNumericColumns,
  setDateColumns,
  setTemporalDisplayGrainsByColumn,
  setTotalRows,
  setTotalColumns,
  setMessages,
  setSuggestions,
  setIsDatasetPreviewLoading,
  setIsDatasetEnriching,
}: UseHomeMutationsProps) => {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const userEmail = getUserEmail();
  const abortControllerRef = useRef<AbortController | null>(null);
  const uploadPollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingUserMessageRef = useRef<{ content: string; timestamp: number } | null>(null);
  const messagesRef = useRef<Message[]>(messages);
  /** Survives onDone state clears so onSuccess can attach trace to the user message. */
  const turnTraceRef = useRef<{ steps: ThinkingStep[]; workbench: AgentWorkbenchEntry[] }>({
    steps: [],
    workbench: [],
  });
  const [thinkingSteps, setThinkingSteps] = useState<ThinkingStep[]>([]);
  const [agentWorkbenchLive, setAgentWorkbenchLive] = useState<AgentWorkbenchEntry[]>([]);
  const [thinkingTargetTimestamp, setThinkingTargetTimestamp] = useState<number | null>(null);
  
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
    };
  }, []);

  const clearUploadPoll = () => {
    if (uploadPollIntervalRef.current) {
      clearInterval(uploadPollIntervalRef.current);
      uploadPollIntervalRef.current = null;
    }
  };

  const applySessionHydration = (session: Record<string, any>) => {
    if (!session) return;
    setFileName(session.fileName || null);
    setInitialCharts(session.charts || []);
    setInitialInsights(session.insights || []);
    if (session.dataSummary && session.dataSummary.rowCount > 0) {
      if (session.sampleRows?.length) setSampleRows(session.sampleRows);
      setColumns(session.dataSummary.columns?.map((c: { name: string }) => c.name) || []);
      setNumericColumns(session.dataSummary.numericColumns || []);
      setDateColumns(session.dataSummary.dateColumns || []);
      setTemporalDisplayGrainsByColumn(temporalGrainsFromSummaryColumns(session.dataSummary.columns));
      setTotalRows(session.dataSummary.rowCount);
      setTotalColumns(session.dataSummary.columnCount);
    }
    if (Array.isArray(session.messages)) {
      setMessages(session.messages as Message[]);
    }
  };

  const startUploadJobPolling = (jobId: string, sessionId: string) => {
    clearUploadPoll();
    const tick = async () => {
      try {
        const st = await getUploadJobStatus(jobId);
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
          const sessionData = await sessionsApi.getSessionDetails(sessionId);
          const session = (sessionData.session || sessionData) as Record<string, any>;
          if (session?.dataSummary?.rowCount > 0) {
            applySessionHydration(session);
            setIsDatasetPreviewLoading?.(false);
            const es = session.enrichmentStatus as string | undefined;
            const enriching =
              es === 'pending' ||
              es === 'in_progress' ||
              st.enrichmentPhase === 'enriching' ||
              st.enrichmentPhase === 'waiting';
            setIsDatasetEnriching?.(enriching);
          }
        }

        if (st.enrichmentStatus === 'complete' || st.status === 'completed') {
          clearUploadPoll();
          setIsDatasetPreviewLoading?.(false);
          setIsDatasetEnriching?.(false);
          const sessionData = await sessionsApi.getSessionDetails(sessionId);
          const session = (sessionData.session || sessionData) as Record<string, any>;
          applySessionHydration(session);
        }
      } catch (e) {
        logger.error('Upload job poll error:', e);
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
    mutationFn: async ({ file, fileSize }: { file: File; fileSize: number }) => {
      // Store fileSize in a way we can access it in onSuccess
      (file as any)._fileSize = fileSize;
      return await uploadFile<any>('/api/upload', file);
    },
    onSuccess: async (data, variables) => {
      logger.log("upload response from the backend", data);
      
      // Handle new async format (202 response with jobId and sessionId)
      if (data.jobId && data.sessionId && data.status === 'processing') {
        setSessionId(data.sessionId);
        setIsDatasetPreviewLoading?.(true);
        setIsDatasetEnriching?.(false);
        setMessages([]);
        startUploadJobPolling(data.jobId, data.sessionId);
        toast({
          title: 'Upload Accepted',
          description: 'Your file is being processed.',
        });
      } 
      // Handle old synchronous format (backward compatibility)
      else if (data.sessionId && data.summary) {
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
    setMessages([]);
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
      setThinkingSteps([]);
      setAgentWorkbenchLive([]);
      setThinkingTargetTimestamp(null);
      
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
      } else {
        setThinkingTargetTimestamp(null);
      }
      
      // Backend will fetch last 15 messages from Cosmos DB
      logger.log('📤 Request payload:', {
        sessionId,
        message,
      });
      
      // Route to Data Ops, Modeling, or regular chat based on mode
      if (mode === 'dataOps') {
        return new Promise<ChatResponse>((resolve, reject) => {
          let responseData: DataOpsResponse | null = null;
          
          streamDataOpsChatRequest(
            sessionId,
            message,
            {
              onThinkingStep: (step: ThinkingStep) => {
                logger.log('🧠 Data Ops thinking step received:', step);
                setThinkingSteps((prev) => {
                  const existingIndex = prev.findIndex(s => s.step === step.step);
                  const next =
                    existingIndex >= 0
                      ? (() => {
                          const updated = [...prev];
                          updated[existingIndex] = step;
                          return updated;
                        })()
                      : [...prev, step];
                  turnTraceRef.current = { ...turnTraceRef.current, steps: next };
                  return next;
                });
              },
              onResponse: (response: DataOpsResponse) => {
                logger.log('✅ Data Ops API response received:', response);
                responseData = response;
                // Store preview/summary in a way that can be accessed by MessageBubble
                // We'll add these as custom properties to the response
                (responseData as any).preview = response.preview;
                (responseData as any).summary = response.summary;
              },
              onError: (error: Error) => {
                logger.error('❌ Data Ops API request failed:', error);
                turnTraceRef.current = { steps: [], workbench: [] };
                setThinkingSteps([]);
                setAgentWorkbenchLive([]);
                setThinkingTargetTimestamp(null);
                reject(error);
              },
              onDone: () => {
                logger.log('✅ Data Ops stream completed');
                setThinkingSteps([]);
                setAgentWorkbenchLive([]);
                setThinkingTargetTimestamp(null);
                if (responseData) {
                  // Convert DataOpsResponse to ChatResponse format
                  const chatResponse: ChatResponse & { preview?: any[]; summary?: any[] } = {
                    answer: responseData.answer,
                    charts: [],
                    insights: [],
                    suggestions: [],
                    preview: responseData.preview,
                    summary: responseData.summary,
                  };
                  resolve(chatResponse as ChatResponse);
                } else {
                  reject(new Error('No response received'));
                }
              },
            },
            abortControllerRef.current.signal,
            targetTimestamp,
            true // dataOpsMode flag for backward compatibility
          ).catch((error: any) => {
            if (error?.name === 'AbortError' || abortControllerRef.current?.signal.aborted) {
              logger.log('🚫 Data Ops request was cancelled by user');
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
      } else {
        // For 'general', 'analysis', and 'modeling' modes, use regular chat endpoint
        // Only send mode parameter if it's explicitly set (not 'general')
        // For 'general' (auto-detect), don't send mode to let backend auto-detect
        const modeToSend = mode === 'general' ? undefined : (mode === 'modeling' || mode === 'analysis' ? mode : undefined);
        
        return new Promise<ChatResponse>((resolve, reject) => {
        let responseData: ChatResponse | null = null;
        let streamResolved = false;

        streamChatRequest(
          sessionId,
          message,
          {
            onQueued: () => {
              if (streamResolved) return;
              streamResolved = true;
              turnTraceRef.current = { steps: [], workbench: [] };
              setThinkingSteps([]);
              setAgentWorkbenchLive([]);
              setThinkingTargetTimestamp(null);
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
              if (event !== 'workbench') return;
              const entry = (data as { entry?: AgentWorkbenchEntry }).entry;
              if (!entry) return;
              setAgentWorkbenchLive((prev) => {
                const next = [...prev, entry];
                turnTraceRef.current = { ...turnTraceRef.current, workbench: next };
                return next;
              });
            },
            onResponse: (response: ChatResponse) => {
              logger.log('✅ API response received:', response);
              responseData = response;
            },
            onError: (error: Error) => {
              logger.error('❌ API request failed:', error);
              turnTraceRef.current = { steps: [], workbench: [] };
              setThinkingSteps([]);
              setAgentWorkbenchLive([]);
              setThinkingTargetTimestamp(null);
              reject(error);
            },
            onDone: () => {
              logger.log('✅ Stream completed');
              setThinkingSteps([]);
              setAgentWorkbenchLive([]);
              setThinkingTargetTimestamp(null);
              if (streamResolved) return;
              if (responseData) {
                resolve(responseData);
              } else {
                reject(new Error('No response received'));
              }
            },
          },
          abortControllerRef.current.signal,
          targetTimestamp,
          modeToSend
        ).catch((error: any) => {
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
      }
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
            'We are enriching our understanding of your data. Your reply will appear when that finishes.',
        });
        return;
      }

      const pendingTs = pendingUserMessageRef.current?.timestamp;
      pendingUserMessageRef.current = null;

      if (!data.answer || data.answer.trim().length === 0) {
        logger.error('❌ Empty answer received from server!');
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
      };
      
      console.log('💬 Adding assistant message to chat:', assistantMessage.content.substring(0, 50));
      console.log('📊 Message includes:', {
        hasCharts: !!assistantMessage.charts?.length,
        hasInsights: !!assistantMessage.insights?.length,
        contentLength: assistantMessage.content?.length || 0
      });
      
      const traceSnapshot = turnTraceRef.current;
      turnTraceRef.current = { steps: [], workbench: [] };

      setMessages((prev) => {
        const withTrace =
          pendingTs != null && (traceSnapshot.steps.length > 0 || traceSnapshot.workbench.length > 0)
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
      turnTraceRef.current = { steps: [], workbench: [] };
      setAgentWorkbenchLive([]);

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
      setThinkingSteps([]);
      setAgentWorkbenchLive([]);
      setThinkingTargetTimestamp(null);
      
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
    thinkingTargetTimestamp,
  };
};
