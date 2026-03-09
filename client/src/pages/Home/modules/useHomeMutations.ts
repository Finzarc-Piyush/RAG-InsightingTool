import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Message, UploadResponse, ChatResponse, ThinkingStep } from '@/shared/schema';
import { uploadFile, streamChatRequest, streamDataOpsChatRequest, DataOpsResponse, snowflakeApi } from '@/lib/api';
import type { ExecutionMetrics } from '@/lib/api';
import type { SnowflakeImportResponse } from '@/lib/api/snowflake';
import { sessionsApi } from '@/lib/api/sessions';
import { useToast } from '@/hooks/use-toast';
import { getUserEmail } from '@/utils/userStorage';
import { useRef, useEffect, useState } from 'react';
import { logger } from '@/lib/logger';

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
  setTotalRows: (rows: number) => void;
  setTotalColumns: (columns: number) => void;
  setMessages: (messages: Message[] | ((prev: Message[]) => Message[])) => void;
  setSuggestions?: (suggestions: string[]) => void;
  setIsLargeFileLoading?: (isLoading: boolean) => void;
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
  setTotalRows,
  setTotalColumns,
  setMessages,
  setSuggestions,
  setIsLargeFileLoading,
}: UseHomeMutationsProps) => {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const userEmail = getUserEmail();
  const abortControllerRef = useRef<AbortController | null>(null);
  const pendingUserMessageRef = useRef<{ content: string; timestamp: number } | null>(null);
  const messagesRef = useRef<Message[]>(messages);
  const streamingContentRef = useRef('');
  const [thinkingSteps, setThinkingSteps] = useState<ThinkingStep[]>([]);
  const [thinkingTargetTimestamp, setThinkingTargetTimestamp] = useState<number | null>(null);
  const [streamingMessageContent, setStreamingMessageContent] = useState('');
  const [isStreamingMessage, setIsStreamingMessage] = useState(false);
  const [streamingCode, setStreamingCode] = useState('');
  const [streamingCodeLanguage, setStreamingCodeLanguage] = useState<string | null>(null);
  const [isStreamingCode, setIsStreamingCode] = useState(false);
  const [executionPlan, setExecutionPlan] = useState<{ steps: string[] } | null>(null);
  const [executionMetrics, setExecutionMetrics] = useState<ExecutionMetrics | null>(null);
  const [streamingThinkingLog, setStreamingThinkingLog] = useState('');
  const [isStreamingThinkingLog, setIsStreamingThinkingLog] = useState(false);

  // Keep messagesRef in sync with messages
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

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
        
        // Show loading state for ALL files until initial analysis is received
        if (setIsLargeFileLoading) {
          setIsLargeFileLoading(true);
        }
        setMessages([]); // Clear messages to show loading state
        
        // Fetch session details from placeholder (now it exists!)
        // We only fetch to set metadata, NOT to show the initial message
        // The initial message will come from SSE when processing completes
        try {
          const sessionData = await sessionsApi.getSessionDetails(data.sessionId);
          const session = sessionData.session || sessionData;
          
          if (session) {
            setFileName(session.fileName || null);
            setInitialCharts(session.charts || []);
            setInitialInsights(session.insights || []);
            
            // Only set metadata if full data is available
            if (session.dataSummary && session.dataSummary.rowCount > 0) {
              if (session.sampleRows && session.sampleRows.length > 0) {
                setSampleRows(session.sampleRows);
              }
              setColumns(session.dataSummary.columns?.map((c: any) => c.name) || []);
              setNumericColumns(session.dataSummary.numericColumns || []);
              setDateColumns(session.dataSummary.dateColumns || []);
              setTotalRows(session.dataSummary.rowCount);
              setTotalColumns(session.dataSummary.columnCount);
            }
            // Don't set the initial message here - let SSE handle it to avoid duplicates
          }
        } catch (sessionError) {
          logger.error('Failed to fetch session details:', sessionError);
          // Processing message is already shown above, so user still sees feedback
          // The SSE stream will pick up the final message when processing completes
        }
        
        toast({
          title: 'Upload Accepted',
          description: 'Your file is being processed. Analysis will be available shortly.',
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
          setTotalRows(data.summary.rowCount);
          setTotalColumns(data.summary.columnCount);
        }
        
        const initialMessage: Message = {
          role: 'assistant',
          content: `Hi! 👋 I've just finished analyzing your data. Here's what I found:\n\n📊 Your dataset has ${data.summary.rowCount} rows and ${data.summary.columnCount} columns\n🔢 ${data.summary.numericColumns.length} numeric columns to work with\n📅 ${data.summary.dateColumns.length} date columns for time-based analysis\n\nI've created ${(data.charts || []).length} visualizations and ${(data.insights || []).length} key insights to get you started. Feel free to ask me anything about your data - I'm here to help! What would you like to explore first?`,
          charts: data.charts || [],
          insights: data.insights || [],
          timestamp: Date.now(),
        };
        setMessages([initialMessage]);
        
        if (data.suggestions && data.suggestions.length > 0 && setSuggestions) {
          setSuggestions(data.suggestions);
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
      // Clear large file loading state on error
      if (setIsLargeFileLoading) {
        setIsLargeFileLoading(false);
      }
      toast({
        title: 'Upload Failed',
        description: error instanceof Error ? error.message : 'Failed to upload file',
        variant: 'destructive',
      });
    },
  });

  const applyImportStarted = async (data: { jobId: string; sessionId: string; fileName: string }) => {
    setSessionId(data.sessionId);
    if (setIsLargeFileLoading) setIsLargeFileLoading(true);
    setMessages([]);
    try {
      const sessionData = await sessionsApi.getSessionDetails(data.sessionId);
      const session = sessionData.session || sessionData;
      if (session) {
        setFileName(session.fileName || null);
        setInitialCharts(session.charts || []);
        setInitialInsights(session.insights || []);
        if (session.dataSummary && session.dataSummary.rowCount > 0) {
          if (session.sampleRows?.length) setSampleRows(session.sampleRows);
          setColumns(session.dataSummary.columns?.map((c: any) => c.name) || []);
          setNumericColumns(session.dataSummary.numericColumns || []);
          setDateColumns(session.dataSummary.dateColumns || []);
          setTotalRows(session.dataSummary.rowCount);
          setTotalColumns(session.dataSummary.columnCount);
        }
      }
    } catch (e) {
      logger.error('Failed to fetch session details', e);
    }
    toast({
      title: 'Import Started',
      description: 'Your Snowflake table is being processed. Analysis will be available shortly.',
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
      if (setIsLargeFileLoading) setIsLargeFileLoading(false);
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
      
      // Clear previous thinking steps and streaming state when starting a new message
      setThinkingSteps([]);
      setThinkingTargetTimestamp(null);
      setStreamingMessageContent('');
      setIsStreamingMessage(false);
      setStreamingCode('');
      setStreamingCodeLanguage(null);
      setIsStreamingCode(false);
      setExecutionPlan(null);
      setExecutionMetrics(null);
      setStreamingThinkingLog('');
      setIsStreamingThinkingLog(false);
      streamingContentRef.current = '';

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
          
          const controller = abortControllerRef.current;
          if (!controller) {
            reject(new Error('Request controller not initialized'));
            return;
          }

          streamDataOpsChatRequest(
            sessionId,
            message,
            {
              onThinkingStep: (step: ThinkingStep) => {
                logger.log('🧠 Data Ops thinking step received:', step);
                setThinkingSteps((prev) => {
                  const existingIndex = prev.findIndex(s => s.step === step.step);
                  if (existingIndex >= 0) {
                    const updated = [...prev];
                    updated[existingIndex] = step;
                    return updated;
                  }
                  return [...prev, step];
                });
              },
              onThinkingLogChunk: (payload: { content: string }) => {
                setIsStreamingThinkingLog(true);
                setStreamingThinkingLog(prev => prev + (payload.content ?? ''));
              },
              onThinkingLogDone: () => {
                setIsStreamingThinkingLog(false);
              },
              onResponse: (response: DataOpsResponse) => {
                logger.log('✅ Data Ops API response received:', response);
                responseData = response;
                (responseData as any).preview = response.preview;
                (responseData as any).summary = response.summary;
              },
              onMessageChunk: (payload: { content: string }) => {
                const token = payload.content ?? '';
                streamingContentRef.current += token;
                setStreamingMessageContent((prev) => prev + token);
                setIsStreamingMessage(true);
              },
              onMessageDone: () => {
                setIsStreamingMessage(false);
                setThinkingSteps((prev) =>
                  prev.map((s) => (s.status === 'active' ? { ...s, status: 'completed' as const, timestamp: Date.now() } : s))
                );
              },
              onCodeStart: (p: { language: string }) => {
                setStreamingCodeLanguage(p.language ?? 'sql');
                setIsStreamingCode(true);
                setStreamingCode('');
              },
              onCodeChunk: (p: { content: string }) => setStreamingCode((prev) => prev + (p.content ?? '')),
              onCodeDone: () => setIsStreamingCode(false),
              onExecutionPlan: (p) => setExecutionPlan(p),
              onExecutionMetrics: (p) => setExecutionMetrics(p),
              onError: (error: Error) => {
                logger.error('❌ Data Ops API request failed:', error);
                setThinkingSteps([]);
                setThinkingTargetTimestamp(null);
                setStreamingMessageContent('');
                setIsStreamingMessage(false);
                setStreamingThinkingLog('');
                setIsStreamingThinkingLog(false);
                reject(error);
              },
              onDone: () => {
                logger.log('✅ Data Ops stream completed');
                setThinkingSteps((prev) =>
                  prev.map((s) => (s.status === 'active' ? { ...s, status: 'completed' as const, timestamp: Date.now() } : s))
                );
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
            controller.signal,
            targetTimestamp,
            true // dataOpsMode flag for backward compatibility
          ).catch((error: any) => {
            if (error?.name === 'AbortError' || controller.signal.aborted) {
              logger.log('🚫 Data Ops request was cancelled by user');
              setThinkingSteps([]);
              setThinkingTargetTimestamp(null);
              reject(new Error('Request cancelled'));
            } else {
              setThinkingSteps([]);
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
        
        const controller = abortControllerRef.current;
        if (!controller) {
          reject(new Error('Request controller not initialized'));
          return;
        }

        streamChatRequest(
          sessionId,
          message,
          {
            onThinkingStep: (step: ThinkingStep) => {
              logger.log('🧠 Thinking step received:', step);
              setThinkingSteps((prev) => {
                const existingIndex = prev.findIndex(s => s.step === step.step);
                if (existingIndex >= 0) {
                  const updated = [...prev];
                  updated[existingIndex] = step;
                  return updated;
                }
                return [...prev, step];
              });
            },
            onThinkingLogChunk: (payload: { content: string }) => {
              setIsStreamingThinkingLog(true);
              setStreamingThinkingLog(prev => prev + (payload.content ?? ''));
            },
            onThinkingLogDone: () => {
              setIsStreamingThinkingLog(false);
            },
            onResponse: (response: ChatResponse) => {
              logger.log('✅ API response received:', response);
              responseData = response;
            },
            onMessageChunk: (payload: { content: string }) => {
              const token = payload.content ?? '';
              streamingContentRef.current += token;
              setStreamingMessageContent((prev) => prev + token);
              setIsStreamingMessage(true);
            },
            onMessageDone: () => {
              setIsStreamingMessage(false);
              // Mark any still-active steps (e.g. "Processing...") as completed for smooth UX
              setThinkingSteps((prev) =>
                prev.map((s) => (s.status === 'active' ? { ...s, status: 'completed' as const, timestamp: Date.now() } : s))
              );
            },
            onCodeStart: (payload: { language: string }) => {
              setStreamingCodeLanguage(payload.language ?? 'sql');
              setIsStreamingCode(true);
              setStreamingCode('');
            },
            onCodeChunk: (payload: { content: string }) => {
              setStreamingCode((prev) => prev + (payload.content ?? ''));
            },
            onCodeDone: () => {
              setIsStreamingCode(false);
            },
            onExecutionPlan: (payload: { steps: string[] }) => {
              setExecutionPlan(payload);
            },
            onExecutionMetrics: (payload: ExecutionMetrics) => {
              setExecutionMetrics(payload);
            },
            onError: (error: Error) => {
              logger.error('❌ API request failed:', error);
              setThinkingSteps([]);
              setThinkingTargetTimestamp(null);
              setStreamingMessageContent('');
              setIsStreamingMessage(false);
              setStreamingThinkingLog('');
              setIsStreamingThinkingLog(false);
              setStreamingCode('');
              setIsStreamingCode(false);
              setExecutionPlan(null);
              setExecutionMetrics(null);
              streamingContentRef.current = '';
              reject(error);
            },
            onDone: () => {
              logger.log('✅ Stream completed');
              // Ensure no step stays "active" after stream ends (smooth transition)
              setThinkingSteps((prev) =>
                prev.map((s) => (s.status === 'active' ? { ...s, status: 'completed' as const, timestamp: Date.now() } : s))
              );
              if (responseData) {
                resolve(responseData);
              } else {
                reject(new Error('No response received'));
              }
            },
          },
          controller.signal,
          targetTimestamp,
          modeToSend
        ).catch((error: any) => {
            if (error?.name === 'AbortError' || controller.signal.aborted) {
            logger.log('🚫 Request was cancelled by user');
              setThinkingSteps([]);
              setThinkingTargetTimestamp(null);
            reject(new Error('Request cancelled'));
          } else {
            setThinkingSteps([]);
              setThinkingTargetTimestamp(null);
            reject(error);
          }
        });
      });
      }
    },
    onSuccess: (data, variables) => {
      logger.log('✅ Chat response received:', data);

      pendingUserMessageRef.current = null;

      const contentFromStream = streamingContentRef.current.trim();
      const finalContent = contentFromStream || data.answer || '';
      streamingContentRef.current = '';
      setStreamingMessageContent('');
      setIsStreamingMessage(false);

      if (!finalContent) {
        logger.error('❌ Empty answer received from server!');
        toast({
          title: 'Error',
          description: 'Received empty response from server. Please try again.',
          variant: 'destructive',
        });
        return;
      }

      const rawPreview = (data as any).preview;
      const cappedPreview = Array.isArray(rawPreview) ? rawPreview.slice(0, 50) : undefined;
      const assistantMessage: Message & { preview?: any[]; summary?: any[] } = {
        role: 'assistant',
        content: finalContent,
        charts: data.charts,
        insights: data.insights,
        timestamp: Date.now(),
        thinkingSteps: thinkingSteps && thinkingSteps.length > 0 ? thinkingSteps : undefined,
        preview: cappedPreview,
        summary: (data as any).summary,
      };

      setMessages((prev) => [...prev, assistantMessage]);

      if (data.suggestions && setSuggestions) {
        setSuggestions(data.suggestions);
      }
    },
    onError: (error, variables) => {
      // Clear pending message ref
      const pendingMessage = pendingUserMessageRef.current;
      pendingUserMessageRef.current = null;
      
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
      setThinkingSteps([]);
      setThinkingTargetTimestamp(null);
      setStreamingMessageContent('');
      setIsStreamingMessage(false);
      setStreamingThinkingLog('');
      setIsStreamingThinkingLog(false);
      setStreamingCode('');
      setIsStreamingCode(false);
      streamingContentRef.current = '';

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
    thinkingTargetTimestamp,
    streamingMessageContent,
    isStreamingMessage,
    streamingCode,
    streamingCodeLanguage,
    isStreamingCode,
    executionPlan,
    executionMetrics,
    streamingThinkingLog,
    isStreamingThinkingLog,
  };
};
