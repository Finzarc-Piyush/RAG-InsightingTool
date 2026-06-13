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

import { logger } from "./logger.js";

/** Context for divide-and-conquer: each AI call knows which segment of the dataset it is analyzing */
export interface DivisionContext {
  partIndex: number;   // 1-based (Part 1 of 3)
  totalParts: number;
  rowStart: number;   // 0-based start index (inclusive)
  rowEnd: number;     // 0-based end index (exclusive)
  totalRows: number;
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
  // Which of those sub-questions the follow-up pass investigated (+ chart count),
  // so the "Investigated" badge survives reload (same persistence gap as above).
  investigatedSubQuestions?: import('./agents/runtime/types.js').AgentLoopResult['investigatedSubQuestions'];
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
          ...(loopResult.investigatedSubQuestions?.length ? { investigatedSubQuestions: loopResult.investigatedSubQuestions } : {}),
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
