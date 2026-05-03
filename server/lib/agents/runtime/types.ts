import type { ChatDocument } from "../../../models/chat.model.js";
import type {
  AnalysisBrief,
  ChartSpec,
  DataSummary,
  Insight,
  Message,
  SessionAnalysisContext,
} from "../../../shared/schema.js";
import type { AnalyticalBlackboard } from "./analyticalBlackboard.js";
import type { SpawnedQuestion } from "./investigationTree.js";
import type { InferredFilter } from "../utils/inferFiltersFromQuestion.js";

// WTL1 · trace / workbench caps are now env-overridable so prod can dial
// them down without a redeploy. Defaults bumped (48k → 96k for trace, 48k →
// 80k for workbench, 24k → 40k for per-block code) to give the persisted
// step-by-step debugging surface more room for richer findings. Cosmos
// document soft cap is 1 MB; total here + message metadata stays <300 KB.
const _envInt = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const AGENT_TRACE_MAX_BYTES = _envInt("AGENT_TRACE_MAX_BYTES", 96_000);

/** Total JSON size budget for persisted message.agentWorkbench. */
export const AGENT_WORKBENCH_MAX_BYTES = _envInt(
  "AGENT_WORKBENCH_MAX_BYTES",
  80_000
);

/** Max characters per workbench block code field. */
export const AGENT_WORKBENCH_ENTRY_CODE_MAX = _envInt(
  "AGENT_WORKBENCH_ENTRY_CODE_MAX",
  40_000
);

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
  /** Max planner replans per step (was hardcoded as `replans <= 2`). */
  maxReplansPerStep: number;
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
    maxSteps: num(process.env.AGENT_MAX_STEPS, 30),
    maxWallTimeMs: num(process.env.AGENT_MAX_WALL_MS, 600_000),
    maxToolCalls: num(process.env.AGENT_MAX_TOOL_CALLS, 60),
    maxVerifierRoundsPerStep: num(process.env.AGENT_MAX_VERIFIER_ROUNDS_STEP, 2),
    maxVerifierRoundsFinal: num(process.env.AGENT_MAX_VERIFIER_ROUNDS_FINAL, 2),
    // Default of 2 preserves prior hardcoded behaviour (P-020).
    maxReplansPerStep: num(process.env.AGENT_MAX_REPLANS_PER_STEP, 2),
    maxTotalLlmCallsPerTurn: num(process.env.AGENT_MAX_LLM_CALLS, 100),
    // WTL1 · 200 → 500. FMCG dimensions routinely have 100s of values;
    // 200 was over-aggressive on observation sampling.
    sampleRowsCap: num(process.env.AGENT_SAMPLE_ROWS_CAP, 500),
    // WTL1 · W4 bumped 20k → 24k; we now go 24k → 40k. Claude Opus 4.7
    // has plenty of context headroom and richer growth tables / RAG
    // hits / investigation digests were getting clipped at 24k.
    observationMaxChars: num(process.env.AGENT_OBSERVATION_MAX_CHARS, 40_000),
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
  /**
   * Deterministic pre-planner resolution of user-named segment values to column
   * filters (e.g. "furniture sales by region" → Category=Furniture). Seeded
   * once in `buildAgentExecutionContext` from `DataSummary.topValues` via
   * `inferFiltersFromQuestion`. Surfaced to the planner prompt and the
   * analysis brief; enforced by the verifier's `MISSING_INFERRED_FILTER` rule.
   */
  inferredFilters?: InferredFilter[];
  summary: DataSummary;
  chatHistory: Message[];
  chatInsights?: Insight[];
  mode: "analysis" | "dataOps" | "modeling";
  permanentContext?: string;
  /**
   * WD7 · Composed domain knowledge (Marico/FMCG packs) — emitted into the
   * planner and reflector user-message context. Authored background only;
   * never used as numeric evidence (verifier still demands tool/RAG support
   * for figures).
   */
  domainContext?: string;
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
  /**
   * W-PivotState · pivot/chart UI state of the most recent assistant message.
   * Captured at turn start from `chatHistory` so the planner and synthesizer
   * can see what view the user is currently looking at — useful for follow-up
   * questions like "now break it down by category" where the prior pivot's
   * rows/values define the implicit baseline.
   */
  lastAssistantPivotState?: Message["pivotState"];
  /** Shared evidence store for all agents in this turn / investigation node. */
  blackboard?: AnalyticalBlackboard;
  /** Emit a preliminary table to the chat stream (segmented thinking UX). */
  onIntermediateArtifact?: (payload: {
    preview: Record<string, unknown>[];
    insight?: string;
    /** Matches preview column ids (temporal facets, Sales_sum, etc.) for initial Rows/Values. */
    pivotDefaults?: Message["pivotDefaults"];
    /**
     * Last analytical tool emitted a single-row aggregate with no row dimensions.
     * Receivers must suppress the pivot/chart instead of falling back to schema
     * heuristics (which fabricate Postal-Code-by-week-style nonsense).
     */
    executionScalar?: boolean;
  }) => void;
  /**
   * Aborted when the SSE client disconnects (req.on("close")). The agent loop
   * checks `signal.aborted` between major steps (synthesis, visual planner,
   * narrator, repair) and exits early to avoid burning LLM budget after the
   * user has hung up. Pass-through; tools and LLM calls may also forward this
   * signal to cancel in-flight network requests.
   */
  abortSignal?: AbortSignal;
}

export interface PlanStep {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  /** Optional id of another step in the same plan that must run first (outputs inform this step). */
  dependsOn?: string;
  /** Steps sharing the same parallelGroup (with no dependsOn on each other) execute concurrently. */
  parallelGroup?: string;
  /** O2: ID of the hypothesis (from INVESTIGATION_HYPOTHESES) this step primarily tests. */
  hypothesisId?: string;
  /**
   * Populated by `coalesceQueryPlanSteps` when this step absorbed siblings with
   * the same query shape (groupBy/filters/sort/limit) but different aggregations.
   * The agent loop resolves all listed hypotheses when the merged step succeeds.
   * `hypothesisId` is preserved as the primary; this list always includes it.
   */
  hypothesisIds?: string[];
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

/**
 * Phase-1 rich-envelope extensions — populated by the synthesiser when the
 * user's question has a questionShape (driver_discovery, variance_diagnostic,
 * trend, comparison, exploration). All optional so existing consumers stay
 * valid.
 */
export interface AnswerMagnitude {
  /** What the magnitude measures, e.g. "East tech decline Mar→Apr". */
  label: string;
  /** Human-readable value — allows "-23.4%" or "$1.2M" without a numeric type. */
  value: string;
  /** Optional confidence bucket rendered in the UI as a chip. */
  confidence?: "low" | "medium" | "high";
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
  /** Phase-1 magnitudes backing the main claim (2–4 entries). */
  magnitudes?: AnswerMagnitude[];
  /** Phase-1 concise note on what the tools couldn't determine and why. */
  unexplained?: string;
  /** Phase-2 agent-emitted dashboard draft; rendered as a chat preview card. */
  dashboardDraft?: import("../../../shared/schema.js").DashboardSpec;
  /** Populated blackboard from this turn's investigation (hypotheses + findings). */
  blackboard?: AnalyticalBlackboard;
  /** W8: sub-questions emitted by the reflector when anomalous findings warrant deeper investigation. */
  spawnedQuestions?: SpawnedQuestion[];
  /**
   * W6: filters the agent applied to this turn's analysis (mirrors
   * `ctx.inferredFilters`). Persisted onto the assistant message so the UI
   * can render "Filters: Category = Furniture" chips above the chart cards.
   */
  appliedFilters?: Array<{
    column: string;
    op: "in" | "not_in";
    values: string[];
    match?: "exact" | "case_insensitive" | "contains";
  }>;
  /**
   * W13 · compact digest of `ctx.blackboard` for client rendering. Built by
   * `buildInvestigationSummary` near the end of `runAgentTurn`, persisted
   * onto the assistant message so the UI can render a Hypotheses-tested /
   * Findings / Open-questions card above the step-by-step panel.
   */
  investigationSummary?: import("../../../shared/schema.js").InvestigationSummary;
  /**
   * Wave A1/A2 · full in-memory turn state (workingMemory, reflector + verifier
   * verdicts, full blackboard snapshot, per-step tool I/O). Persisted onto the
   * assistant message so a follow-up turn's `priorTurnState` handle (Wave B9)
   * can read prior structured state instead of TEXT digests, and so crash
   * recovery / debugging can replay the turn losslessly.
   */
  agentInternals?: import("../../../shared/schema.js").AgentInternals;
}
