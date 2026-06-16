/**
 * ============================================================================
 * types.ts — the shared type vocabulary for the whole agent runtime
 * ============================================================================
 * WHAT THIS FILE DOES
 *   This is the central dictionary of TypeScript types (and a few small config
 *   helpers) that every other file in the agent runtime imports. It defines the
 *   shapes of the objects that flow through the plan/act loop: the per-turn
 *   execution context, a single plan step, a tool-call record, the verifier's
 *   verdict, the final answer object the loop returns, and more. It contains
 *   almost no runtime logic — it is mostly `interface` / `type` declarations
 *   plus a handful of env-reading config functions.
 *
 *   Jargon to know:
 *     - "agent runtime" = the engine in server/lib/agents/runtime/ that plans
 *       steps, calls tools, checks the work, and writes the final answer.
 *     - "trace" / "workbench" = the recorded step-by-step history of a turn,
 *       persisted so the UI can show how the answer was reached.
 *     - "blackboard" = a shared scratchpad of evidence all agents in one turn
 *       read and write (defined elsewhere; referenced here by type).
 *
 * WHY IT MATTERS
 *   Putting the shared types in one file means every module agrees on the same
 *   contract — change a field here and the TypeScript compiler flags every
 *   place that needs updating. The size constants (AGENT_TRACE_MAX_BYTES etc.)
 *   and AgentConfig caps also live here because they bound what gets persisted
 *   to the 1 MB Cosmos document limit; getting them wrong risks dropped data or
 *   oversized writes.
 *
 * KEY PIECES (grouped by family)
 *   - Feature-flag / config readers — isAgenticLoopEnabled, loadAgentConfigFromEnv,
 *     AgentConfig, and the persisted-size byte caps.
 *   - Inter-agent messaging — InterAgentRole, InterAgentMessage (the optional
 *     handoff log between Planner/Executor/Reflector/Verifier/Synthesizer).
 *   - Per-turn context & memory — AgentExecutionContext (the big object threaded
 *     through the loop), WorkingMemoryEntry, LastAnalyticalTable, ExclusionIntent,
 *     IntentEnvelope, StreamPreAnalysis.
 *   - Plan & execution records — PlanStep, ToolCallRecord, CriticRoundRecord,
 *     AgentTrace, AgentState.
 *   - Verifier types — VerdictType, VerifierIssue, VerifierResult.
 *   - Output — AnswerMagnitude and AgentLoopResult (the full result object the
 *     loop hands back to the chat layer).
 *
 * HOW IT CONNECTS
 *   Imported almost everywhere under server/lib/agents/runtime/ (the planner,
 *   the act loop in agentLoop.service.ts, the verifier, context.ts which builds
 *   AgentExecutionContext, and the quick-answer path). Pulls schema types from
 *   shared/schema.js and a few sibling runtime modules (analyticalBlackboard,
 *   investigationTree, inferFiltersFromQuestion).
 */
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

/**
 * NOTE: The env-derived size caps (AGENT_TRACE_MAX_BYTES,
 * AGENT_WORKBENCH_MAX_BYTES, AGENT_WORKBENCH_ENTRY_CODE_MAX), the AgentConfig
 * loader (loadAgentConfigFromEnv), and the feature-flag readers
 * (isAgenticLoopEnabled etc.) live in `./runtimeConfig.js`. They were moved out
 * of this file so it can stay a pure type-only leaf with zero value imports
 * (audit finding ARCH-8). The `AgentConfig` *type* still lives here.
 */

/** Payload for throttled Cosmos merges during runAgentTurn (tool + plan milestones). */
export type AgentMidTurnSessionPayload = {
  summary: string;
  phase?: "tool" | "plan" | "plan_replan" | "pre_synthesis" | "post_visual";
  tool?: string;
  ok?: boolean;
  /** Persist even inside the throttle window (used for pre_synthesis checkpoint). */
  bypassThrottle?: boolean;
};

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
  /** Max planner replans per step. */
  maxReplansPerStep: number;
  maxTotalLlmCallsPerTurn: number;
  sampleRowsCap: number;
  observationMaxChars: number;
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

/** One completed tool call in the turn — fed back into the planner on replan or as structured context. */
export interface WorkingMemoryEntry {
  callId: string;
  tool: string;
  ok: boolean;
  summaryPreview: string;
  suggestedColumns?: string[];
  /** Small key/value facts tools attach for chaining (validated downstream only where applicable). */
  slots?: Record<string, string>;
}

/** One declared "user wants these values OUT of the answer" entry for a single column. */
export interface ExclusionIntent {
  column: string;
  /** Canonical value strings to exclude (case-insensitive compare). */
  values: string[];
  /** Provenance — where this exclusion came from:
   *  - "user-negative": current-question exclusion verb match ("omit X")
   *  - "rollup-peer-mode": declared rollup hierarchy classified as peer-comparison
   *  - "persisted-directive": persistent UserDirective with structured
   *    `op: 'not_in'` on this column — survives across turns.
   */
  source: "user-negative" | "rollup-peer-mode" | "persisted-directive";
}

/** Bundle of all active exclusions for a turn. Read by the chart-intent guard. */
export interface IntentEnvelope {
  exclusions: ExclusionIntent[];
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
   * Wave R2 · set to true by the front-door router (`tryDirectAnswer`) when its
   * LLM triage classifies the question as a simple data lookup (list distinct
   * values / top-N / count / sum / average / latest) regardless of phrasing.
   * Read by `tryQuickAnswer`'s detector gate so the quick-lookup fast path fires
   * even when the brittle `detectQuickLookup` regex doesn't match (e.g. "give me
   * a list of X", "what markets exist?"). Defaults to undefined (regex-only).
   */
  routeToLookup?: boolean;
  /**
   * Question-intent verdict from `queryIntentAuthority.classifyQueryIntent`,
   * computed ONCE per turn near the top of the full agent loop and consulted by
   * every output-shaping gate (extra charts, dashboard offer, spawned
   * follow-ups, envelope recommendations) so a simple question stops
   * auto-padding. `depthBudget` is the consumable summary; `minimal` ⇒ trim the
   * answer to what was asked. Undefined on the fast paths (they return before
   * the heavy enrichment stages that read it). Single source of truth — gates
   * MUST read this, not re-classify the question.
   */
  queryIntent?: import("./queryIntentAuthority.js").QueryIntent;
  depthBudget?: import("./queryIntentAuthority.js").DepthBudget;
  /**
   * Deterministic pre-planner resolution of user-named segment values to column
   * filters (e.g. "furniture sales by region" → Category=Furniture). Seeded
   * once in `buildAgentExecutionContext` from `DataSummary.topValues` via
   * `inferFiltersFromQuestion`. Surfaced to the planner prompt and the
   * analysis brief; enforced by the verifier's `MISSING_INFERRED_FILTER` rule.
   */
  inferredFilters?: InferredFilter[];
  /**
   * Human-readable caveats from deterministic plan-arg guards (e.g. the
   * period-additivity guard pinning a SUM to the latest-12-months rollup).
   * Appended to the narrator answer envelope's `caveats` so the chosen slice
   * is visible to the user rather than appearing as a magic number.
   */
  deterministicCaveats?: string[];
  /**
   * Post-hoc validation substrate for the chart-promotion layer. Lists
   * (column, values) pairs the user signalled they want OUT of the answer,
   * gathered from BOTH (a) negative inferred filters and (b) declared rollup
   * hierarchies whose intent classified as `peer-comparison`. Read by
   * `validateChartAgainstIntent` to drop or recover charts whose leader is a
   * value the user said to exclude.
   */
  intentEnvelope?: IntentEnvelope;
  summary: DataSummary;
  chatHistory: Message[];
  chatInsights?: Insight[];
  mode: "analysis" | "dataOps" | "modeling";
  permanentContext?: string;
  /**
   * Active user directives for the current dataset's fingerprint, hydrated at
   * session start from the `dataset_directives` Cosmos container. Filtered to
   * `status === 'active'`. Empty / undefined means no directives apply.
   *
   * Projected into every agent role's prompt block (planner, reflector,
   * verifier, synthesizer, business-actions) by `formatDirectiveBlock` and
   * merged into `intentEnvelope` as structural exclusions. NEVER truncated by
   * the prompt budget — directives are reserved budget, unlike RAG hits or the
   * blackboard digest.
   */
  activeDirectives?: import("../../../shared/schema.js").UserDirective[];
  /**
   * Per-turn sink for prompt-budget truncation events. Helpers that wrap large
   * input blocks in `applyCap` push a `TrimmedBlockInfo` here whenever they
   * actually trim. The chatStream service reads this sink after the turn
   * completes and emits a single coalesced `context_trimmed` SSE row so the UI
   * can surface a non-blocking toast ("Some background context was trimmed to fit").
   */
  contextTrimmedSink?: import("./promptBudget.js").TrimmedBlockInfo[];
  /**
   * Composed domain knowledge (Marico/FMCG packs) — emitted into the planner
   * and reflector user-message context. Authored background only; never used as
   * numeric evidence (verifier still demands tool/RAG support for figures).
   */
  domainContext?: string;
  /** Rolling LLM JSON context (seed + user + assistant merges). */
  sessionAnalysisContext?: SessionAnalysisContext;
  columnarStoragePath?: boolean;
  /**
   * PERF-10 · Per-turn memoised, already-initialized DuckDB handle, shared by
   * all read-only analytical tools that hit `ctx.sessionId` within this turn
   * (instead of each re-opening and re-closing its own). Managed exclusively by
   * `getTurnColumnarStorage` / `closeTurnColumnarStorage`
   * (./turnColumnarStorage.ts) — never read or write it directly. Closed once by
   * the agent loop at turn end. Undefined until the first adopter asks for it.
   */
  _turnColumnarStorage?: import("./turnColumnarStorage.js").TurnColumnarStorageCache;
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
   * Pivot/chart UI state of the most recent assistant message. Captured at turn
   * start from `chatHistory` so the planner and synthesizer can see what view
   * the user is currently looking at — useful for follow-up questions like "now
   * break it down by category" where the prior pivot's rows/values define the
   * implicit baseline.
   */
  lastAssistantPivotState?: Message["pivotState"];
  /** Shared evidence store for all agents in this turn / investigation node. */
  blackboard?: AnalyticalBlackboard;
  /**
   * Recursion guard for the spawned-question follow-up pass. Set true on every
   * sub-investigation context so a sub-turn never triggers its OWN follow-up
   * pass (which would recurse). Checked by the guarded block in runAgentTurn.
   */
  suppressSpawnedFollowUp?: boolean;
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
  /**
   * Per-turn capture buffer for analytical pivot results emitted by successful
   * `execute_query_plan` steps. The agent loop pushes one raw entry per
   * qualifying step BEFORE preview-row truncation (so the cache recall path can
   * re-render the full pivot). The chatStream service drains the buffer after
   * the turn returns, runs `materializePivotArtifact` on each entry
   * (inline-vs-blob policy, idempotent on artifactId), then patches the
   * resulting array onto the `past_analyses` doc via
   * `patchPastAnalysisPivotArtifacts`. Empty / undefined ⇒ no pivots captured
   * (data-prep tools, scalar aggregates, errored steps).
   *
   * Imported lazily via `import("../../pastAnalysisPivotArtifact.js")` to
   * avoid pulling Azure-blob SDK init into the agent runtime's module graph.
   */
  pivotArtifactsBuffer?: import("../../pastAnalysisPivotArtifact.js").RawPivotArtifact[];
}

export interface PlanStep {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  /** Optional id of another step in the same plan that must run first (outputs inform this step). */
  dependsOn?: string;
  /** Steps sharing the same parallelGroup (with no dependsOn on each other) execute concurrently. */
  parallelGroup?: string;
  /** ID of the hypothesis (from INVESTIGATION_HYPOTHESES) this step primarily tests. */
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
  /**
   * Populated when `detectConfidenceOverclaims` fires. Carries the claimed
   * (narrator) vs. actual (blackboard) confidence-tier counts so
   * agentLoop.service.ts can surface them on the `critic_verdict` SSE payload —
   * the workbench then renders a "narrator claimed N high; blackboard supports
   * M" line. Always undefined on per-step verifier rounds (which never see a
   * NarratorOutput); only the FINAL round can populate this.
   */
  confidenceOverclaim?: import("./verifierConfidenceCheck.js").ConfidenceOverclaimReport;
}

/**
 * Rich-envelope extensions — populated by the synthesiser when the user's
 * question has a questionShape (driver_discovery, variance_diagnostic, trend,
 * comparison, exploration). All optional so existing consumers stay valid.
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
  /** Magnitudes backing the main claim (2–4 entries). */
  magnitudes?: AnswerMagnitude[];
  /** Concise note on what the tools couldn't determine and why. */
  unexplained?: string;
  /** Agent-emitted dashboard draft; rendered as a chat preview card. */
  dashboardDraft?: import("../../../shared/schema.js").DashboardSpec;
  /** Populated blackboard from this turn's investigation (hypotheses + findings). */
  blackboard?: AnalyticalBlackboard;
  /** Sub-questions emitted by the reflector when anomalous findings warrant deeper investigation. */
  spawnedQuestions?: SpawnedQuestion[];
  /**
   * Which spawned sub-questions the in-turn follow-up pass actually investigated,
   * with the chart count each produced. Persisted onto the assistant message so
   * the "Investigated · N charts" badge survives reload (the live SSE
   * `sub_question_investigated` events are otherwise lost when the turn ends).
   */
  investigatedSubQuestions?: Array<{ id: string; question: string; chartCount: number }>;
  /**
   * Filters the agent applied to this turn's analysis (mirrors
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
   * The IntentEnvelope built at the start of the turn. Forwarded to the
   * pivot-envelope LLM (chatResponse.enrichPivotInsightFromEnvelope) so that
   * "Key Insight" sidebar respects the same user exclusions the chart layer
   * does. Absent when the turn had no exclusion intents.
   */
  intentEnvelope?: IntentEnvelope;
  /**
   * Compact digest of `ctx.blackboard` for client rendering. Built by
   * `buildInvestigationSummary` near the end of `runAgentTurn`, persisted
   * onto the assistant message so the UI can render a Hypotheses-tested /
   * Findings / Open-questions card above the step-by-step panel.
   */
  investigationSummary?: import("../../../shared/schema.js").InvestigationSummary;
  /**
   * Full in-memory turn state (workingMemory, reflector + verifier verdicts,
   * full blackboard snapshot, per-step tool I/O). Persisted onto the assistant
   * message so a follow-up turn's `priorTurnState` handle can read prior
   * structured state instead of TEXT digests, and so crash recovery /
   * debugging can replay the turn losslessly.
   */
  agentInternals?: import("../../../shared/schema.js").AgentInternals;
  /**
   * Structured AnswerEnvelope from narrator (TL;DR, findings, methodology,
   * caveats, implications, recommendations, domainLens). Optional — absent on
   * synthesis-fallback / dataOps turns. The agent-loop spread at the end of
   * `runAgentTurn` populates this from the local `envelopeAnswerEnvelope`
   * accumulator.
   */
  answerEnvelope?: import("../../../shared/schema.js").Message["answerEnvelope"];
  /**
   * Promise that resolves to the post-verifier business-actions agent's
   * output. Async-decoupled from the answer envelope so the response event
   * fires at exactly the moment it does today; the caller (chatStream
   * service) awaits this with a timeout AFTER emitting the response event,
   * then sends a separate `business_actions` SSE event and patches the
   * persisted message. Resolves to `[]` on timeout / failure / empty
   * self-gate; absent when the seam was hard-skipped (env flag off,
   * fallback synthesis, no envelope).
   */
  businessActionsPromise?: Promise<
    NonNullable<import("../../../shared/schema.js").Message["businessActions"]>
  >;
  /**
   * Drained snapshot of `ctx.pivotArtifactsBuffer` at the end of
   * `runAgentTurn`. The chatStream service iterates these, runs
   * `materializePivotArtifact` (inline-vs-blob policy), and patches the
   * resulting `PastAnalysisPivotArtifact[]` onto the same `past_analyses`
   * doc that was just upserted. Surfaced via this typed seam (rather than
   * read off `ctx` after-the-fact) so the contract is explicit and
   * traceable: agent loop → answerQuestion → chatStream.
   */
  pivotArtifacts?: import("../../pastAnalysisPivotArtifact.js").RawPivotArtifact[];
}
