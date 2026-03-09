/**
 * Chat Stream Service
 * Handles streaming chat operations with SSE
 */
import { Message, ThinkingStep } from "../../shared/schema.js";
import { answerQuestion, analyzeUpload } from "../../lib/dataAnalyzer.js";
import { generateAISuggestions } from "../../lib/suggestionGenerator.js";
import { 
  getChatBySessionIdForUser, 
  addMessagesBySessionId, 
  updateMessageAndTruncate,
  getChatBySessionIdEfficient,
  ChatDocument 
} from "../../models/chat.model.js";
import { loadChartsFromBlob } from "../../lib/blobStorage.js";
import { enrichCharts, validateAndEnrichResponse } from "./chatResponse.service.js";
import { sendSSE, setSSEHeaders } from "../../utils/sse.helper.js";
import { loadLatestData } from "../../utils/dataLoader.js";
import { classifyMode } from "../../lib/agents/modeClassifier.js";
import { getThinkingLabels, streamThinkingIntro } from "../../lib/agents/thinkingNarrator.js";
import { analyzeChatWithColumns } from "../../lib/chatAnalyzer.js";
import { processStreamDataOperation } from "../dataOps/dataOpsStream.service.js";
import { Response } from "express";
import { planQueryWithAI, buildDatasetProfile } from "../../lib/queryPlanner.js";
import { executeQueryPlan } from "../../lib/queryExecutor.js";
import { explainQueryResultWithAI, explainQueryResultWithAIStream, buildNumericSummarySentence } from "../../lib/queryExplainer.js";
import type { QueryResult, QueryPlan } from "../../shared/queryTypes.js";
import { interpretBusinessQuestion } from "../semantic/businessInterpreter.js";
import { resolveBusinessMetric } from "../semantic/metricResolver.js";
import { semanticToQueryPlan } from "../queryPlanner/semanticPlanner.js";
import { generateDatasetSemantics } from "../semantic/datasetSemantics.js";
import { matchRelevantColumns } from "../semantic/columnMatcher.js";
import { extractRequiredColumnsWithLLMAssist } from "../../lib/agents/utils/columnExtractor.js";
import { updateChatDocument } from "../../models/chat.model.js";

/** Returns true if the message is a clear request for data summary (same patterns as data-ops summary intent). */
function isDataSummaryRequest(message: string): boolean {
  const lower = (message || '').toLowerCase().trim();
  return (
    lower.includes('data summary') ||
    lower.includes('summary of data') ||
    !!lower.match(/(?:give me|show me|display|view|see)\s+(?:the\s+)?(?:data\s+)?summary/i)
  );
}

/**
 * Returns true if the user is asking for a chart/visualization.
 * When true, we use the legacy path (answerQuestion) so correlation charts, bar plots, etc. are generated.
 */
function wantsChartResponse(message: string, recentMessages: Message[]): boolean {
  const lower = (message || '').toLowerCase().trim();
  const chartKeywords = /\b(chart|plot|graph|visuali(z|s)e|visualization|bar\s*(chart|plot)?|scatter|correlation\s*(chart|plot|graph)?|create\s*(a\s*)?chart|draw\s*(a\s*)?(chart|plot)|show\s*(me\s*)?(a\s*)?chart|trend\s*line|trendline)\b/i;
  if (chartKeywords.test(lower)) {
    return true;
  }
  const shortAffirmative = /^(yes|yeah|yep|sure|ok|okay|please|do it|go ahead|create it|show it|draw it)$/i.test(lower.trim());
  if (shortAffirmative && recentMessages.length > 0) {
    const lastAssistant = [...recentMessages].reverse().find(m => m.role === 'assistant');
    const lastContent = (lastAssistant?.content || '').toLowerCase();
    const assistantOfferedChart = /would you like me to create a chart|create a chart to visualize|chart to visualize|visualize these|create a (bar|scatter|correlation)/i.test(lastContent);
    if (assistantOfferedChart) {
      return true;
    }
  }
  return false;
}

/** Chunk text for simulated streaming (legacy path): small chunks for token-by-token ChatGPT-like appearance. */
function chunkTextForStreaming(text: string, maxChunkLen = 24): string[] {
  if (!text || !text.trim()) return [];
  const words = text.trim().split(/\s+/);
  const chunks: string[] = [];
  let current = '';
  for (const w of words) {
    if (current.length + w.length + 1 <= maxChunkLen) {
      current += (current ? ' ' : '') + w;
    } else {
      if (current) chunks.push(current);
      current = w;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Returns true if the user is clearly asking to create *all* visualizations/charts,
 * e.g. "yes create all the visualizations", "create all charts", etc.
 * We use this to trigger a strong fallback that actually generates charts from the dataset
 * when the agent returns an answer without any chart specs.
 */
function isGlobalVisualizationRequest(message: string): boolean {
  const lower = (message || "").toLowerCase().trim();
  if (!lower) return false;

  // Common patterns we want to catch:
  // - "yes create all the visualization(s)"
  // - "create all the charts"
  // - "create all charts/visualizations"
  // - "generate all visualizations"
  const patterns: RegExp[] = [
    /\b(create|generate|build|make)\s+all\s+(the\s+)?visuali(z|s)ations?\b/i,
    /\b(create|generate|build|make)\s+all\s+(the\s+)?charts?\b/i,
    /\ball\s+the\s+visuali(z|s)ations?\b/i,
    /\ball\s+the\s+charts?\b/i,
  ];

  return patterns.some((re) => re.test(lower));
}

export interface ProcessStreamChatParams {
  sessionId: string;
  message: string;
  targetTimestamp?: number;
  username: string;
  res: Response;
  mode?: 'general' | 'analysis' | 'dataOps' | 'modeling'; // Optional mode override
}

/** Build human-readable execution plan steps from a QueryPlan for SSE execution_plan event. */
function buildExecutionPlanSteps(plan: QueryPlan): string[] {
  const steps: string[] = [];
  if (plan.filters.length > 0) {
    steps.push(
      "Filter: " +
        plan.filters
          .map((f) => `${f.column} ${f.operator} ${f.value ?? ""}`)
          .join(", ")
    );
  }
  if (plan.groupBy.length > 0) {
    steps.push("Group by " + plan.groupBy.join(", "));
  }
  if (plan.aggregations.length > 0) {
    steps.push(
      "Aggregate: " +
        plan.aggregations.map((a) => `${a.type}(${a.column})`).join(", ")
    );
  }
  if (plan.sortBy) {
    steps.push(`Sort by ${plan.sortBy.column} ${plan.sortBy.direction}`);
  }
  if (plan.limit != null && plan.limit > 0) {
    steps.push(`Limit to ${plan.limit} rows`);
  }
  steps.push(`Action: ${plan.action}`);
  return steps.length > 0 ? steps : ["Execute query plan"];
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

    // Fast path: "give me the data summary" and similar → use data-ops flow for a quick response
    // (avoids slow AI mode detection + full analysis when user just wants the summary)
    if (isDataSummaryRequest(message)) {
      console.log('📋 Data summary request detected – using data-ops flow for fast response');
      await processStreamDataOperation({
        sessionId,
        message,
        username,
        res,
        dataOpsMode: true,
      });
      return;
    }

    console.log('✅ Chat document found, preparing analysis context...');
    const datasetProfile = buildDatasetProfile(chatDocument);
    const dataSummary = chatDocument.dataSummary;
    
    // Get chat-level insights
    const chatLevelInsights = chatDocument.insights && Array.isArray(chatDocument.insights) && chatDocument.insights.length > 0
      ? chatDocument.insights
      : undefined;

    // Track thinking steps
    const thinkingSteps: ThinkingStep[] = [];

    // AI-generated thinking labels (no hardcoded step text for known steps)
    let thinkingLabels: Record<string, { label: string; nextStep?: string }> = {};
    try {
      thinkingLabels = await getThinkingLabels(message);
    } catch (e) {
      console.warn("Thinking labels failed, using default step names:", e);
    }
    // Single tokenized thinking stream: intro first, then steps/code/plan as chunks (one UI block)
    await streamThinkingIntro(res, message, checkConnection);

    const sendThinkingChunk = (content: string) => {
      if (content && checkConnection()) sendSSE(res, "thinking_log_chunk", { content });
    };

    // Emit thinking steps (for compatibility) and append to single thinking log stream
    const onThinkingStep = (step: ThinkingStep) => {
      const labelEntry = thinkingLabels[step.step];
      const stepToSend: ThinkingStep = {
        ...step,
        step: labelEntry?.label ?? step.step,
        details:
          step.details != null && step.details !== ""
            ? step.details
            : labelEntry?.nextStep
              ? `Next: ${labelEntry.nextStep}`
              : undefined,
      };
      thinkingSteps.push(stepToSend);
      sendSSE(res, "thinking", stepToSend);
      sendThinkingChunk("\n\n• " + stepToSend.step + (stepToSend.details ? " — " + stepToSend.details : "") + "\n");
    };

    // Check connection before processing
    if (!checkConnection()) {
      return;
    }

    // Semantic column matching (LLM-based) to understand which dataset columns
    // are relevant to the user's question, without relying on regex.
    const availableColumns = chatDocument.dataSummary.columns.map((c) => c.name);
    onThinkingStep({
      step: "Matching dataset columns",
      status: "active",
      timestamp: Date.now(),
    });

    let extractedColumns: string[] = [];
    try {
      const datasetProfile = buildDatasetProfile(chatDocument);
      const datasetSemantics =
        chatDocument.analysisMetadata?.datasetSemantics || null;

      const matchResult = await matchRelevantColumns({
        question: message,
        datasetProfile,
        dataSummary: chatDocument.dataSummary,
        datasetSemantics,
      });
      extractedColumns = matchResult.matchedColumns || [];
      console.log(
        "📋 Matched columns from semantic column matcher:",
        extractedColumns
      );
      if (matchResult.reasoning) {
        console.log("   Column match reasoning:", matchResult.reasoning);
      }
    } catch (columnMatchError) {
      console.error(
        "⚠️ Semantic column matching failed, continuing without matches:",
        columnMatchError
      );
      extractedColumns = [];
    }

    onThinkingStep({
      step: "Matching dataset columns",
      status: "completed",
      timestamp: Date.now(),
      details:
        extractedColumns.length > 0
          ? `Matched: ${extractedColumns.join(", ")}`
          : "No strongly matched columns",
    });

    // Analyze chat message with AI using extracted columns (for logging/context only)
    let chatAnalysis;
    try {
      onThinkingStep({
        step: 'Analyzing user intent',
        status: 'active',
        timestamp: Date.now(),
      });
      
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
      chatAnalysis = {
        intent: 'general',
        analysis: '',
        relevantColumns: extractedColumns,
        userIntent: message,
      };
    }
    
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

    let result: {
      answer: string;
      charts?: any[];
      insights?: any[];
      preview?: any;
      summary?: any;
    } = { answer: "" };
    let didEmitMessageStream = false;
    let didEmitCodeStream = false;

    const useLegacyPathForCharts = detectedMode === 'analysis' && wantsChartResponse(message, processingChatHistory);

    if (detectedMode === 'analysis' && !useLegacyPathForCharts) {
      // New two-stage execution path: semantic business layer → planner → executor → explainer
      // Ensure dataset semantics for semantic layers
      let datasetSemantics = chatDocument.analysisMetadata?.datasetSemantics;
      if (!datasetSemantics) {
        try {
          datasetSemantics = await generateDatasetSemantics(chatDocument);
          chatDocument.analysisMetadata = {
            ...chatDocument.analysisMetadata,
            datasetSemantics,
          };
          await updateChatDocument(chatDocument);
        } catch (semError) {
          console.warn("⚠️ Failed to generate dataset semantics (stream path); continuing without it:", semError);
        }
      }

      // Try semantic business layer first
      let chosenPlan: QueryPlan | null = null;
      try {
        // 1) Interpreting business question
        onThinkingStep({
          step: 'Interpreting business question',
          status: 'active',
          timestamp: Date.now(),
        });

        const semanticIntent = await interpretBusinessQuestion({
          question: message,
          datasetProfile,
          dataSummary,
          datasetSemantics,
        });

        onThinkingStep({
          step: 'Interpreting business question',
          status: 'completed',
          timestamp: Date.now(),
          details: semanticIntent
            ? `Intent: ${semanticIntent.intent}, metric: ${semanticIntent.businessMetric || 'none'}`
            : 'No clear business intent',
        });

        if (semanticIntent && semanticIntent.businessMetric) {
          // 2) Resolving business metric
          onThinkingStep({
            step: 'Resolving business metric',
            status: 'active',
            timestamp: Date.now(),
          });

          const metricDefinition = await resolveBusinessMetric({
            semanticIntent,
            datasetProfile,
            dataSummary,
            datasetSemantics,
          });

          onThinkingStep({
            step: 'Resolving business metric',
            status: 'completed',
            timestamp: Date.now(),
            details: metricDefinition
              ? `Metric type: ${metricDefinition.metricType}`
              : 'No metric definition found',
          });

          // 3) Generating query plan from semantic layers
          if (metricDefinition && metricDefinition.requiredColumns.length > 0) {
            onThinkingStep({
              step: 'Generating query plan',
              status: 'active',
              timestamp: Date.now(),
            });

            const semanticPlan = await semanticToQueryPlan({
              semanticIntent,
              metricDefinition,
              datasetProfile,
            });

            if (semanticPlan) {
              chosenPlan = semanticPlan;
              console.log("🧠 Stream: using semantic QueryPlan for business question.");
            }

            onThinkingStep({
              step: 'Generating query plan',
              status: 'completed',
              timestamp: Date.now(),
              details: chosenPlan
                ? `Action: ${chosenPlan.action}`
                : 'Semantic planner did not return a plan',
            });
          }
        }
      } catch (semError) {
        console.warn("⚠️ Semantic planner failed in stream path; falling back to generic planner:", semError);
      }

      // If semantic planner didn't produce a plan, use existing planner
      if (!chosenPlan) {
        onThinkingStep({
          step: 'Planning query against full dataset',
          status: 'active',
          timestamp: Date.now(),
        });

        const planResult = await planQueryWithAI({
          userQuestion: message,
          chatDocument,
        });

        if (!planResult.queryPlan || planResult.error) {
          console.error('⚠️ Query planner failed, falling back to legacy path:', planResult.error);
          onThinkingStep({
            step: 'Planning query against full dataset',
            status: 'error',
            timestamp: Date.now(),
            details: planResult.error?.message || 'Planner failed, using legacy analysis',
          });

          // Fallback: legacy path using full data
          const latestData = await loadLatestData(chatDocument);
          result = await answerQuestion(
            latestData,
            message,
            processingChatHistory,
            chatDocument.dataSummary,
            sessionId,
            chatLevelInsights,
            onThinkingStep,
            detectedMode
          );
        } else {
          chosenPlan = planResult.queryPlan;
        }
      }

      if (chosenPlan) {
        onThinkingStep({
          step: 'Planning query against full dataset',
          status: 'completed',
          timestamp: Date.now(),
          details: `Action: ${chosenPlan.action}, requiresFullScan: ${chosenPlan.requiresFullScan ? 'yes' : 'no'}`,
        });

        if (checkConnection()) {
          const planSteps = buildExecutionPlanSteps(chosenPlan);
          sendSSE(res, 'execution_plan', { steps: planSteps });
          sendThinkingChunk("\n\n**Execution plan:**\n" + planSteps.map((s) => "- " + s).join("\n") + "\n");
        }

        let lastEmitted = Date.now();
        const silenceThresholdMs = 2000;
        let keepAliveSent = false;
        let keepAliveTimer: NodeJS.Timeout | null = setInterval(() => {
          if (!checkConnection()) {
            if (keepAliveTimer) clearInterval(keepAliveTimer);
            return;
          }
          if (!keepAliveSent && Date.now() - lastEmitted > silenceThresholdMs) {
            sendSSE(res, 'thinking', { step: 'Processing...', status: 'active', timestamp: Date.now() });
            keepAliveSent = true;
            lastEmitted = Date.now();
          }
        }, 800);

        try {
          onThinkingStep({
            step: 'Executing query plan on full dataset',
            status: 'active',
            timestamp: Date.now(),
          });
          lastEmitted = Date.now();

          const execStartMs = Date.now();
          const queryResult: QueryResult = await executeQueryPlan({
            chatDoc: chatDocument,
            queryPlan: chosenPlan,
            onSqlGenerated: (sql) => {
              if (!checkConnection()) return;
              sendSSE(res, 'code_start', { language: 'sql' });
              sendThinkingChunk("\n\n```sql\n");
              lastEmitted = Date.now();
              const lines = sql.split(/\n/);
              for (const line of lines) {
                if (!checkConnection()) return;
                sendSSE(res, 'code_chunk', { content: line + '\n' });
                sendThinkingChunk(line + '\n');
              }
              sendSSE(res, 'code_done', {});
              sendThinkingChunk("```\n");
              didEmitCodeStream = true;
              lastEmitted = Date.now();
            },
          });

          const executionTimeMs = Date.now() - execStartMs;
          lastEmitted = Date.now();
          if (checkConnection()) {
            sendSSE(res, 'execution_metrics', {
              rows_returned: queryResult.meta.rowCount,
              execution_time_ms: executionTimeMs,
              columns_used: queryResult.meta.columns,
            });
            sendThinkingChunk(
              "\n\n**Metrics:** " +
                queryResult.meta.rowCount +
                " rows, " +
                executionTimeMs +
                " ms\n"
            );
          }

          onThinkingStep({
            step: 'Executing query plan on full dataset',
            status: 'completed',
            timestamp: Date.now(),
            details: `Returned ${queryResult.meta.rowCount} rows (${queryResult.meta.columns.join(', ')})`,
          });
          lastEmitted = Date.now();

          // Stream a deterministic numeric summary first so the user always sees the key numbers.
          const numericSummarySentence = buildNumericSummarySentence(message, queryResult);
          if (numericSummarySentence && checkConnection()) {
            sendSSE(res, 'message_chunk', { content: numericSummarySentence + '\n\n' });
          }

          onThinkingStep({
            step: 'Generating explanation from query result',
            status: 'active',
            timestamp: Date.now(),
          });
          lastEmitted = Date.now();

          const explainResult = await explainQueryResultWithAIStream(
            {
              userQuestion: message,
              queryResult,
              datasetProfile,
              dataSummary,
              chatInsights: chatLevelInsights,
            },
            {
              onChunk: (token) => {
                if (checkConnection()) {
                  sendSSE(res, 'message_chunk', { content: token });
                  lastEmitted = Date.now();
                }
              },
              checkConnection,
            }
          );

          if (checkConnection()) {
            sendSSE(res, 'message_done', {});
            didEmitMessageStream = true;
          }
          lastEmitted = Date.now();

          onThinkingStep({
            step: 'Generating explanation from query result',
            status: 'completed',
            timestamp: Date.now(),
          });

          result = {
            answer: explainResult.explanation,
            charts: [],
            insights: explainResult.insights && explainResult.insights.length > 0 ? explainResult.insights : [],
          };
        } catch (execError) {
          console.error('❌ Query execution failed, falling back to legacy path:', execError);
          onThinkingStep({
            step: 'Executing query plan on full dataset',
            status: 'error',
            timestamp: Date.now(),
            details: execError instanceof Error ? execError.message : 'Query execution failed',
          });

          const latestData = await loadLatestData(chatDocument);
          result = await answerQuestion(
            latestData,
            message,
            processingChatHistory,
            chatDocument.dataSummary,
            sessionId,
            chatLevelInsights,
            onThinkingStep,
            detectedMode
          );
        } finally {
          if (keepAliveTimer) {
            clearInterval(keepAliveTimer);
            keepAliveTimer = null;
          }
          // Mark keep-alive "Processing..." as completed so UI doesn't stay in processing state
          onThinkingStep({
            step: 'Processing...',
            status: 'completed',
            timestamp: Date.now(),
            details: 'Done',
          });
        }
      }
    } else {
      // Legacy path: dataOps/modeling modes, or analysis when user asked for charts (correlation, bar plot, or "yes" to chart offer)
      const latestData = await loadLatestData(chatDocument);
      console.log(`✅ Loaded ${latestData.length} rows of data for analysis (legacy path${useLegacyPathForCharts ? ', chart requested' : ''})`);
      
      result = await answerQuestion(
        latestData,
        message,
        processingChatHistory,
        chatDocument.dataSummary,
        sessionId,
        chatLevelInsights,
        onThinkingStep,
        detectedMode
      );
    }

    // Check connection after processing
    if (!checkConnection()) {
      return;
    }

    // If user asked for charts/visualizations but the agent returned none, generate charts
    // from the dataset (same as initial upload analysis) so the UI actually shows visualizations.
    const userAskedForCharts = wantsChartResponse(message, processingChatHistory);
    const hasNoCharts = !result.charts || !Array.isArray(result.charts) || result.charts.length === 0;
    if (hasNoCharts && userAskedForCharts) {
      try {
        console.log(
          "🎨 Chart request with no charts returned – generating charts from dataset (columns:",
          chatDocument.dataSummary?.columns?.map((c) => c.name).join(", ") || "none",
          ")"
        );
        const latestDataForCharts = await loadLatestData(chatDocument);
        if (!latestDataForCharts || latestDataForCharts.length === 0) {
          console.warn("⚠️ No data available for chart fallback – skipping chart generation");
        } else {
          const { charts: fallbackCharts, insights: fallbackInsights } = await analyzeUpload(
            latestDataForCharts,
            chatDocument.dataSummary,
            chatDocument.fileName,
            false
          );

          result = {
            ...result,
            charts: fallbackCharts || [],
            insights:
              (result.insights && result.insights.length > 0)
                ? result.insights
                : (fallbackInsights && fallbackInsights.length > 0
                    ? fallbackInsights
                    : chatLevelInsights || []),
          };
          console.log(
            `🎨 Fallback chart generation created ${fallbackCharts?.length || 0} chart(s) (data rows: ${latestDataForCharts.length})`
          );
        }
      } catch (chartFallbackError) {
        console.error(
          "⚠️ Failed to generate fallback charts:",
          chartFallbackError
        );
      }
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
        transformedResponse.answer
      );
    } catch (error) {
      console.error('Failed to generate suggestions:', error);
    }

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
        },
        {
          role: 'assistant',
          content: transformedResponse.answer,
          charts: transformedResponse.charts || [], // Pass FULL charts with data
          insights: transformedResponse.insights,
          preview: transformedResponse.preview || undefined, // Save preview data for data operations
          summary: transformedResponse.summary || undefined, // Save summary data for data operations
          timestamp: assistantMessageTimestamp,
        },
      ]);
      console.log(`✅ Messages saved to chat: ${chatDocument.id}`);
    } catch (cosmosError) {
      console.error("⚠️ Failed to save messages to CosmosDB:", cosmosError);
    }

    // Check connection before sending response
    if (!checkConnection()) {
      return;
    }

    // Legacy path: optional "analysis code" snippet (also into single thinking stream)
    const legacyChartOrCorrelation = (transformedResponse.charts?.length ?? 0) > 0 || /correlation|chart|plot|visuali(z|s)e|graph/i.test(message);
    if (!didEmitCodeStream && legacyChartOrCorrelation) {
      if (checkConnection()) {
        sendSSE(res, 'code_start', { language: 'python' });
        sendThinkingChunk("\n\n```python\n");
        const codeLines = [
          '# Analysis (correlation / charts)',
          '# Computing correlations and building visualizations',
          'correlations = df.corr()  # correlation matrix',
          '# Charts generated from results',
        ];
        for (const line of codeLines) {
          if (!checkConnection()) break;
          sendSSE(res, 'code_chunk', { content: line + '\n' });
          sendThinkingChunk(line + '\n');
          await new Promise((r) => setTimeout(r, 80));
        }
        if (checkConnection()) {
          sendSSE(res, 'code_done', {});
          sendThinkingChunk("```\n");
        }
      }
    }

    if (checkConnection()) sendSSE(res, "thinking_log_done", {});

    // Legacy path: stream the answer in chunks so the UI shows text appearing like ChatGPT (token-by-token feel)
    if (!didEmitMessageStream && transformedResponse.answer) {
      const chunks = chunkTextForStreaming(transformedResponse.answer);
      const chunkDelayMs = 18;
      for (let i = 0; i < chunks.length; i++) {
        if (!checkConnection()) return;
        const content = i === 0 ? chunks[i] : ' ' + chunks[i];
        if (!sendSSE(res, 'message_chunk', { content })) return;
        if (chunkDelayMs > 0) {
          await new Promise((r) => setTimeout(r, chunkDelayMs));
        }
      }
      if (checkConnection()) {
        sendSSE(res, 'message_done', {});
      }
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
    (req as any).on('close', () => {
      // Connection already closed, just log
      console.log('🚫 Client disconnected from SSE (initial analysis stream)');
    });

    // Handle errors - only log unexpected errors
    (req as any).on('error', (error: any) => {
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

