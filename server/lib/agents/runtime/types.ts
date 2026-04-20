import type { ChatDocument } from "../../../models/chat.model.js";
import type {
  AnalysisBrief,
  ChartSpec,
  DataSummary,
  Insight,
  Message,
  SessionAnalysisContext,
} from "../../../shared/schema.js";

export const AGENT_TRACE_MAX_BYTES = 48_000;

/** Total JSON size budget for persisted message.agentWorkbench (aligned with trace cap). */
export const AGENT_WORKBENCH_MAX_BYTES = 48_000;

/** Max characters per workbench block code field. */
export const AGENT_WORKBENCH_ENTRY_CODE_MAX = 12_000;

/** Payload for throttled Cosmos merges during runAgentTurn (tool + plan milestones). */
export type AgentMidTurnSessionPayload = {
  summary: string;
  phase?: "tool" | "plan" | "plan_replan" | "pre_synthesis" | "post_visual";
  tool?: string;
  ok?: boolean;
  /** Persist even inside the throttle window (used for pre_synthesis checkpoint). */
  bypassThrottle?: boolean;
};

export function isAgenticLoopEnabled(): boolean {
  return process.env.AGENTIC_LOOP_ENABLED === "true";
}

/**
 * @deprecated When AGENTIC_LOOP_ENABLED=true, strict no-legacy behavior is always on; this only reflects env for tests/logging.
 */
export function isAgenticStrictEnabled(): boolean {
  return process.env.AGENTIC_STRICT === "true";
}

/** When true, `runAgentTurn` records structured handoffs in `AgentTrace.interAgentMessages`. */
export function isInterAgentTraceEnabled(): boolean {
  return process.env.AGENT_INTER_AGENT_MESSAGES === "true";
}

/**
 * When true (and inter-agent messages exist), a compact handoff digest is appended to planner
 * and reflector prompts so replans can use prior coordinator decisions. Increases tokens slightly.
 */
export function isInterAgentPromptFeedbackEnabled(): boolean {
  return process.env.AGENT_INTER_AGENT_PROMPT_FEEDBACK === "true";
}

/** Named roles in the coordinator loop (for trace / future multi-agent expansion). */
export type InterAgentRole =
  | "Coordinator"
  | "Planner"
  | "Executor"
  | "Reflector"
  | "Verifier"
  | "Synthesizer"
  | "VisualPlanner";

/** Coordinator-visible message between logical agents (no PII; sizes enforced in append helper). */
export interface InterAgentMessage {
  at: number;
  from: InterAgentRole;
  to: InterAgentRole;
  intent: string;
  artifacts?: string[];
  /** Tool call ids, step ids, or other non-PII refs into the trace. */
  evidenceRefs?: string[];
  blockingQuestions?: string[];
  meta?: Record<string, string>;
}

export interface AgentConfig {
  maxSteps: number;
  maxWallTimeMs: number;
  maxToolCalls: number;
  maxVerifierRoundsPerStep: number;
  maxVerifierRoundsFinal: number;
  maxTotalLlmCallsPerTurn: number;
  sampleRowsCap: number;
  observationMaxChars: number;
}

export function loadAgentConfigFromEnv(): AgentConfig {
  const num = (v: string | undefined, d: number) => {
    const n = v ? parseInt(v, 10) : NaN;
    return Number.isFinite(n) ? n : d;
  };
  return {
    maxSteps: num(process.env.AGENT_MAX_STEPS, 12),
    maxWallTimeMs: num(process.env.AGENT_MAX_WALL_MS, 120_000),
    maxToolCalls: num(process.env.AGENT_MAX_TOOL_CALLS, 20),
    maxVerifierRoundsPerStep: num(process.env.AGENT_MAX_VERIFIER_ROUNDS_STEP, 2),
    maxVerifierRoundsFinal: num(process.env.AGENT_MAX_VERIFIER_ROUNDS_FINAL, 2),
    maxTotalLlmCallsPerTurn: num(process.env.AGENT_MAX_LLM_CALLS, 40),
    sampleRowsCap: num(process.env.AGENT_SAMPLE_ROWS_CAP, 200),
    observationMaxChars: num(process.env.AGENT_OBSERVATION_MAX_CHARS, 8000),
  };
}

export interface StreamPreAnalysis {
  intentLabel: string;
  analysis: string;
  relevantColumns: string[];
  userIntent: string;
  /** Exact schema names for this question — planner must use these in execute_query_plan when listed */
  canonicalColumns?: string[];
  /** Natural phrases → exact header (validated) */
  columnMapping?: Record<string, string>;
}

/** Heuristic diagnostic vs descriptive mode (see analysisSpecRouter.ts). */
export type AnalysisSpecForAgent = import("../../analysisSpecRouter.js").AnalysisSpec;

/** One completed tool call in the turn — fed back into the planner on replan / structured context. */
export interface WorkingMemoryEntry {
  callId: string;
  tool: string;
  ok: boolean;
  summaryPreview: string;
  suggestedColumns?: string[];
  /** Small key/value facts tools attach for chaining (validated downstream only where applicable). */
  slots?: Record<string, string>;
}

/** Last successful analytical tool row frame (execute_query_plan, run_analytical_query, etc.). */
export type LastAnalyticalTable = {
  rows: Record<string, unknown>[];
  columns: string[];
  sourceTool?: string;
};

export interface AgentExecutionContext {
  sessionId: string;
  username?: string;
  question: string;
  data: Record<string, any>[];
  /** Same array reference as the row-level frame at turn start; never reassigned (used for diagnostic slices when ctx.data became aggregates). */
  turnStartDataRef?: Record<string, any>[] | null;
  /** Lightweight mode/outcome hints for planner (heuristic). */
  analysisSpec?: AnalysisSpecForAgent | null;
  /** Structured NL → metrics/dimensions; set by maybeRunAnalysisBrief before planning. */
  analysisBrief?: AnalysisBrief;
  summary: DataSummary;
  chatHistory: Message[];
  chatInsights?: Insight[];
  mode: "analysis" | "dataOps" | "modeling";
  permanentContext?: string;
  /** Rolling LLM JSON context (seed + user + assistant merges). */
  sessionAnalysisContext?: SessionAnalysisContext;
  columnarStoragePath?: boolean;
  /** Full session doc for DuckDB rematerialization when temp columnar DB is cold. */
  chatDocument?: ChatDocument;
  /** Matches indexed vectors after data-ops saves (currentDataBlob.version). */
  dataBlobVersion?: number;
  loadFullData?: () => Promise<Record<string, any>[]>;
  streamPreAnalysis?: StreamPreAnalysis;
  /** Throttled merge of milestones into sessionAnalysisContext (optional). */
  onMidTurnSessionContext?: (payload: AgentMidTurnSessionPayload) => Promise<void>;
  /** Set when analytical tools replace ctx.data; used for chart validation and enrichment fallbacks. */
  lastAnalyticalTable?: LastAnalyticalTable;
  /** Emit a preliminary table to the chat stream (segmented thinking UX). */
  onIntermediateArtifact?: (payload: {
    preview: Record<string, unknown>[];
    insight?: string;
    /** Matches preview column ids (temporal facets, Sales_sum, etc.) for initial Rows/Values. */
    pivotDefaults?: Message["pivotDefaults"];
  }) => void;
}

export interface PlanStep {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  /** Optional id of another step in the same plan that must run first (outputs inform this step). */
  dependsOn?: string;
}

export interface ToolCallRecord {
  id: string;
  name: string;
  argsSummary: string;
  ok: boolean;
  startedAt: number;
  endedAt: number;
  error?: string;
  /** Truncated for trace */
  resultSummary?: string;
}

export interface CriticRoundRecord {
  stepId: string;
  verdict: string;
  issueCodes: string[];
  courseCorrection?: string;
}

export interface AgentTrace {
  turnId: string;
  startedAt: number;
  endedAt: number;
  planRationale?: string;
  steps: PlanStep[];
  toolCalls: ToolCallRecord[];
  criticRounds: CriticRoundRecord[];
  reflectorNotes: string[];
  budgetHits?: string[];
  parseFailures?: number;
  /** Set when runPlanner rejects the plan (for client/debug and optional user hints). */
  plannerRejectReason?: string;
  /** Non-PII planner rejection detail (e.g. tool name, arg key). */
  plannerRejectDetail?: string;
  /**
   * Optional handoff log between Planner / Executor / Reflector / Verifier / Synthesizer.
   * Populated when `AGENT_INTER_AGENT_MESSAGES=true`.
   */
  interAgentMessages?: InterAgentMessage[];
}

export interface AgentState {
  turnId: string;
  startedAt: number;
  plan: PlanStep[];
  planRationale: string;
  stepIndex: number;
  observations: string[];
  toolCallCount: number;
  llmCallCount: number;
  lastToolNumericPayload?: string;
  pendingCharts: ChartSpec[];
  pendingInsights: Insight[];
  trace: AgentTrace;
}

export type VerdictType =
  | "pass"
  | "revise_narrative"
  | "retry_tool"
  | "replan"
  | "ask_user"
  | "abort_partial";

export interface VerifierIssue {
  code: string;
  severity: "low" | "medium" | "high";
  description: string;
  evidenceRefs: string[];
}

export interface VerifierResult {
  verdict: VerdictType;
  scores?: {
    goal_alignment?: number;
    evidence_consistency?: number;
    completeness?: number;
  };
  issues: VerifierIssue[];
  course_correction: VerdictType;
  user_visible_note?: string;
}

export interface AgentLoopResult {
  answer: string;
  charts?: ChartSpec[];
  insights?: Insight[];
  table?: any;
  operationResult?: any;
  agentTrace?: AgentTrace;
  /** Phrases already surfaced in the answer (CTAs, insight) for suggestion de-duplication. */
  agentSuggestionHints?: string[];
  /** Synthesis CTAs; rendered as follow-up chips (not embedded in answer markdown). */
  followUpPrompts?: string[];
  /** Rows from last analytical frame; passed to enrichCharts when chart data was stripped. */
  lastAnalyticalRowsForEnrichment?: Record<string, unknown>[];
  /** Structured brief from maybeRunAnalysisBrief when diagnostic/report intent ran. */
  analysisBrief?: AnalysisBrief;
}
