import type { ChatDocument } from '../models/chat.model.js';
import {
  ChartSpec,
  Insight,
  DataSummary,
  Message,
  SessionAnalysisContext,
  UserDirective,
} from '../shared/schema.js';
import {
  isAgenticLoopEnabled,
  loadAgentConfigFromEnv,
  buildAgentExecutionContext,
  runAgentTurn,
  type StreamPreAnalysis,
} from './agents/runtime/index.js';
import type { AgentLoopResult } from './agents/runtime/types.js';
import { classifyAnalysisSpec } from './analysisSpecRouter.js';
import { loadEnabledDomainContext } from './domainContext/loadEnabledDomainContext.js';

import { MODEL } from './openai.js';
import { callLlm } from './agents/runtime/callLlm.js';
import { LLM_PURPOSE } from './agents/runtime/llmCallPurpose.js';
import { getBatchInsightTemperature, getInsightModel } from './insightSynthesis/insightModelConfig.js';
import { processChartData } from './chartGenerator.js';
import { optimizeChartData } from './chartDownsampling.js';
import { analyzeCorrelations } from './correlationAnalyzer.js';
import { formatCompactNumber } from './formatCompactNumber.js';
import { generateChartInsights } from './insightGenerator.js';
import { parseUserQuery } from './queryParser.js';
import { applyQueryTransformations } from './dataTransform.js';
import type { ParsedQuery } from '../shared/queryTypes.js';
import { mergeDeterministicAnalyticalCharts } from './analyticalChartSpec.js';
import { calculateSmartDomainsForChart } from './axisScaling.js';
import { getInitialAnalysis, type ChartSuggestion } from './dataOps/pythonService.js';
import { logger } from "./logger.js";

/** Context for divide-and-conquer: each AI call knows which segment of the dataset it is analyzing */
export interface DivisionContext {
  partIndex: number;   // 1-based (Part 1 of 3)
  totalParts: number;
  rowStart: number;   // 0-based start index (inclusive)
  rowEnd: number;     // 0-based end index (exclusive)
  totalRows: number;
}



// Helper function to find matching column name (case-insensitive, handles spaces/underscores, partial matching)
function findMatchingColumn(searchName: string, availableColumns: string[]): string | null {
  if (!searchName) return null;
  
  const normalized = searchName.toLowerCase().replace(/[\s_-]/g, '');
  
  // First try exact match
  for (const col of availableColumns) {
    const colNormalized = col.toLowerCase().replace(/[\s_-]/g, '');
    if (colNormalized === normalized) {
      return col;
    }
  }
  
  // Then try prefix match (search term is prefix of column name) - e.g., "PAEC" matches "PAEC nGRP Adstocked"
  for (const col of availableColumns) {
    const colNormalized = col.toLowerCase().replace(/[\s_-]/g, '');
    if (colNormalized.startsWith(normalized) && normalized.length >= 3) {
      return col;
    }
  }
  
  // Then try partial match (search term contained in column name)
  for (const col of availableColumns) {
    const colNormalized = col.toLowerCase().replace(/[\s_-]/g, '');
    if (colNormalized.includes(normalized)) {
      return col;
    }
  }
  
  // Try word-boundary matching (search term matches as a word in column name)
  const searchWords = searchName.toLowerCase().split(/\s+/).filter(w => w.length > 0);
  for (const col of availableColumns) {
    const colLower = col.toLowerCase();
    let allWordsMatch = true;
    for (const word of searchWords) {
      const wordRegex = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (!wordRegex.test(colLower)) {
        allWordsMatch = false;
        break;
      }
    }
    if (allWordsMatch && searchWords.length > 0) {
      return col;
    }
  }
  
  // Finally try reverse partial match (column name contained in search term)
  for (const col of availableColumns) {
    const colNormalized = col.toLowerCase().replace(/[\s_-]/g, '');
    if (normalized.includes(colNormalized)) {
      return col;
    }
  }
  
  return null;
}

export interface AnswerQuestionAgentOptions {
  onAgentEvent?: (event: string, data: unknown) => void;
  streamPreAnalysis?: StreamPreAnalysis;
  username?: string;
  /** For DuckDB rematerialize when temp session DB is missing. */
  chatDocument?: ChatDocument;
  /** For RAG vector filter (session currentDataBlob.version). */
  dataBlobVersion?: number;
  /** Throttled sessionAnalysisContext merge during the turn (e.g. tool milestones). */
  onMidTurnSessionContext?: import('./agents/runtime/types.js').AgentExecutionContext['onMidTurnSessionContext'];
  /** Preliminary analytical table rows (segmented streaming UX). */
  onIntermediateArtifact?: import('./agents/runtime/types.js').AgentExecutionContext['onIntermediateArtifact'];
  /** F3 · Aborted on SSE client disconnect; agent loop short-circuits between steps. */
  abortSignal?: AbortSignal;
  /** Wave W-UD-integration · per-dataset directives hydrated from the
   *  `dataset_directives` Cosmos container at session start. Threaded into
   *  `buildAgentExecutionContext` so every agent role (planner, reflector,
   *  verifier, synthesizer, business-actions) sees the directive block
   *  verbatim via `formatDirectiveBlock`. Omitted / empty array = no
   *  persistent directives apply for this dataset. */
  activeDirectives?: UserDirective[];
  /** Wave W-UD8 · per-turn sink for prompt-budget truncation events.
   *  Forwarded to `AgentExecutionContext.contextTrimmedSink`; the chat
   *  service reads it after the turn ends and emits one consolidated
   *  `context_trimmed` SSE row. */
  contextTrimmedSink?: import("./agents/runtime/promptBudget.js").TrimmedBlockInfo[];
}

export async function answerQuestion(
  data: Record<string, any>[],
  question: string,
  chatHistory: Message[],
  summary: DataSummary,
  sessionId?: string,
  chatInsights?: Insight[],
  onThinkingStep?: (step: { step: string; status: 'pending' | 'active' | 'completed' | 'error'; timestamp: number; details?: string }) => void,
  mode?: 'analysis' | 'dataOps' | 'modeling',
  permanentContext?: string,
  sessionAnalysisContext?: SessionAnalysisContext,
  columnarStoragePath?: boolean,
  loadFullData?: () => Promise<Record<string, any>[]>,
  agentOptions?: AnswerQuestionAgentOptions
): Promise<{
  answer: string;
  charts?: ChartSpec[];
  insights?: Insight[];
  table?: any;
  operationResult?: any;
  agentTrace?: import('./agents/runtime/types.js').AgentTrace;
  agentSuggestionHints?: string[];
  followUpPrompts?: string[];
  lastAnalyticalRowsForEnrichment?: Record<string, unknown>[];
  analysisBrief?: import('../shared/schema.js').AnalysisBrief;
  magnitudes?: import('./agents/runtime/types.js').AnswerMagnitude[];
  unexplained?: string;
  dashboardDraft?: import('../shared/schema.js').DashboardSpec;
  appliedFilters?: Array<{
    column: string;
    // CMP1 · widened to match DimensionFilterOp from queryTypes
    op: 'in' | 'not_in' | 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte' | 'between';
    values: string[];
    match?: 'exact' | 'case_insensitive' | 'contains';
  }>;
  // W13 · compact blackboard digest persisted onto the assistant message
  // for the Investigation summary card.
  investigationSummary?: import('../shared/schema.js').InvestigationSummary;
  // C6 · the reflector's "Investigating further" sub-questions. agentLoop
  // returns these and chatStream persists them, but answerQuestion used to
  // drop them here — so chips were live-SSE-only and vanished on reload.
  // Forwarding closes that persistence gap.
  spawnedQuestions?: import('./agents/runtime/types.js').AgentLoopResult['spawnedQuestions'];
  // AMR3 · raw pivot captures from execute_query_plan steps; the chatStream
  // service materializes (inline-vs-blob policy) and patches them onto the
  // past_analyses doc for cross-session recall.
  pivotArtifacts?: import('./agents/runtime/types.js').AgentLoopResult['pivotArtifacts'];
}> {
  // CRITICAL: This log should ALWAYS appear first
  logger.log('🚀 answerQuestion() CALLED with question:', question);
  logger.log('📋 SessionId:', sessionId);
  logger.log('📊 Data rows:', data?.length);

  if (!isAgenticLoopEnabled()) {
    throw new Error(
      "AGENTIC_LOOP_ENABLED must be true; the legacy orchestrator has been removed."
    );
  }

  {
    try {
      const config = loadAgentConfigFromEnv();
      const analysisSpec = classifyAnalysisSpec(question, summary);
      const { text: domainContext } = await loadEnabledDomainContext();
      const execCtx = buildAgentExecutionContext({
        sessionId: sessionId || 'unknown',
        username: agentOptions?.username,
        question,
        data,
        summary,
        chatHistory,
        chatInsights,
        mode: mode || 'analysis',
        permanentContext,
        domainContext: domainContext || undefined,
        activeDirectives: agentOptions?.activeDirectives,
        contextTrimmedSink: agentOptions?.contextTrimmedSink,
        sessionAnalysisContext,
        columnarStoragePath,
        chatDocument: agentOptions?.chatDocument,
        dataBlobVersion: agentOptions?.dataBlobVersion,
        loadFullData,
        streamPreAnalysis: agentOptions?.streamPreAnalysis,
        analysisSpec,
        onMidTurnSessionContext: agentOptions?.onMidTurnSessionContext,
        onIntermediateArtifact: agentOptions?.onIntermediateArtifact,
        abortSignal: agentOptions?.abortSignal,
      });
      // Single-flow agentic loop is the one and only answer producer
      // (invariant #6). The opt-in deep-investigation re-wiring (Wave W73)
      // was removed: `runDeepInvestigation` was a second, divergent producer
      // gated behind DEEP_INVESTIGATION_ENABLED (default off) that returned a
      // minimal envelope and bypassed this synthesis. The shared
      // `runSubInvestigation` primitive it used lives on for the spawned-
      // question follow-up pass.
      const loopResult: AgentLoopResult = await runAgentTurn(
        execCtx,
        config,
        agentOptions?.onAgentEvent
      );
      const hasContent = loopResult?.answer?.trim()
        || (Array.isArray(loopResult?.table) && loopResult.table.length > 0);
      if (hasContent) {
        logger.log('✅ Agentic loop returned answer');
        return {
          answer: loopResult.answer,
          charts: loopResult.charts,
          insights: loopResult.insights,
          table: loopResult.table,
          operationResult: loopResult.operationResult,
          agentTrace: loopResult.agentTrace,
          agentSuggestionHints: loopResult.agentSuggestionHints,
          ...(loopResult.followUpPrompts?.length ? { followUpPrompts: loopResult.followUpPrompts } : {}),
          ...(loopResult.magnitudes?.length ? { magnitudes: loopResult.magnitudes } : {}),
          ...(loopResult.unexplained ? { unexplained: loopResult.unexplained } : {}),
          ...(loopResult.dashboardDraft ? { dashboardDraft: loopResult.dashboardDraft } : {}),
          lastAnalyticalRowsForEnrichment: loopResult.lastAnalyticalRowsForEnrichment,
          ...(loopResult.analysisBrief ? { analysisBrief: loopResult.analysisBrief } : {}),
          ...(loopResult.appliedFilters?.length ? { appliedFilters: loopResult.appliedFilters } : {}),
          ...(loopResult.investigationSummary ? { investigationSummary: loopResult.investigationSummary } : {}),
          // C6 · forward the spawned "Investigating further" sub-questions so
          // chatStream persists them onto the assistant message (they survive
          // reload instead of being live-SSE-only).
          ...(loopResult.spawnedQuestions?.length ? { spawnedQuestions: loopResult.spawnedQuestions } : {}),
          // Carry through the structured envelope and the post-verifier
          // business-actions promise. Declaring them explicitly here makes
          // the data flow traceable end-to-end (agentLoop → answerQuestion
          // → chatStream).
          ...(loopResult.answerEnvelope
            ? { answerEnvelope: loopResult.answerEnvelope }
            : {}),
          ...(loopResult.businessActionsPromise
            ? { businessActionsPromise: loopResult.businessActionsPromise }
            : {}),
          // AMR3 · pivot captures forwarded for cross-session recall.
          ...(loopResult.pivotArtifacts?.length
            ? { pivotArtifacts: loopResult.pivotArtifacts }
            : {}),
        };
      }
      logger.warn('⚠️ Agentic loop returned empty (no legacy fallback)');
      const trace = loopResult?.agentTrace;
      const pr = trace?.plannerRejectReason;
      let emptyAnswer =
        "I couldn't complete this analysis with the agent. Please try again or rephrase your question.";
      if (pr === "api_error") {
        const detail = (trace?.plannerRejectDetail ?? "").slice(0, 240);
        emptyAnswer = detail
          ? `The LLM provider rejected this request — please check the deployment configuration. Details: ${detail}`
          : "The LLM provider rejected this request. Please check the deployment configuration and try again.";
      } else if (pr === "column_not_in_schema") {
        emptyAnswer =
          "The agent's plan used column names that don't match your dataset. Check spelling against your headers and try again.";
      } else if (pr === "dependency_cycle" || pr === "bad_depends_on") {
        emptyAnswer =
          "The agent could not build a valid step order for this question. Try a simpler question or rephrase.";
      } else if (pr === "invalid_tool_args" || pr === "unknown_tool") {
        emptyAnswer =
          "The agent produced a plan that could not be run. Please try again or narrow your question.";
      } else if (pr === "llm_json_invalid" || pr === "empty_steps") {
        emptyAnswer =
          "The planner could not produce a valid plan for this turn. Please try again.";
      } else if ((trace?.parseFailures ?? 0) > 0 && !pr) {
        emptyAnswer =
          "Some tool steps failed validation during this turn. Check column names and filters, then try again.";
      }
      return {
        answer: emptyAnswer,
        charts: loopResult?.charts,
        insights: loopResult?.insights,
        table: loopResult?.table,
        operationResult: loopResult?.operationResult,
        agentTrace: loopResult?.agentTrace,
        agentSuggestionHints: loopResult?.agentSuggestionHints,
        ...(loopResult?.followUpPrompts?.length ? { followUpPrompts: loopResult.followUpPrompts } : {}),
        lastAnalyticalRowsForEnrichment: loopResult?.lastAnalyticalRowsForEnrichment,
        ...(loopResult?.analysisBrief ? { analysisBrief: loopResult.analysisBrief } : {}),
      };
    } catch (agenticErr) {
      const detail =
        agenticErr instanceof Error ? agenticErr.message : String(agenticErr);
      const safe = detail.length > 200 ? `${detail.slice(0, 200)}…` : detail;
      logger.error('❌ Agentic loop error (no legacy fallback):', agenticErr);
      return {
        answer: `The analysis agent encountered an error (${safe}). Please try again.`,
      };
    }
  }
}

async function generateChartSpecs(summary: DataSummary, useFastModel: boolean = false): Promise<ChartSpec[]> {
  // Use AI generation for all file types
  logger.log('🤖 Using AI to generate charts for all file types...');
  
  const prompt = `Analyze this dataset and generate EXACTLY 4-6 chart specifications. You MUST return multiple charts to provide comprehensive insights.

DATA SUMMARY:
- Rows: ${summary.rowCount}
- Columns: ${summary.columnCount}
- Numeric columns: ${summary.numericColumns.join(', ')}
- Date columns: ${summary.dateColumns.join(', ')}
- All columns: ${summary.columns.map((c) => `${c.name} (${c.type})`).join(', ')}

CRITICAL: You MUST use ONLY the exact column names listed above. Do NOT make up or modify column names.

Generate 4-6 diverse chart specifications that reveal different insights. Each chart should analyze different aspects of the data. Output ONLY a valid JSON array with objects containing:
- type: "line"|"bar"|"scatter"|"pie"|"area"
- title: descriptive title
- x: column name (string, not array) - MUST be from the available columns list
- y: column name (string, not array) - MUST be from the available columns list
- aggregate: "sum"|"mean"|"count"|"none" (use "none" for scatter plots, choose appropriate for others)

IMPORTANT: 
- x and y must be EXACT column names from the available columns list above
- Generate EXACTLY 4-6 charts, not just 1
- Each chart should use different column combinations
- Choose diverse chart types that work well with the data
- Use only the exact column names provided - do not modify them

Chart type preferences:
- Line/area charts for time series (if date columns exist) - use DATE columns on X-axis
- Bar charts for categorical comparisons (top 10) - use CATEGORICAL columns (like Product, Brand, Category) on X-axis, NOT date columns
- Scatter plots for relationships between numeric columns - use NUMERIC columns on both axes
- Pie charts for proportions (top 5) - use CATEGORICAL columns (like Product, Brand, Category, Region) on X-axis, NOT date columns like Month or Date

CRITICAL RULES FOR PIE CHARTS:
- X-axis MUST be a categorical column (Product, Brand, Category, Region, etc.)
- NEVER use date columns (Month, Date, Week, Year) as X-axis for pie charts
- Y-axis should be a numeric column (sum, mean, count)
- Example: "Product" (x-axis) vs "Revenue" (y-axis) = pie chart showing revenue by product

Output format: [{"type": "...", "title": "...", "x": "...", "y": "...", "aggregate": "..."}, ...]`;

  // OPTIMIZATION: Use faster model for large files (2-3x faster, much cheaper)
  const aiModel = useFastModel ? 'gpt-4o-mini' : MODEL;
  
  const response = await callLlm(
    {
      model: aiModel as string,
      messages: [
        {
          role: 'system',
          content: 'You are a data visualization expert. Output only valid JSON array. Column names (x, y) must be strings, not arrays. Always return a complete, valid JSON array of chart specifications.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: 0.7,
      max_tokens: 2000,
    },
    { purpose: LLM_PURPOSE.VISUAL_PLANNER }
  );

  const content = response.choices[0].message.content;
  
  if (!content || content.trim() === '') {
    logger.error('Empty response from OpenAI for chart generation');
    return [];
  }

  logger.log('🤖 AI Response for chart generation:');
  logger.log('Raw content length:', content.length);
  logger.log('First 500 chars:', content.substring(0, 500));

  let parsed;

  try {
    parsed = JSON.parse(content);
    // Handle if the AI wrapped it in an object
    let charts = parsed.charts || parsed.specifications || parsed.data || parsed;
    
    // Ensure we have an array
    if (!Array.isArray(charts)) {
      // Maybe it's a single object? Wrap it
      if (typeof charts === 'object' && charts.type) {
        charts = [charts];
      } else {
        return [];
      }
    }
    
    // Sanitize chart specs to ensure x and y are strings and valid column names
    const availableColumns = summary.columns.map(c => c.name);
    const numericColumns = summary.numericColumns;
    const dateColumns = summary.dateColumns;
    
    // Get categorical columns (non-numeric, non-date)
    const categoricalColumns = availableColumns.filter(
      col => !numericColumns.includes(col) && !dateColumns.includes(col)
    );
    
    const sanitized = charts.slice(0, 6).map((spec: any) => {
      // Extract x and y, handling various formats
      let x = spec.x;
      let y = spec.y;
      
      if (Array.isArray(x)) x = x[0];
      if (Array.isArray(y)) y = y[0];
      if (typeof x === 'object' && x !== null) x = x.name || x.value || String(x);
      if (typeof y === 'object' && y !== null) y = y.name || y.value || String(y);
      
      x = String(x || '');
      y = String(y || '');
      
      // Validate and fix column names with improved matching
      if (!availableColumns.includes(x)) {
        logger.warn(`⚠️ Invalid X column "${x}" not found in data. Available: ${availableColumns.join(', ')}`);
        
        // Try multiple matching strategies
        let similarX = availableColumns.find(col => 
          col.toLowerCase() === x.toLowerCase()
        );
        
        if (!similarX) {
          similarX = availableColumns.find(col => 
            col.toLowerCase().includes(x.toLowerCase()) || 
            x.toLowerCase().includes(col.toLowerCase())
          );
        }
        
        if (!similarX) {
          // Try partial word matching
          const xWords = x.toLowerCase().split(/[\s_-]+/);
          similarX = availableColumns.find(col => {
            const colWords = col.toLowerCase().split(/[\s_-]+/);
            return xWords.some((word: string) => word.length > 2 && colWords.some((cWord: string) => cWord.includes(word) || word.includes(cWord)));
          });
        }
        
        if (!similarX) {
          // Try fuzzy matching for common abbreviations
          const fuzzyMatches = {
            'nGRP': 'GRP',
            'Adstocked': 'Adstock',
            'Reach': 'Reach',
            'TOM': 'TOM',
            'Max': 'Max'
          };
          
          for (const [key, value] of Object.entries(fuzzyMatches)) {
            if (x.includes(key)) {
              similarX = availableColumns.find(col => col.includes(value));
              if (similarX) break;
            }
          }
        }
        
        x = similarX || availableColumns[0];
        logger.log(`   Fixed X column to: "${x}"`);
      }
      
      if (!availableColumns.includes(y)) {
        logger.warn(`⚠️ Invalid Y column "${y}" not found in data. Available: ${availableColumns.join(', ')}`);
        
        // Try multiple matching strategies for Y column
        let similarY = availableColumns.find(col => 
          col.toLowerCase() === y.toLowerCase()
        );
        
        if (!similarY) {
          similarY = availableColumns.find(col => 
            col.toLowerCase().includes(y.toLowerCase()) || 
            y.toLowerCase().includes(col.toLowerCase())
          );
        }
        
        if (!similarY) {
          // Try partial word matching
          const yWords = y.toLowerCase().split(/[\s_-]+/);
          similarY = availableColumns.find(col => {
            const colWords = col.toLowerCase().split(/[\s_-]+/);
            return yWords.some((word: string) => word.length > 2 && colWords.some((cWord: string) => cWord.includes(word) || word.includes(cWord)));
          });
        }
        
        if (!similarY) {
          // Try fuzzy matching for common abbreviations
          const fuzzyMatches = {
            'nGRP': 'GRP',
            'Adstocked': 'Adstock',
            'Reach': 'Reach',
            'TOM': 'TOM',
            'Max': 'Max'
          };
          
          for (const [key, value] of Object.entries(fuzzyMatches)) {
            if (y.includes(key)) {
              similarY = availableColumns.find(col => col.includes(value));
              if (similarY) break;
            }
          }
        }
        
        y = similarY || (numericColumns[0] || availableColumns[1]);
        logger.log(`   Fixed Y column to: "${y}"`);
      }
      
      // For pie charts, ensure X-axis is NOT a date column
      if (spec.type === 'pie' && dateColumns.includes(x)) {
        logger.warn(`⚠️ Pie chart "${spec.title}" incorrectly uses date column "${x}" on X-axis. Finding categorical alternative...`);
        
        // Try to find a categorical column instead
        const alternativeX = categoricalColumns.find(col => 
          col.toLowerCase().includes('product') || 
          col.toLowerCase().includes('brand') || 
          col.toLowerCase().includes('category') ||
          col.toLowerCase().includes('region') ||
          col.toLowerCase().includes('name')
        ) || categoricalColumns[0];
        
        if (alternativeX) {
          logger.log(`   Replacing "${x}" with "${alternativeX}" for pie chart`);
          x = alternativeX;
        } else {
          logger.warn(`   No categorical column found, skipping this pie chart`);
          return null; // Will be filtered out
        }
      }
      
      // Sanitize aggregate field to only allow valid enum values
      let aggregate = spec.aggregate || 'none';
      const validAggregates = ['sum', 'mean', 'count', 'none'];
      if (!validAggregates.includes(aggregate)) {
        logger.warn(`⚠️ Invalid aggregate value "${aggregate}", defaulting to "none"`);
        aggregate = 'none';
      }

      return {
        type: spec.type,
        title: spec.title || 'Untitled Chart',
        x: x,
        y: y,
        aggregate: aggregate,
      };
    }).filter((spec: any) => {
      if (!spec || !spec.type || !spec.x || !spec.y) return false;
      if (!['line', 'bar', 'scatter', 'pie', 'area', 'heatmap'].includes(spec.type)) return false;
      
      // Filter out pie charts with date columns (unless explicitly requested in generateGeneralAnswer)
      // This function is for auto-generated charts, so we don't allow date columns for pie charts here
      if (spec.type === 'pie' && dateColumns.includes(spec.x)) {
        return false;
      }
      
      return true;
    });
    
    logger.log('Generated charts:', sanitized.length);
    logger.log(sanitized);
    return sanitized;
  } catch (error) {
    logger.error('Error parsing chart specs:', error);
    logger.error('Raw AI response (first 500 chars):', content?.substring(0, 500));
    return [];
  }
}

// generateChartInsights is now centralized in insightGenerator.ts
