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
import { enrichCharts, validateAndEnrichResponse } from "./chatResponse.service.js";
import { sendSSE, setSSEHeaders } from "../../utils/sse.helper.js";
import { resolveAnswerQuestionDataLoad } from "./answerQuestionContext.js";
import { classifyMode } from "../../lib/agents/modeClassifier.js";
import { extractColumnsFromMessage } from "../../lib/columnExtractor.js";
import { analyzeChatWithColumns } from "../../lib/chatAnalyzer.js";
import { isAgenticLoopEnabled } from "../../lib/agents/runtime/types.js";
import { persistMidTurnAssistantSessionContext } from "../../lib/sessionAnalysisContext.js";
import { Response } from "express";
import {
  agentSseEventToWorkbenchEntries,
  appendWorkbenchEntry,
} from "./agentWorkbench.util.js";

export interface ProcessStreamChatParams {
  sessionId: string;
  message: string;
  targetTimestamp?: number;
  username: string;
  res: Response;
  mode?: 'general' | 'analysis' | 'dataOps' | 'modeling'; // Optional mode override
}

/**
 * Process a streaming chat message
 */
export async function processStreamChat(params: ProcessStreamChatParams): Promise<void> {
  const { sessionId, message, targetTimestamp, username, res, mode } = params;

  // Set SSE headers
  setSSEHeaders(res);

  // Track if client disconnected
  let clientDisconnected = false;

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
    console.log('🚫 Client disconnected from chat stream');
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
          message: 'Database connection issue. Please try again in a moment. If the problem persists, check your network connection.' 
        });
        res.end();
        return;
      }
      // Re-throw non-connection errors
      throw dbError;
    }

    if (!chatDocument) {
      sendSSE(res, 'error', { message: 'Session not found. Please upload a file first.' });
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
        message:
          "Data enrichment failed for this session. Please try uploading your file again.",
      });
      res.end();
      return;
    }
    
    // Get chat-level insights
    const chatLevelInsights = chatDocument.insights && Array.isArray(chatDocument.insights) && chatDocument.insights.length > 0
      ? chatDocument.insights
      : undefined;

    // Track thinking steps
    const thinkingSteps: ThinkingStep[] = [];
    const agentWorkbench: AgentWorkbenchEntry[] = [];

    // Create callback to emit thinking steps
    const onThinkingStep = (step: ThinkingStep) => {
      thinkingSteps.push(step);
      sendSSE(res, 'thinking', step);
    };

    // Check connection before processing
    if (!checkConnection()) {
      return;
    }

    // Extract columns from chat message using RegEx (ONLY place RegEx is used for column extraction)
    const availableColumns = chatDocument.dataSummary.columns.map(c => c.name);
    onThinkingStep({
      step: 'Extracting columns from message',
      status: 'active',
      timestamp: Date.now(),
    });

    const extractedColumns = extractColumnsFromMessage(message, availableColumns);
    console.log(`📋 Extracted columns from message using RegEx:`, extractedColumns);

    onThinkingStep({
      step: 'Extracting columns from message',
      status: 'completed',
      timestamp: Date.now(),
      details: extractedColumns.length > 0 
        ? `Found columns: ${extractedColumns.join(', ')}`
        : 'No columns explicitly mentioned',
    });

    // Analyze chat message with AI using extracted columns
    onThinkingStep({
      step: 'Analyzing user intent',
      status: 'active',
      timestamp: Date.now(),
    });

    let chatAnalysis;
    try {
      chatAnalysis = await analyzeChatWithColumns(
        message,
        extractedColumns,
        chatDocument.dataSummary
      );
      console.log(`🤖 AI Analysis Results:`);
      console.log(`   Intent: ${chatAnalysis.intent}`);
      console.log(`   User Intent: ${chatAnalysis.userIntent}`);
      console.log(`   Relevant Columns:`, chatAnalysis.relevantColumns);
      console.log(`   Analysis: ${chatAnalysis.analysis.substring(0, 200)}...`);

      onThinkingStep({
        step: 'Analyzing user intent',
        status: 'completed',
        timestamp: Date.now(),
        details: `Intent: ${chatAnalysis.intent}${chatAnalysis.relevantColumns.length > 0 ? ` | Columns: ${chatAnalysis.relevantColumns.join(', ')}` : ''}`,
      });
    } catch (error) {
      console.error('⚠️ Chat analysis failed:', error);
      onThinkingStep({
        step: 'Analyzing user intent',
        status: 'completed',
        timestamp: Date.now(),
        details: `Using extracted columns: ${extractedColumns.length > 0 ? extractedColumns.join(', ') : 'none'}`,
      });
      // Continue with extracted columns even if AI analysis fails
      chatAnalysis = {
        intent: 'general',
        analysis: '',
        relevantColumns: extractedColumns,
        userIntent: message,
      };
    }

    // Log summary of column extraction and analysis
    console.log(`📊 Column Extraction & Analysis Summary:`);
    console.log(`   RegEx Extracted: ${extractedColumns.length > 0 ? extractedColumns.join(', ') : 'none'}`);
    console.log(`   AI Identified: ${chatAnalysis.relevantColumns.length > 0 ? chatAnalysis.relevantColumns.join(', ') : 'none'}`);
    console.log(`   Final Relevant Columns: ${chatAnalysis.relevantColumns.length > 0 ? chatAnalysis.relevantColumns.join(', ') : 'none'}`);

    // Fetch last 15 messages from Cosmos DB for mode detection
    // For edited messages, use full history from database for mode detection
    // This ensures context-aware mode detection works correctly
    const allMessages = chatDocument.messages || [];
    const modeDetectionChatHistory = targetTimestamp 
      ? allMessages // Use full history from database for edits
      : allMessages.slice(-15); // Use last 15 messages for new messages

    // Determine mode: use provided mode (user override) or auto-detect
    // Treat 'general' the same as no mode (auto-detect)
    const shouldAutoDetect = !mode || mode === 'general';
    let detectedMode: 'analysis' | 'dataOps' | 'modeling' = mode && mode !== 'general' ? mode : 'analysis';
    
    if (shouldAutoDetect) {
      // Auto-detect mode using AI classifier
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
        
        console.log(`🎯 Auto-detected mode: ${detectedMode} (confidence: ${modeClassification.confidence.toFixed(2)})`);
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
    } else {
      console.log(`🎯 Using user-specified mode: ${mode}`);
    }

    // Fetch last 15 messages from Cosmos DB for processing
    // For edited messages, use full history from database for processing
    // This ensures context-aware processing works correctly
    const processingChatHistory = targetTimestamp 
      ? allMessages // Use full history from database for edits
      : allMessages.slice(-15); // Use last 15 messages for new messages

    const { latestData, columnarStoragePathOpt, loadFullDataOpt, permanentContext, sessionAnalysisContext } =
      await resolveAnswerQuestionDataLoad({
        chatDocument,
        message,
        processingChatHistory,
      });

    const agentOptions =
      isAgenticLoopEnabled()
        ? {
            onAgentEvent: (event: string, data: unknown) => {
              if (!checkConnection()) return;
              if (event === "workbench") {
                const payload = data as { entry?: AgentWorkbenchEntry };
                if (payload.entry) {
                  const stored = appendWorkbenchEntry(agentWorkbench, payload.entry);
                  sendSSE(res, "workbench", { entry: stored });
                }
                return;
              }
              sendSSE(res, event, data);
              for (const entry of agentSseEventToWorkbenchEntries(event, data)) {
                const stored = appendWorkbenchEntry(agentWorkbench, entry);
                sendSSE(res, "workbench", { entry: stored });
              }
            },
            streamPreAnalysis: {
              intentLabel: chatAnalysis.intent,
              analysis: chatAnalysis.analysis,
              relevantColumns: chatAnalysis.relevantColumns,
              userIntent: chatAnalysis.userIntent,
            },
            username,
            dataBlobVersion: chatDocument.currentDataBlob?.version,
            onMidTurnSessionContext: async (p) => {
              await persistMidTurnAssistantSessionContext({
                sessionId,
                username,
                summary: p.summary,
                tool: p.tool,
                ok: p.ok,
                phase: p.phase,
              });
            },
          }
        : undefined;

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

    // Enrich charts
    if (result.charts && Array.isArray(result.charts)) {
      result.charts = await enrichCharts(result.charts, chatDocument, chatLevelInsights);
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
      await addMessagesBySessionId(sessionId, [
        {
          role: 'user',
          content: message,
          timestamp: userMessageTimestamp,
          userEmail: userEmail,
          ...(thinkingSteps.length > 0 ? { thinkingSteps: [...thinkingSteps] } : {}),
          ...(agentWorkbench.length > 0 ? { agentWorkbench: [...agentWorkbench] } : {}),
        },
        {
          role: 'assistant',
          content: transformedResponse.answer,
          charts: transformedResponse.charts || [], // Pass FULL charts with data
          insights: transformedResponse.insights,
          preview: transformedResponse.preview || undefined, // Save preview data for data operations
          summary: transformedResponse.summary || undefined, // Save summary data for data operations
          agentTrace: transformedResponse.agentTrace,
          timestamp: assistantMessageTimestamp,
          ...(mergedSuggestedQuestions.length > 0
            ? { suggestedQuestions: mergedSuggestedQuestions }
            : {}),
        },
      ]);
      console.log(`✅ Messages saved to chat: ${chatDocument.id}`);

      try {
        const { persistMergeAssistantSessionContext } = await import(
          "../../lib/sessionAnalysisContext.js"
        );
        await persistMergeAssistantSessionContext({
          sessionId,
          username,
          assistantMessage: transformedResponse.answer,
          agentTrace: transformedResponse.agentTrace,
        });
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

    // Send final response with preview/summary for data operations
    if (!sendSSE(res, 'response', {
      ...transformedResponse,
      suggestions,
    })) {
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
    sendSSE(res, 'error', { message: errorMessage });
    }
    if (!res.writableEnded && !res.destroyed) {
    res.end();
    }
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
        sendSSE(res, 'error', { message: 'Unauthorized to access this session' });
        res.end();
        return;
      }
      
      // Handle CosmosDB connection errors
      const errorMessage = accessError instanceof Error ? accessError.message : String(accessError);
      if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('ETIMEDOUT') || accessError.code === 'ECONNREFUSED') {
        console.error('❌ CosmosDB connection error in streamChatMessages:', errorMessage.substring(0, 100));
        sendSSE(res, 'error', { 
          message: 'Database connection issue. Please try again in a moment.' 
        });
        res.end();
        return;
      }
      
      // Re-throw if it's not an authorization or connection error
      throw accessError;
    }
    
    if (!chatDocument) {
      sendSSE(res, 'error', { message: 'Session not found' });
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
            message: error instanceof Error ? error.message : 'Failed to fetch messages.' 
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

    // Clean up on client disconnect (though connection should already be closed)
    req.on('close', () => {
      // Connection already closed, just log
      console.log('🚫 Client disconnected from SSE (initial analysis stream)');
    });

    // Handle errors - only log unexpected errors
    req.on('error', (error: any) => {
      // ECONNRESET is expected when clients disconnect normally
      if (error.code !== 'ECONNRESET' && error.code !== 'EPIPE' && error.code !== 'ECONNABORTED') {
        console.error('SSE connection error:', error);
      }
    });

  } catch (error) {
    console.error("streamChatMessages error:", error);
    const message = error instanceof Error ? error.message : "Failed to stream chat messages.";
    sendSSE(res, 'error', { message });
    res.end();
  }
}

