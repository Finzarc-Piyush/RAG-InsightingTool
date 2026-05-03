import type { ChatDocument } from '../models/chat.model.js';
import {
  ChartSpec,
  Insight,
  DataSummary,
  Message,
  SessionAnalysisContext,
} from '../shared/schema.js';
import {
  isAgenticLoopEnabled,
  loadAgentConfigFromEnv,
  buildAgentExecutionContext,
  runAgentTurn,
  type StreamPreAnalysis,
} from './agents/runtime/index.js';
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
import { executeAnalyticalQuery, generateQueryContextForAI, type AnalyticalQueryResult } from './analyticalQueryExecutor.js';
import { mergeDeterministicAnalyticalCharts } from './analyticalChartSpec.js';
import { 
  isAnalyticalQuery,
  isInformationSeekingQuery,
  identifyRelevantColumnsAndFilterData,
  generateExecutionPlan, 
  executePlan, 
  generateExplanation,
  generateQueryPlanOnly
} from './analyticalQueryEngine.js';
import { calculateSmartDomainsForChart } from './axisScaling.js';
import { getInitialAnalysis, type ChartSuggestion } from './dataOps/pythonService.js';

/** Context for divide-and-conquer: each AI call knows which segment of the dataset it is analyzing */
export interface DivisionContext {
  partIndex: number;   // 1-based (Part 1 of 3)
  totalParts: number;
  rowStart: number;   // 0-based start index (inclusive)
  rowEnd: number;     // 0-based end index (exclusive)
  totalRows: number;
}

/** Minimum rows to use split strategy; below this we run a single insights call */
const SPLIT_THRESHOLD = 15000;
/** Use 2 parts for 15k–30k rows, 3 parts for larger */
const SPLIT_2_PARTS_UP_TO = 30000;

/**
 * Split dataset into 2 or 3 pieces for parallel AI analysis.
 * Each piece gets a division context so the AI knows "Part 2 of 3 (rows 20001–40000 of 60000)".
 */
function splitDataForParallelAnalysis(
  data: Record<string, any>[],
  maxParts: 2 | 3
): Array<{ data: Record<string, any>[]; divisionContext: DivisionContext }> {
  const n = data.length;
  const numParts = maxParts;
  const partSize = Math.ceil(n / numParts);
  const result: Array<{ data: Record<string, any>[]; divisionContext: DivisionContext }> = [];
  for (let i = 0; i < numParts; i++) {
    const start = i * partSize;
    const end = Math.min(start + partSize, n);
    if (start >= end) continue;
    result.push({
      data: data.slice(start, end),
      divisionContext: {
        partIndex: i + 1,
        totalParts: numParts,
        rowStart: start,
        rowEnd: end,
        totalRows: n,
      },
    });
  }
  return result;
}

export async function analyzeUpload(
  data: Record<string, any>[],
  summary: DataSummary,
  fileName?: string,
  skipChartInsights: boolean = false
): Promise<{ charts: ChartSpec[]; insights: Insight[] }> {
  // Use AI generation for all file types (Excel and CSV)
  console.log('📊 Using AI chart generation for all file types');

  // OPTIMIZATION: Always use faster model for upload-time analysis to minimize latency.
  // gpt-4o-mini is 2-3x faster and much cheaper while maintaining good quality.
  // If a higher-quality model is desired for interactive questions, that can be
  // handled separately in the question-answering path.
  const useFastModel = true;
  console.log(`⚡ Performance optimization: Using faster AI model (gpt-4o-mini) for upload analysis`);

  // OPTIMIZATION: Divide-and-conquer for large datasets – split into 2–3 pieces, send each to AI with division reference, combine
  const useSplitStrategy = data.length > SPLIT_THRESHOLD;
  const numParts: 2 | 3 = data.length > SPLIT_2_PARTS_UP_TO ? 3 : 2;
  let chartSpecs: ChartSpec[];
  let insights: Insight[];

  if (useSplitStrategy) {
    const splits = splitDataForParallelAnalysis(data, numParts);
    console.log(`📊 Divide-and-conquer: splitting ${data.length} rows into ${splits.length} parts for parallel AI analysis`);
    // Chart specs: single call (summary only, no row data)
    const chartSpecsPromise = generateChartSpecs(summary, useFastModel);
    // Insights: one call per part, each with division context (Part 1 of 3, rows 1–20000 of 60000, etc.)
    const insightsPromises = splits.map(({ data: partData, divisionContext }) =>
      generateInsights(partData, summary, useFastModel, divisionContext)
    );
    const [chartSpecsResult, ...insightArrays] = await Promise.all([
      chartSpecsPromise,
      ...insightsPromises,
    ]);
    chartSpecs = chartSpecsResult;
    // Combine insights from all parts; prefix each with segment reference (Part 1 of 3, rows 1–20000), limit total to 7
    const combined: Insight[] = [];
    splits.forEach(({ divisionContext: ctx }, idx) => {
      const arr = insightArrays[idx] || [];
      const label = `[Part ${ctx.partIndex} of ${ctx.totalParts}, rows ${ctx.rowStart + 1}–${ctx.rowEnd} of ${ctx.totalRows}] `;
      arr.forEach((insight) => {
        combined.push({
          id: combined.length + 1,
          text: label + (insight.text || ''),
        });
      });
    });
    insights = combined.slice(0, 7).map((ins, i) => ({ ...ins, id: i + 1 }));
    console.log(`✅ Combined ${insightArrays.map((a) => a.length).join('+')} insights from ${splits.length} parts → ${insights.length} total`);
  } else {
    // Single path: chart specs and insights in parallel (no split)
    const [chartSpecsResult, insightsResult] = await Promise.all([
      generateChartSpecs(summary, useFastModel),
      generateInsights(data, summary, useFastModel),
    ]);
    chartSpecs = chartSpecsResult;
    insights = insightsResult;
  }


  // OPTIMIZATION: Skip chart insights generation during upload for faster processing
  // Chart insights can be generated lazily when charts are viewed
  if (skipChartInsights) {
    console.log('⚡ Performance mode: Skipping chart insights generation during upload (will be generated on-demand)');
  }

  // Process data for each chart
  const charts = await Promise.all(chartSpecs.map(async (spec) => {
    let processedData = processChartData(data, spec, summary.dateColumns);
    
    // Apply optimization to ensure max points limit (server-side downsampling)
    processedData = optimizeChartData(processedData, spec);
    
    // Calculate smart axis domains based on statistical measures
    const smartDomains = calculateSmartDomainsForChart(
      processedData,
      spec.x,
      spec.y,
      spec.y2 || undefined,
      {
        yOptions: { useIQR: true, paddingPercent: 5, includeOutliers: true },
        y2Options: spec.y2 ? { useIQR: true, paddingPercent: 5, includeOutliers: true } : undefined,
      }
    );
    
    // OPTIMIZATION: Skip chart insights generation during upload for large files
    // This saves significant time (20-30% faster) as each chart insight requires an AI call
    // Insights will be generated lazily when charts are viewed
    let keyInsight: string | undefined;
    if (!skipChartInsights) {
      const chartInsights = await generateChartInsights(spec, processedData, summary);
      keyInsight = chartInsights.keyInsight;
    }
    
    return {
      ...spec,
      xLabel: spec.x,
      yLabel: spec.y,
      data: processedData, // Already optimized/downsampled
      ...smartDomains, // Add smart domains
      keyInsight: keyInsight, // Will be undefined if skipped, generated on-demand later
    };
  }));

  return { charts, insights };
}

/**
 * Python + 1 AI path: Python provides stats and rule-based chart specs; one AI call for insights.
 * Reduces initial analysis time from 3 AI calls to 1.
 */
export async function analyzeUploadWithPython(
  data: Record<string, any>[],
  summary: DataSummary,
  _fileName?: string,
  skipChartInsights: boolean = false
): Promise<{ charts: ChartSpec[]; insights: Insight[] }> {
  const useFastModel = true;
  const availableColumns = summary.columns.map(c => c.name);
  const numericColumns = summary.numericColumns;
  const dateColumns = summary.dateColumns;
  const categoricalColumns = availableColumns.filter(
    col => !numericColumns.includes(col) && !dateColumns.includes(col)
  );

  const py = await getInitialAnalysis(data);
  const chartSuggestions = py.chart_suggestions || [];
  const pySummary = py.summary || [];

  const sanitizeSpec = (spec: ChartSuggestion | Record<string, any>): ChartSpec | null => {
    let x = String(spec.x || '').trim();
    let y = String(spec.y || '').trim();
    if (!x || !y) return null;
    if (!availableColumns.includes(x)) {
      const similar = availableColumns.find(c => c.toLowerCase() === x.toLowerCase())
        || availableColumns.find(c => c.toLowerCase().includes(x.toLowerCase()) || x.toLowerCase().includes(c.toLowerCase()))
        || availableColumns[0];
      x = similar;
    }
    if (!availableColumns.includes(y)) {
      const similar = availableColumns.find(c => c.toLowerCase() === y.toLowerCase())
        || availableColumns.find(c => c.toLowerCase().includes(y.toLowerCase()) || y.toLowerCase().includes(c.toLowerCase()))
        || (numericColumns[0] || availableColumns[1]);
      y = similar;
    }
    if (spec.type === 'pie' && dateColumns.includes(x)) {
      const alt = categoricalColumns[0];
      if (!alt) return null;
      x = alt;
    }
    const aggregate = ['sum', 'mean', 'count', 'none'].includes(spec.aggregate) ? spec.aggregate : 'none';
    const type = ['line', 'bar', 'scatter', 'pie', 'area', 'heatmap'].includes(spec.type) ? spec.type : 'bar';
    if (type === 'pie' && dateColumns.includes(x)) return null;
    return { type, title: spec.title || 'Untitled Chart', x, y, aggregate };
  };

  const chartSpecs: ChartSpec[] = chartSuggestions
    .map(s => sanitizeSpec(s))
    .filter((s): s is ChartSpec => s !== null)
    .slice(0, 6);

  const numericSummaryRows = pySummary.filter((c: { variable?: string; mean?: number | null }) =>
    c.variable != null && numericColumns.includes(c.variable) && c.mean != null
  ).slice(0, 5);

  const statsBlock = numericSummaryRows.map((col: { variable: string; min?: number | null; max?: number | null; mean?: number | null; median?: number | null }) =>
    `${col.variable}: min=${col.min ?? 'N/A'}, max=${col.max ?? 'N/A'}, mean=${col.mean ?? 'N/A'}, median=${col.median ?? 'N/A'}`
  ).join('\n');

  const chartsList = chartSpecs.map(s => `- ${s.type}: "${s.title}" (x=${s.x}, y=${s.y})`).join('\n');

  const insightPrompt = `From the statistics and chart list below, produce 3-5 insights. Each insight should tie specific numbers to business meaning (risk, opportunity, concentration, volatility) and, when appropriate, a measurable next step. Vary wording; avoid repeating the same template. Use only numbers from the data.

DATA SUMMARY:
- ${summary.rowCount} rows, ${summary.columnCount} columns
- Numeric columns: ${summary.numericColumns.join(', ')}
- Date columns: ${summary.dateColumns.join(', ')}

KEY STATISTICS (from data):
${statsBlock}

CHARTS BEING SHOWN (for context):
${chartsList}

Output valid JSON only: {"insights":[{"id":1,"text":"..."}, ...]}. Do not use P75/P90 shorthand—use numeric values from the stats.`;

  const insightResponse = await callLlm(
    {
      model: (useFastModel ? 'gpt-4o-mini' : getInsightModel()) as string,
      messages: [
        {
          role: 'system',
          content:
            'You are a senior business analyst. Output only valid JSON with an "insights" array. Each item: { "id": number, "text": "string" }. Ground every figure in the user statistics. Always abbreviate magnitudes ≥1000 with K / M / B (e.g. 108547 → 109K, 15240 → 15.2K, 1500000 → 1.5M); never emit raw digit strings for thousands or millions.',
        },
        { role: 'user', content: insightPrompt },
      ],
      response_format: { type: 'json_object' as const },
      temperature: getBatchInsightTemperature(),
      max_tokens: 2600,
    },
    { purpose: LLM_PURPOSE.INSIGHT_GEN }
  );

  const insightContent = insightResponse.choices[0]?.message?.content || '{}';
  let insights: Insight[] = [];
  try {
    const parsed = JSON.parse(insightContent);
    const arr = parsed.insights || [];
    insights = arr.slice(0, 7).map((item: { id?: number; text?: string }, i: number) => ({
      id: (item.id ?? i + 1) as number,
      text: item.text || String(item),
    }));
  } catch {
    console.error('Failed to parse insights JSON from AI');
  }

  const charts = await Promise.all(chartSpecs.map(async (spec) => {
    let processedData = processChartData(data, spec, summary.dateColumns);
    processedData = optimizeChartData(processedData, spec);
    const smartDomains = calculateSmartDomainsForChart(
      processedData,
      spec.x,
      spec.y,
      undefined,
      { yOptions: { useIQR: true, paddingPercent: 5, includeOutliers: true }, y2Options: undefined }
    );
    let keyInsight: string | undefined;
    if (!skipChartInsights) {
      const chartInsights = await generateChartInsights(spec, processedData, summary);
      keyInsight = chartInsights.keyInsight;
    }
    return {
      ...spec,
      xLabel: spec.x,
      yLabel: spec.y,
      data: processedData,
      ...smartDomains,
      keyInsight,
    };
  }));

  return { charts, insights };
}

// Helper to clean numeric values (strip %, commas, etc.)
function toNumber(value: any): number {
  if (value === null || value === undefined || value === '') return NaN;
  const cleaned = String(value).replace(/[%,]/g, '').trim();
  return Number(cleaned);
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
    op: 'in' | 'not_in';
    values: string[];
    match?: 'exact' | 'case_insensitive' | 'contains';
  }>;
  // W13 · compact blackboard digest persisted onto the assistant message
  // for the Investigation summary card.
  investigationSummary?: import('../shared/schema.js').InvestigationSummary;
}> {
  // CRITICAL: This log should ALWAYS appear first
  console.log('🚀 answerQuestion() CALLED with question:', question);
  console.log('📋 SessionId:', sessionId);
  console.log('📊 Data rows:', data?.length);

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
      // Single-flow policy: always single-turn agentic. The deep-investigation
      // / coordinator-decompose branch is intentionally not wired here; the
      // underlying capability still lives at runtime/investigationOrchestrator
      // and runtime/coordinatorAgent for future opt-in re-wiring.
      const loopResult = await runAgentTurn(execCtx, config, agentOptions?.onAgentEvent);
      if (loopResult?.answer?.trim()) {
        console.log('✅ Agentic loop returned answer');
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
        };
      }
      console.warn('⚠️ Agentic loop returned empty (no legacy fallback)');
      const trace = loopResult?.agentTrace;
      const pr = trace?.plannerRejectReason;
      let emptyAnswer =
        "I couldn't complete this analysis with the agent. Please try again or rephrase your question.";
      if (pr === "column_not_in_schema") {
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
      console.error('❌ Agentic loop error (no legacy fallback):', agenticErr);
      return {
        answer: `The analysis agent encountered an error (${safe}). Please try again.`,
      };
    }
  }
}

async function generateChartSpecs(summary: DataSummary, useFastModel: boolean = false): Promise<ChartSpec[]> {
  // Use AI generation for all file types
  console.log('🤖 Using AI to generate charts for all file types...');
  
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
    console.error('Empty response from OpenAI for chart generation');
    return [];
  }

  console.log('🤖 AI Response for chart generation:');
  console.log('Raw content length:', content.length);
  console.log('First 500 chars:', content.substring(0, 500));

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
        console.warn(`⚠️ Invalid X column "${x}" not found in data. Available: ${availableColumns.join(', ')}`);
        
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
        console.log(`   Fixed X column to: "${x}"`);
      }
      
      if (!availableColumns.includes(y)) {
        console.warn(`⚠️ Invalid Y column "${y}" not found in data. Available: ${availableColumns.join(', ')}`);
        
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
        console.log(`   Fixed Y column to: "${y}"`);
      }
      
      // For pie charts, ensure X-axis is NOT a date column
      if (spec.type === 'pie' && dateColumns.includes(x)) {
        console.warn(`⚠️ Pie chart "${spec.title}" incorrectly uses date column "${x}" on X-axis. Finding categorical alternative...`);
        
        // Try to find a categorical column instead
        const alternativeX = categoricalColumns.find(col => 
          col.toLowerCase().includes('product') || 
          col.toLowerCase().includes('brand') || 
          col.toLowerCase().includes('category') ||
          col.toLowerCase().includes('region') ||
          col.toLowerCase().includes('name')
        ) || categoricalColumns[0];
        
        if (alternativeX) {
          console.log(`   Replacing "${x}" with "${alternativeX}" for pie chart`);
          x = alternativeX;
        } else {
          console.warn(`   No categorical column found, skipping this pie chart`);
          return null; // Will be filtered out
        }
      }
      
      // Sanitize aggregate field to only allow valid enum values
      let aggregate = spec.aggregate || 'none';
      const validAggregates = ['sum', 'mean', 'count', 'none'];
      if (!validAggregates.includes(aggregate)) {
        console.warn(`⚠️ Invalid aggregate value "${aggregate}", defaulting to "none"`);
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
    
    console.log('Generated charts:', sanitized.length);
    console.log(sanitized);
    return sanitized;
  } catch (error) {
    console.error('Error parsing chart specs:', error);
    console.error('Raw AI response (first 500 chars):', content?.substring(0, 500));
    return [];
  }
}

// generateChartInsights is now centralized in insightGenerator.ts

export async function generateInsights(
  data: Record<string, any>[],
  summary: DataSummary,
  useFastModel: boolean = false,
  divisionContext?: DivisionContext
): Promise<Insight[]> {
  // OPTIMIZATION: Sample data for large files to speed up statistics calculation
  // For files > 50K rows, use systematic sampling to get representative statistics
  const MAX_SAMPLE_SIZE = 50000; // Use max 50K rows for statistics (statistically sufficient)
  const useSampling = data.length > MAX_SAMPLE_SIZE;
  
  let sampleData: Record<string, any>[];
  let samplingRatio = 1.0;
  
  if (useSampling) {
    // Use systematic sampling for better representation across the dataset
    const step = Math.floor(data.length / MAX_SAMPLE_SIZE);
    sampleData = [];
    for (let i = 0; i < data.length && sampleData.length < MAX_SAMPLE_SIZE; i += step) {
      sampleData.push(data[i]);
    }
    samplingRatio = data.length / sampleData.length;
    console.log(`📊 Performance optimization: Sampling ${sampleData.length} rows from ${data.length} total (${(samplingRatio).toFixed(1)}x ratio) for statistics calculation`);
  } else {
    sampleData = data;
  }

  // Calculate comprehensive statistics with percentiles and variability.
  // To keep upload-time analysis fast, only consider the first few key numeric
  // columns rather than all of them.
  const stats: Record<string, any> = {};
  const isPercent: Record<string, boolean> = {};

  const percentile = (arr: number[], p: number): number => {
    if (arr.length === 0) return NaN;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = (sorted.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  };

  const stdDev = (arr: number[]): number => {
    if (arr.length === 0) return 0;
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const variance = arr.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / arr.length;
    return Math.sqrt(variance);
  };

  // Helper to format values per column (adds % when needed)
  const formatValue = (col: string, v: number): string => {
    if (!isFinite(v)) return String(v);
    if (isPercent[col]) {
      // Percentages stay on the original scale; do not abbreviate to K/M/B.
      const abs = Math.abs(v);
      const fmt = abs >= 100 ? v.toFixed(0) : abs >= 10 ? v.toFixed(1) : abs >= 1 ? v.toFixed(2) : v.toFixed(3);
      return `${fmt}%`;
    }
    return formatCompactNumber(v);
  };

  const NUMERIC_COLUMNS_FOR_UPLOAD_STATS = 3;
  for (const col of summary.numericColumns.slice(0, NUMERIC_COLUMNS_FOR_UPLOAD_STATS)) {
    // Detect percentage columns by scanning raw values for '%'
    const rawHasPercent = sampleData
      .slice(0, 200)
      .map(row => row[col])
      .filter(v => v !== null && v !== undefined)
      .some(v => typeof v === 'string' && v.includes('%'));
    isPercent[col] = rawHasPercent;

    // Use sampled data for statistics calculation (much faster for large files)
    const values = sampleData.map((row) => Number(String(row[col]).replace(/[%,,]/g, ''))).filter((v) => !isNaN(v));
    if (values.length > 0) {
      const avg = values.reduce((a, b) => a + b, 0) / values.length;
      const p25 = percentile(values, 0.25);
      const p50 = percentile(values, 0.5);
      const p75 = percentile(values, 0.75);
      const p90 = percentile(values, 0.9);
      const std = stdDev(values);
      const cv = avg !== 0 ? (std / Math.abs(avg)) * 100 : 0;
      
      // Calculate min/max without spread operator to avoid stack overflow on large arrays
      let min = values[0];
      let max = values[0];
      for (let i = 1; i < values.length; i++) {
        if (values[i] < min) min = values[i];
        if (values[i] > max) max = values[i];
      }
      
      // Scale total to full dataset size if we used sampling
      const sampleTotal = values.reduce((a, b) => a + b, 0);
      const scaledTotal = useSampling ? sampleTotal * samplingRatio : sampleTotal;
      
      stats[col] = {
        min: min,
        max: max,
        avg: avg, // Average is the same regardless of sample size
        total: scaledTotal, // Scale total to represent full dataset
        median: p50,
        p25,
        p75,
        p90,
        stdDev: std,
        cv: cv,
        variability: cv > 30 ? 'high' : cv > 15 ? 'moderate' : 'low',
        count: useSampling ? Math.round(values.length * samplingRatio) : values.length, // Scale count to full dataset
      };
    }
  }

  // Calculate top/bottom values for each column
  // For large files, use efficient single-pass algorithm instead of sorting all values
  // This is O(n) instead of O(n log n) and doesn't require loading all values into memory
  const topBottomStats: Record<string, {top: Array<{value: number, row: number}>, bottom: Array<{value: number, row: number}>}> = {};
  for (const col of summary.numericColumns.slice(0, NUMERIC_COLUMNS_FOR_UPLOAD_STATS)) {
    // For large files, use efficient single-pass algorithm to find top/bottom 3
    // This avoids sorting millions of values
    if (data.length > 50000) {
      // Efficient O(n) approach: single pass to find top/bottom 3
      let top3: Array<{value: number, row: number}> = [];
      let bottom3: Array<{value: number, row: number}> = [];
      
      for (let idx = 0; idx < data.length; idx++) {
        const row = data[idx];
        const numValue = Number(String(row[col]).replace(/[%,,]/g, ''));
        if (isNaN(numValue)) continue;
        
        const item = { value: numValue, row: idx };
        
        // Maintain top 3 (sorted descending)
        if (top3.length < 3) {
          top3.push(item);
          top3.sort((a, b) => b.value - a.value);
        } else if (numValue > top3[2].value) {
          top3[2] = item;
          top3.sort((a, b) => b.value - a.value);
        }
        
        // Maintain bottom 3 (sorted ascending)
        if (bottom3.length < 3) {
          bottom3.push(item);
          bottom3.sort((a, b) => a.value - b.value);
        } else if (numValue < bottom3[2].value) {
          bottom3[2] = item;
          bottom3.sort((a, b) => a.value - b.value);
        }
      }
      
      topBottomStats[col] = { top: top3, bottom: bottom3 };
    } else {
      // For smaller files, use the original approach (sorting is fast enough)
      const valuesWithIndex = data
        .map((row, idx) => ({ value: Number(String(row[col]).replace(/[%,,]/g, '')), row: idx }))
        .filter(item => !isNaN(item.value));
      
      if (valuesWithIndex.length > 0) {
        topBottomStats[col] = {
          top: valuesWithIndex.sort((a, b) => b.value - a.value).slice(0, 3),
          bottom: valuesWithIndex.sort((a, b) => a.value - b.value).slice(0, 3),
        };
      }
    }
  }

  const divisionNote = divisionContext
    ? `DIVISION REFERENCE: You are analyzing **Part ${divisionContext.partIndex} of ${divisionContext.totalParts}** of the dataset. This segment contains **rows ${divisionContext.rowStart + 1} to ${divisionContext.rowEnd}** (inclusive) of ${divisionContext.totalRows} total rows. Focus on insights specific to this segment. The statistics below are computed only on this segment.\n\n`
    : '';

  const insightCountInstruction = divisionContext
    ? 'Provide 2-3 insights for **this segment only** (combined later with other segments).'
    : 'Provide 5-7 insights.';
  const prompt = `${divisionNote}You are synthesizing insights from the statistics below. Each insight should combine (1) grounded numbers from the data, (2) what that pattern could mean for a real business (concentration, volatility, upside, risk), and (3) a concrete next step or metric to watch—only when the data supports it. Vary structure: some insights can be short paragraphs; others can use TABLE_V1|{"caption":...,"columns":...,"rows":...} on one line when a table is clearer than prose. Skip trite filler; if a finding is obvious, say so briefly or pick a different angle.

${insightCountInstruction}

DATA SUMMARY:
- ${divisionContext ? `${data.length} rows in this segment` : `${summary.rowCount} rows`}, ${summary.columnCount} columns
- Numeric columns: ${summary.numericColumns.join(', ')}

COMPREHENSIVE STATISTICS:
${Object.entries(stats)
  .map(([col, s]: [string, any]) => {
    const topBottom = topBottomStats[col];
    const topStr = topBottom?.top.map(t => `${formatValue(col, t.value)}`).join(', ') || 'N/A';
    const bottomStr = topBottom?.bottom.map(t => `${formatValue(col, t.value)}`).join(', ') || 'N/A';
    return `${col}:
  - Range: ${formatValue(col, s.min)} to ${formatValue(col, s.max)}
  - Average: ${formatValue(col, s.avg)}
  - Median: ${formatValue(col, s.median)}
  - 25th percentile: ${formatValue(col, s.p25)}, 75th percentile: ${formatValue(col, s.p75)}, 90th percentile: ${formatValue(col, s.p90)}
  - Total: ${formatValue(col, s.total)}
  - Standard Deviation: ${formatValue(col, s.stdDev)}
  - Coefficient of Variation: ${s.cv.toFixed(1)}% (${s.variability} variability)
  - Top 3 values: ${topStr}
  - Bottom 3 values: ${bottomStr}
  - Data points: ${s.count}`;
  })
  .join('\n\n')}

Rules:
- Every numeric claim must match the statistics above. Do not invent columns or rows.
- Never output percentile shorthand like "P75" or "P90"—use the actual numbers from the stats.
- Output valid JSON: { "insights": [ { "text": "..." }, ... ] }`;

  const aiModel = useFastModel ? 'gpt-4o-mini' : getInsightModel();

  const response = await callLlm(
    {
      model: aiModel as string,
      messages: [
        {
          role: 'system',
          content:
            'You are a senior business analyst. Output valid JSON with an "insights" array. Each item: { "text": "string" }. Ground claims in provided statistics; interpret business meaning where justified. Always abbreviate magnitudes ≥1000 with K / M / B (e.g. 108547 → 109K, 15240 → 15.2K, 1500000 → 1.5M); never emit raw digit strings for thousands or millions.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      response_format: { type: 'json_object' },
      temperature: getBatchInsightTemperature(),
      max_tokens: 2800,
    },
    { purpose: LLM_PURPOSE.INSIGHT_GEN }
  );

  const content = response.choices[0].message.content || '{}';

  try {
    const parsed = JSON.parse(content);
    const insightArray = parsed.insights || [];
    
    return insightArray.slice(0, 7).map((item: any, index: number) => ({
      id: index + 1,
      text: item.text || item.insight || String(item),
    }));
  } catch (error) {
    console.error('Error parsing insights:', error);
    return [];
  }
}

