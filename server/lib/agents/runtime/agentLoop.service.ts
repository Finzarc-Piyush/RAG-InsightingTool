/**
 * ============================================================================
 * agentLoop.service.ts — the "brain stem" that turns one user question into one
 *                         decision-grade answer, streamed live to the browser.
 * ============================================================================
 *
 * WHAT THIS FILE DOES
 *   This is the single orchestrator for answering an analytical question. A user
 *   types something like "why did East-region tech sales drop in April?" and this
 *   file runs the whole show end to end. The exported entry point `runAgentTurn`
 *   walks through these phases, emitting progress to the UI the entire time:
 *
 *     1. QUICK-LOOKUP FAST PATH — If the question is a trivial lookup ("top 5
 *        SKUs by sales", "average price"), short-circuit the whole pipeline with
 *        one tiny planner call + one DuckDB query and return immediately. Most
 *        questions are NOT this simple, so we fall through to the full loop.
 *
 *     2. PRE-PLANNING (analysis mode only) — Build an "analysis brief" (the
 *        model's structured read of WHAT the user asked: the outcome metric, the
 *        segments, the time window) and generate "hypotheses" (candidate
 *        explanations to test). Also do an upfront RAG retrieval (RAG = Retrieval
 *        Augmented Generation: pull semantically-relevant chunks from the indexed
 *        dataset + notes so the planner has grounding) and recall prior analyses
 *        from this session's memory journal.
 *
 *     3. PLAN → ACT → REFLECT LOOP — The heart of the engine:
 *          - PLAN: the planner LLM emits a list of STEPS, each naming a TOOL
 *            (DuckDB query, correlation, segment-driver analysis, MMM budget
 *            optimiser, web search, chart builder, …) plus its arguments. A
 *            registered "skill" can bypass the planner with pre-sequenced steps.
 *          - ACT: each step runs its tool via the ToolRegistry. Independent steps
 *            in a parallel group run concurrently. Results are recorded as
 *            "observations" (text), "structured observations" (full payloads),
 *            charts, tables, and "findings" on the BLACKBOARD (a shared scratch-
 *            pad of facts/hypotheses/open-questions the agents read and write).
 *          - REFLECT: after each step the REFLECTOR LLM decides: continue,
 *            finish, clarify, replan, or investigate a gap. (Note the SINGLE-FLOW
 *            policy invariant: replan/rewrite suggestions are emitted as visible
 *            `flow_decision` events but do NOT silently override the plan.)
 *        The loop is bounded by wall-time, max-steps, max-tool-calls, and max-LLM-
 *        calls budgets so a runaway turn can't burn forever.
 *
 *     4. SYNTHESIS — Turn observations + blackboard findings into the ANSWER
 *        ENVELOPE: a structured, decision-grade answer (body/TL;DR, key insight,
 *        findings, implications grouped by time horizon, recommendations,
 *        magnitudes with confidence, domain lens, caveats, follow-up CTAs).
 *        Preferred writer is the NARRATOR; if the blackboard is thin it falls
 *        back to a synthesizer, then to retry prompts, then to a deterministic
 *        non-LLM render — answer quality degrades gracefully, never to a crash.
 *
 *     5. ENVELOPE-COMPLETENESS REPAIR — Deterministic (non-LLM-opinion) checks:
 *        is the envelope missing required sections? does it cite a domain pack id
 *        that wasn't supplied (hallucination)? are magnitudes fabricated vs. the
 *        observations? Failures trigger bounded narrator repair rounds.
 *
 *     6. CHARTS & DASHBOARD — Promote useful intermediate query results to
 *        charts, materialize plan-time deferred charts, let the VISUAL PLANNER
 *        propose extra charts, and (only when the user explicitly asked for a
 *        dashboard) run a deterministic "feature sweep" to fill coverage gaps.
 *        All chart sources are then deduped + capped. If the turn qualifies, a
 *        DashboardSpec is built and (on the auto-create track) persisted.
 *
 *     7. FINAL VERIFICATION — The VERIFIER LLM critiques the finished narrative
 *        (groundedness, overclaimed confidence). Under single-flow it can flag
 *        but not silently swap the answer.
 *
 *     8. RETURN — Assemble the AgentLoopResult (answer + charts + envelope +
 *        trace + persistable internals + pivot artifacts + dashboard, …). A
 *        post-answer "business actions" agent may run un-awaited.
 *
 *   Throughout, everything is streamed to the client over SSE (Server-Sent
 *   Events: a one-way HTTP stream the browser subscribes to). The `emit` callback
 *   pushes named events — `thinking`, `plan`, `tool_call`, `tool_result`,
 *   `answer_chunk`, `critic_verdict`, `flow_decision`, `dashboard_created`, etc. —
 *   so the UI shows the agent's reasoning live instead of one frozen spinner.
 *
 * WHY IT MATTERS
 *   This is the spine of the product. Every analytical answer, chart, and
 *   dashboard the user sees flows through `runAgentTurn`. The chat-stream HTTP
 *   route calls it; the planner, all tools, the reflector, the narrator, and the
 *   verifier are the muscles, but this file is the nervous system that sequences
 *   them, enforces budgets, handles client-disconnect, and guarantees a
 *   well-formed answer envelope no matter which sub-step fails. The `AGENTIC_LOOP`
 *   is mandatory (invariant #1) — there is no legacy fallback path; this IS the
 *   engine.
 *
 * KEY PIECES
 *   - runAgentTurn(ctx, config, emit)  — THE exported entry point; runs the whole
 *                                        plan→act→reflect→synthesize→verify cycle.
 *   - synthesizeFinalAnswerEnvelope    — fallback writer (when the narrator is
 *                                        skipped) that produces the JSON answer
 *                                        envelope, with narrative/plain-text/dump
 *                                        retries if JSON synthesis fails.
 *   - runNarrativeRetry / runPlainTextRetry — stricter retry prompts that refuse
 *                                        to emit an empty or placeholder answer.
 *   - runPlannerWithOneRetry           — one corrective re-attempt at planning
 *                                        when the first plan fails validation.
 *   - finalizeMergedCharts             — final dedupe + cap across all chart
 *                                        sources; honours exclusion intent.
 *   - materializeDeferredBuildCharts   — builds plan-time `build_chart` specs from
 *                                        the SAME analytical frame the answer used.
 *   - buildAutoPivotSpec               — derives the dashboard's auto-attached
 *                                        pivot tile so it mirrors the chat pivot.
 *   - capAgentTrace                    — byte-caps the trace before persistence.
 *   - finalAnswerEnvelopeSchema        — the zod shape the synthesizer must emit.
 *
 * HOW IT CONNECTS (concrete collaborators)
 *   - Planner ............... ./planner.ts (+ ./runHypothesisAndBrief.ts,
 *                             ./analysisBrief.ts, ./hypothesisPlanner.ts)
 *   - Tools (act phase) ..... ./toolRegistry.ts + ./tools/registerTools.ts
 *   - Skills (plan bypass) .. ./skills/index.ts, ./skills/parallelResolve.ts
 *   - Reflector ............. ./reflector.ts
 *   - Narrator (writer) ..... ./narratorAgent.ts
 *   - Synth context bundle .. ./buildSynthesisContext.ts
 *   - Verifier .............. ./verifier.ts (+ ./verifierHelpers.ts, verdicts
 *                             from ./schemas.ts — never string literals, inv. #7)
 *   - Blackboard ............ ./analyticalBlackboard.ts
 *   - Memory / RAG .......... ./memoryRecall.ts, ../../rag/*, ./contextAgent.ts
 *   - Charts ................ ./chartFromTable.ts, ./visualPlanner.ts,
 *                             ./dashboardFeatureSweep.ts, ../../chartGenerator.ts
 *   - Dashboards ............ ./buildDashboard.ts, ../../../models/dashboard.model.ts
 *   - Envelope checks ....... ./checkEnvelopeCompleteness.ts and siblings
 *   - Persistable internals . ./buildAgentInternals.ts, ../../turnCheckpoint.ts
 *   - Budget optimiser glue . ./budgetOptimizerAdapter.ts
 *   - Business actions ...... ./businessActionsAgent.ts
 *
 *   NOTE for the noob: "LLM" = Large Language Model (the AI). "envelope" = the
 *   structured answer object. "blackboard" = shared in-memory notes. "SSE" =
 *   live event stream to the browser. "RAG" = fetching relevant context to feed
 *   the model. "tool" = a deterministic function (SQL query, optimiser, …) the
 *   plan calls. The agents (planner/reflector/narrator/verifier) are just LLM
 *   calls with specific jobs, coordinated by this file.
 */
import { randomUUID } from "crypto";
import { z } from "zod";
import type {
  AgentConfig,
  AgentExecutionContext,
  AgentLoopResult,
  AgentMidTurnSessionPayload,
  AgentTrace,
  PlanStep,
  ToolCallRecord,
  WorkingMemoryEntry,
} from "./types.js";
import { isInterAgentPromptFeedbackEnabled } from "./runtimeConfig.js";
import { ToolRegistry, type ToolResult } from "./toolRegistry.js";
import { closeTurnColumnarStorage } from "./turnColumnarStorage.js";
import { registerDefaultTools } from "./tools/registerTools.js";
import { maybeRunAnalysisBrief, shouldBuildAnalysisBrief } from "./analysisBrief.js";
import { applyDashboardCoverage } from "./dashboardCoverageGate.js";
import {
  classifyDashboardIntent,
  EXPLICIT_RX as DASHBOARD_EXPLICIT_RX,
} from "./dashboardIntent.js";
import { generateHypotheses } from "./hypothesisPlanner.js";
import {
  isMergedPrePlannerEnabled,
  runHypothesisAndBriefMerged,
} from "./runHypothesisAndBrief.js";
import { createBlackboard, addFinding, addOpenQuestion, resolveHypothesis, formatForNarrator } from "./analyticalBlackboard.js";
import { runContextAgentRound2 } from "./contextAgent.js";
import {
  isSpawnedFollowUpEnabled,
  shouldRunSpawnedFollowUp,
} from "./investigationTree.js";
import { runNarrator, shouldUseNarrator } from "./narratorAgent.js";
import { runBusinessActions } from "./businessActionsAgent.js";
import {
  isBudgetRedistributeOperationResult,
  buildRecommendationsFromBudgetOptimizer,
  buildMagnitudesFromBudgetOptimizer,
  buildDomainLensFromBudgetOptimizer,
} from "./budgetOptimizerAdapter.js";
import { buildSynthesisContext } from "./buildSynthesisContext.js";
import { buildInvestigationSummary } from "./buildInvestigationSummary.js";
import { sanitizeLikelyDrivers } from "./verifierCausalCheck.js";
import { buildAgentInternals } from "./buildAgentInternals.js";
import { auditMagnitude } from "./magnitudeAudit.js";
import { detectContradictions } from "./inconsistencyWatcher.js";
import {
  checkEnvelopeCompleteness,
  checkDomainLensCitations,
  extractSuppliedPackIds,
  checkAggregationQuestionAddressed,
} from "./checkEnvelopeCompleteness.js";
import {
  detectPerXIntent,
  detectMultiPerIntent,
  resolveMetricColumnFromQuestion,
} from "./planArgRepairs.js";
import { checkMagnitudesAgainstObservations } from "./checkMagnitudesAgainstObservations.js";
import { checkTemporalTrendBuckets } from "./checkTemporalTrendBuckets.js";
import { JsonFieldStreamExtractor } from "./jsonFieldStreamExtractor.js";
import { formatWorkingMemoryBlock, groupSortedStepsForExecution } from "./workingMemory.js";
import { runReflector } from "./reflector.js";
import { filterSpawnedQuestions } from "./filterSpawnedQuestions.js";
import { runVerifier, rewriteNarrative } from "./verifier.js";
import { buildFinalEvidence } from "./verifierHelpers.js";
import { VERIFIER_VERDICT } from "./schemas.js";
import { agentLog } from "./agentLogger.js";
import { renderFallbackAnswer } from "./synthesisFallback.js";
import {
  appendInterAgentMessage,
  formatInterAgentHandoffsForPrompt,
} from "./interAgentMessages.js";
import { proposeAndBuildExtraCharts } from "./visualPlanner.js";
import {
  type ChartSpec,
  type DashboardPivotSpec,
  type DataSummary,
  type Insight,
  type PivotAggLiteral,
  PIVOT_AGENT_RESULT_MAX_ROWS,
} from "../../../shared/schema.js";
import { filterAnsweredFollowUps } from "../../../shared/followUpDeepening.js";
import { lintAfterAnalyticalTool } from "../../agentToolObservationLint.js";
import { registerDerivedColumnOnSummary } from "../../deriveDimensionBucket.js";
import {
  addComputedColumnsArgsSchema,
  registerComputedColumnsOnSummary,
} from "../../computedColumns.js";
import { buildIntermediateInsight } from "./buildIntermediateInsight.js";
import { derivePivotDefaultsFromPreviewRows } from "../../pivotDefaultsFromPreview.js";
// Wave (ARCH-1/CQ-1) · pure pre-synthesis / dashboard-prep helpers extracted to a
// sibling module (low-coupling: explicit args, pure, no runAgentTurn closure state).
// Internal-only — no external importer uses them from this path, so no re-export.
import {
  buildAutoPivotSpec,
  buildPreSynthesisMidTurnSummary,
} from "./agentLoopSynthesisPrep.js";
import { mergePivotDefaultRowsAndValues } from "../../pivotDefaultsFromExecution.js";
import type { QueryPlanBody } from "../../queryPlanExecutor.js";
import { classifyQueryIntent } from "./queryIntentAuthority.js";
import { isBusinessActionsEnabled } from "../../envFlags.js";
import { sanitizeIntermediatePreviewRows } from "../../agentIntermediatePreviewSanitize.js";

const INTERMEDIATE_TABLE_TOOLS = new Set([
  "run_analytical_query",
  "execute_query_plan",
  "run_readonly_sql",
  "derive_dimension_bucket",
  "add_computed_columns",
  "run_segment_driver_analysis",
]);

/**
 * Data-prep tools transform the canonical frame (add a derived column, bucket
 * a dimension) but do NOT produce an analytical aggregate. Their preview
 * rows are the row-level dataset, so deriving pivot defaults from them would
 * categorize every dimension as a pivot row and surface a misleading
 * "every column on ROWS" cascade. The intermediate artifact still emits (so
 * the workbench shows what the agent did), but with a smaller sample and no
 * pivot defaults — the real analytical step that follows owns the pivot.
 */
const DATA_PREP_INTERMEDIATE_TOOLS = new Set([
  "add_computed_columns",
  "derive_dimension_bucket",
]);


// Wave R31 · pure shape/extraction/serialisation helpers extracted to a sibling
// module (low-coupling: they depend only on EXTERNAL types/modules, never on
// runtime values defined here). Imported back for internal use AND re-exported
// so any file importing them from this path keeps resolving unchanged.
import {
  detectSignificance,
  pickFindingConfidence,
  extractMagnitudeFromSummary,
  extractStatsFromNumericPayload,
  toolTableRowsForIntermediate,
  extractTableRowsAndColumns,
  toolTableColumnOrderForIntermediate,
  lastAnalyticalRowsSnapshot,
  rowKeysFromFirstRow,
  capAgentTrace,
  lastVerdictForStep,
  countWords,
  formatAnswerFromEnvelope,
} from "./agentLoopFormatters.js";
export {
  detectSignificance,
  pickFindingConfidence,
  extractMagnitudeFromSummary,
  extractStatsFromNumericPayload,
  toolTableRowsForIntermediate,
  extractTableRowsAndColumns,
  toolTableColumnOrderForIntermediate,
  lastAnalyticalRowsSnapshot,
  rowKeysFromFirstRow,
  capAgentTrace,
  lastVerdictForStep,
  countWords,
  formatAnswerFromEnvelope,
} from "./agentLoopFormatters.js";

export type AgentSseEmitter = (event: string, data: unknown) => void;

// Wave (ARCH-1/CQ-1) · the two zero-mutable-state per-turn helpers (safeEmit +
// checkAbort) extracted to ./agentLoop/emit.ts as explicit factories. Their
// returned closures have byte-identical bodies to the former inline versions;
// `onLlmCall` stays inline because it owns the mutable LLM-budget counter that
// is also read at the final return.
import { makeSafeEmit, makeCheckAbort } from "./agentLoop/emit.js";

// Wave (ARCH-1/CQ-1) · the per-turn mutable-state bundle + the cohesive phases
// extracted out of `runAgentTurn`. `createTurnState` builds the accumulator
// bundle once; the phase fns take it (+ explicit read-only collaborators) and
// move their bodies VERBATIM out of the orchestrator (locals → state.x).
import { createTurnState } from "./agentLoop/turnState.js";
import { persistTurnCheckpoint } from "./agentLoop/checkpointPhase.js";
import { promoteIntermediateAnalyticalChart } from "./agentLoop/promoteChartPhase.js";

// Wave (ARCH-1/CQ-1) · plan-time build_chart deferral + materialisation extracted
// to a sibling module (low-coupling: depends only on EXTERNAL chart modules + the
// shared ChartSpec / AgentExecutionContext types, never on runAgentTurn closure
// state). Imported back for internal use AND re-exported so any file importing
// them from this path keeps resolving unchanged.
import {
  type DeferredBuildChartTemplate,
  deferredTemplateFromBuiltChart,
  rowFrameSupportsDeferredTemplate,
  materializeDeferredBuildCharts,
} from "./agentLoopDeferredCharts.js";
export {
  type DeferredBuildChartTemplate,
  deferredTemplateFromBuiltChart,
  rowFrameSupportsDeferredTemplate,
  materializeDeferredBuildCharts,
} from "./agentLoopDeferredCharts.js";

// Wave (ARCH-1/CQ-1, deepened) · the final-answer synthesizer cluster
// (synthesizeFinalAnswerEnvelope + runNarrativeRetry + runPlainTextRetry + the
// magnitudeSchema / finalAnswerEnvelopeSchema shapes + the SynthesisSource tag)
// extracted to ./agentLoop/synthesis.ts (low-coupling: explicit args, depends only
// on EXTERNAL modules, never on runAgentTurn closure state). It was previously
// left inline ONLY because tests/synthesisRetry.test.ts grep-pinned its literals
// here; that test now points at the new module (L-017 pattern). Imported back for
// internal use (call site + the `magnitudeSchema` type at the `envelopeMagnitudes`
// declaration) AND re-exported so any file importing them from this path keeps
// resolving unchanged.
import {
  magnitudeSchema,
  synthesizeFinalAnswerEnvelope,
} from "./agentLoop/synthesis.js";
export {
  magnitudeSchema,
  finalAnswerEnvelopeSchema,
  synthesizeFinalAnswerEnvelope,
  runNarrativeRetry,
  runPlainTextRetry,
  type SynthesisSource,
} from "./agentLoop/synthesis.js";

// Wave (ARCH-1/CQ-1, deepened) · the final chart dedupe+cap cluster
// (finalizeMergedCharts + DASHBOARD_CHART_HARD_CAP) extracted to
// ./agentLoop/finalizeCharts.ts (low-coupling: explicit args, mutates the passed
// array, depends only on EXTERNAL chart/guard modules). It was previously left
// inline ONLY because tests/dashboardCapsDPF6.test.ts grep-pinned the `24`-cap
// literals here; that test now points at the new module (L-017 pattern). Imported
// back for internal use AND re-exported so any file importing them from this path
// keeps resolving unchanged.
import {
  finalizeMergedCharts,
  DASHBOARD_CHART_HARD_CAP,
} from "./agentLoop/finalizeCharts.js";
export {
  finalizeMergedCharts,
  DASHBOARD_CHART_HARD_CAP,
} from "./agentLoop/finalizeCharts.js";

// Import explicitly so the local binding exists (the helper is used below);
// keep the re-export so downstream consumers continue to import it via the
// agent loop module.
import { appendEnvelopeInsight } from "./insightHelpers.js";
import { errorMessage } from "../../../utils/errorMessage.js";
export { appendEnvelopeInsight };

// Wave (ARCH-1/CQ-1) · planner-retry wiring (PLANNER_RETRY_HINTS +
// runPlannerWithOneRetry) extracted to a sibling module (low-coupling: explicit
// args, returns the planner result, depends only on ./planner.js + ./agentLogger.js
// and the shared AgentExecutionContext / ToolRegistry types — never on runAgentTurn
// closure state). Imported back for internal use AND re-exported so any file
// importing it from this path keeps resolving unchanged.
import { runPlannerWithOneRetry } from "./agentLoopPlanner.js";
export { runPlannerWithOneRetry } from "./agentLoopPlanner.js";

export async function runAgentTurn(
  ctx: AgentExecutionContext,
  config: AgentConfig,
  emit?: AgentSseEmitter
): Promise<AgentLoopResult> {
  const registry = new ToolRegistry();
  registerDefaultTools(registry);
  const turnId = randomUUID();
  const toolCtx = { exec: ctx, config, turnId };
  const trace: AgentTrace = {
    turnId,
    startedAt: Date.now(),
    endedAt: Date.now(),
    steps: [],
    toolCalls: [],
    criticRounds: [],
    reflectorNotes: [],
    budgetHits: [],
    parseFailures: 0,
  };

  let llmCalls = 0;
  const onLlmCall = () => {
    llmCalls++;
    if (llmCalls > config.maxTotalLlmCallsPerTurn) {
      // W6.5 · Cap-hit telemetry. The throw is the existing brake; the log is
      // new so admin dashboards / Sentry sinks can flag turns that pin the
      // budget and need investigation (broken replan loop, runaway tool call).
      agentLog("agent.llm_budget_hit", {
        turnId,
        cap: config.maxTotalLlmCallsPerTurn,
        observed: llmCalls,
      });
      throw new Error("AGENT_LLM_BUDGET");
    }
  };

  // Wave (ARCH-1/CQ-1) · safeEmit + checkAbort are now built by explicit
  // factories in ./agentLoop/emit.ts (zero mutable shared state; identical
  // bodies). F3 client-disconnect abort: checkAbort throws AGENT_CLIENT_ABORTED
  // when the SSE stream's owner has hung up (caller maps to a clean early-
  // return); it's probed at major step boundaries so we don't burn LLM budget
  // for a tab the user closed.
  const safeEmit = makeSafeEmit(emit);
  const checkAbort = makeCheckAbort(ctx, turnId);

  // Wave (ARCH-1/CQ-1) · the ~30 mutable per-turn accumulators are bundled into
  // ONE `TurnState` object created here, so extracted phases can take it instead
  // of a dozen positional args. The REFERENCE-TYPE accumulators (arrays / the
  // blackboard-style logs) are destructured back into local `const` bindings:
  // destructuring an array copies the *reference*, so `mergedCharts.push(...)`
  // and `state.mergedCharts.push(...)` mutate the SAME instance — the rename is
  // behaviour-identical. The reassigned SCALARS (`let table`, `let
  // delegateAnswer`, the envelope/dashboard surfaces, the counters) stay as
  // locals AND are mirrored back onto `state` at the points the extracted phases
  // read them (currently: the checkpoint phase reads `state.stepsWalked`).
  const state = createTurnState();
  const {
    observations,
    accumulatedSpawnedQuestions,
    investigatedSubQuestionsOut,
    workingMemory,
    reflectorVerdicts,
    verifierVerdicts,
    toolIOEntries,
    structuredObservations,
    structuredFindings,
    magnitudeAudits,
    turnContradictions,
    mergedCharts,
    mergedInsights,
    deferredPlanCharts,
  } = state;
  let agentSuggestionHints: string[] = state.agentSuggestionHints;
  let followUpPrompts: string[] | undefined = state.followUpPrompts;
  // PR 1.G — rich envelope surfaces populated only during Phase-1 shapes.
  let envelopeMagnitudes: z.infer<typeof magnitudeSchema>[] | undefined;
  let envelopeUnexplained: string | undefined;
  // IUX2 · the key-insight text most recently seeded into mergedInsights, so the
  // envelope-repair loop (a sibling scope to the synthesis block where the
  // block-scoped envKeyInsight lives) can replace it in place rather than leave
  // a stale pre-repair insight in the Key Insights card.
  let seededKeyInsightText: string | undefined;
  // W3 · structured AnswerEnvelope emitted by narrator (optional). Threaded
  // through the agent return → chatStream → assistantSave → Cosmos so the
  // client can render an AnswerCard.
  let envelopeAnswerEnvelope:
    | import("../../../shared/schema.js").Message["answerEnvelope"]
    | undefined;
  // PR 2.B — dashboard draft emitted when the brief flags requestsDashboard.
  let dashboardDraft:
    | import("../../../shared/schema.js").DashboardSpec
    | undefined;
  // Set when the agent persisted the draft automatically (auto-save flow).
  // Used to short-circuit the chat-side "Create dashboard" CTA and route the
  // user straight to /dashboard?open=<id>.
  let createdDashboardId: string | undefined;
  let table: any = state.table;
  let operationResult: any = state.operationResult;
  let lastNumeric = "";
  let delegateAnswer: string | undefined;
  let lastRagHitCount: number | undefined;
  let toolCallsDone = 0;
  let stepsWalked = 0;
  let lastMidTurnPersist = 0;
  const midTurnThrottleMs = Math.max(
    0,
    parseInt(process.env.AGENT_MID_TURN_CONTEXT_THROTTLE_MS || "8000", 10) || 8000
  );

  const deadline = Date.now() + config.maxWallTimeMs;

  // Wave R1 · Direct-answer front door. One LLM triage call decides whether
  // the question can be answered with NO tools (conversational, general
  // knowledge, or dataset metadata answerable straight from the summary). On
  // "direct" it returns a text-only result and we short-circuit; on "escalate",
  // any uncertainty, or any error it returns null and we fall through to the
  // quick-lookup path and then the full loop. Runs ABOVE quick-lookup so a
  // greeting never pays even the quick-lookup Mini planner call.
  try {
    const { tryDirectAnswer } = await import("./directAnswerPath.js");
    const directResult = await tryDirectAnswer({
      ctx,
      turnId,
      onLlmCall,
      safeEmit,
    });
    if (directResult) {
      trace.endedAt = Date.now();
      // PERF-10 · Fast paths return before the main try/finally; close any
      // per-turn shared DuckDB handle they opened (idempotent if none).
      await closeTurnColumnarStorage(ctx);
      return directResult;
    }
  } catch (err) {
    // Front door is opt-in and best-effort: any unexpected throw falls through
    // to the existing pipeline. Logged so prod can spot a regressing helper.
    agentLog("direct_answer.path_threw", {
      turnId,
      error: errorMessage(err),
    });
  }

  // Wave QL1 · Quick-lookup fast path. When the question matches a simple
  // lookup shape (top-N, list, count, average, latest), bypass the full
  // hypothesis → brief → planner → reflector → narrator → verifier pipeline
  // with a single Mini-tier planner call + one DuckDB query. Returns null
  // for analytical / multi-part / non-analysis questions, in which case the
  // request flows through the existing loop unchanged. Wired at the very
  // top of the turn so the only LLM cost paid before the fall-through is
  // the planner Mini call.
  try {
    const { tryQuickAnswer } = await import("./quickAnswerPath.js");
    const quickResult = await tryQuickAnswer({
      ctx,
      turnId,
      onLlmCall,
      safeEmit,
    });
    if (quickResult) {
      trace.endedAt = Date.now();
      // PERF-10 · Fast paths return before the main try/finally; close any
      // per-turn shared DuckDB handle they opened (idempotent if none).
      await closeTurnColumnarStorage(ctx);
      return quickResult;
    }
  } catch (err) {
    // Fast path is opt-in and best-effort: any unexpected throw falls
    // through to the full loop. Logged so prod can spot a regressing
    // helper without affecting user-visible behaviour.
    agentLog("quick_lookup.path_threw", {
      turnId,
      error: errorMessage(err),
    });
  }

  // Query-intent authority (single source of truth). Both fast paths have
  // bailed, so we are committed to the full loop. Classify the question ONCE
  // and memoise the verdict + depthBudget on ctx; every downstream output-
  // shaping gate (extra charts, dashboard offer, spawned follow-ups, envelope
  // recommendations) reads `ctx.depthBudget` instead of re-deriving intent.
  // `minimal` ⇒ a plain lookup / direct factual ask: answer what was asked,
  // don't auto-pad. This is the structural fix for "simple question → plethora".
  ctx.queryIntent = classifyQueryIntent(ctx.question);
  ctx.depthBudget = ctx.queryIntent.depthBudget;
  const minimalDepth = ctx.depthBudget === "minimal";
  if (minimalDepth) {
    agentLog("depth_budget.minimal", {
      turnId,
      intentClass: ctx.queryIntent.intentClass,
      isDirectFactual: ctx.queryIntent.isDirectFactual,
      isLookupShape: ctx.queryIntent.isLookupShape,
    });
  }

  if (ctx.mode === "analysis") {
    // Ensure each boolean metric's VALID-UNIVERSE scope is present this turn —
    // even for sessions uploaded before scope inference shipped (their persisted
    // summary lacks `applicabilityScope`). Cheap, idempotent, runs only when a
    // boolean indicator is unscoped and enough rows are loaded for a reliable
    // cross-tab. Absence stays safe (unscoped = prior behaviour). Upload-time
    // inference (uploadQueue) remains the primary, full-data path.
    try {
      const needsScope = (ctx.summary.columns ?? []).some((c) => {
        const ind = (c as { indicator?: { kind?: string; positiveValues?: string[]; applicabilityScope?: unknown[] } }).indicator;
        return ind?.kind === "boolean" && (ind.positiveValues?.length ?? 0) > 0 && !(ind.applicabilityScope?.length);
      });
      if (needsScope && Array.isArray(ctx.data) && ctx.data.length >= 200) {
        const { inferMetricApplicability, applyMetricApplicabilityToSummary } =
          await import("../../inferMetricApplicability.js");
        applyMetricApplicabilityToSummary(
          ctx.summary,
          inferMetricApplicability(ctx.summary, ctx.data as Record<string, unknown>[])
        );
      }
    } catch {
      /* best-effort — absence of scope simply falls back to unscoped rates */
    }
    // W39 · when MERGED_PRE_PLANNER=true, fold the analysisBrief and
    // hypothesisPlanner LLM calls into a single round-trip below.
    // Otherwise keep the per-task analysisBrief call here unchanged.
    if (!isMergedPrePlannerEnabled()) {
      await maybeRunAnalysisBrief(ctx, turnId, onLlmCall);
    }
    // Phase-1 PR 1.A: publish a compact intent digest so the thinking panel
    // can surface "what the model thinks the user asked for" before any tools
    // run. Purely observational — no branching, no behavior change.
    if (ctx.analysisBrief) {
      const brief = ctx.analysisBrief;
      safeEmit("intent_parsed", {
        questionShape: brief.questionShape,
        outcomeMetricColumn: brief.outcomeMetricColumn,
        segmentationDimensions: brief.segmentationDimensions,
        candidateDriverDimensions: brief.candidateDriverDimensions,
        timeWindow: brief.timeWindow,
        comparisonBaseline: brief.comparisonBaseline,
        filters: brief.filters,
        clarifyingQuestions: brief.clarifyingQuestions,
      });
    }
  }

  const briefOut = () =>
    ctx.analysisBrief ? { analysisBrief: ctx.analysisBrief } : {};

  const appliedFiltersOut = () =>
    ctx.inferredFilters?.length
      ? {
          appliedFilters: ctx.inferredFilters.map((f) => ({
            column: f.column,
            op: f.op,
            values: f.values,
            match: f.match,
          })),
        }
      : {};

  // RD4 · forward the IntentEnvelope onto every AgentLoopResult exit so the
  // pivot envelope LLM (chatResponse.enrichPivotInsightFromEnvelope) can read
  // it without re-deriving the exclusion intent.
  const intentEnvelopeOut = () =>
    ctx.intentEnvelope?.exclusions.length
      ? { intentEnvelope: ctx.intentEnvelope }
      : {};

  const mergeStepArtifacts = (
    tool: string,
    result: ToolResult,
    evidenceCallId?: string
  ) => {
    if (result.ragHitCount !== undefined) {
      lastRagHitCount = result.ragHitCount;
    }
    if (result.numericPayload) {
      lastNumeric = result.numericPayload;
    }
    if (result.charts?.length) {
      // W7.2 · Provenance: every chart records the tool call that produced it
      // plus row counts when the tool exposes them via `analyticalMeta`. Lets
      // the UI show a "where did this come from" popover for trust.
      const meta = (result as { analyticalMeta?: { inputRowCount?: number; outputRowCount?: number } }).analyticalMeta;
      const provenance = evidenceCallId
        ? {
            toolCalls: [
              {
                id: evidenceCallId,
                tool,
                ...(typeof meta?.inputRowCount === "number" ? { rowsIn: meta.inputRowCount } : {}),
                ...(typeof meta?.outputRowCount === "number" ? { rowsOut: meta.outputRowCount } : {}),
              },
            ],
          }
        : undefined;
      const tag = (c: ChartSpec): ChartSpec => ({
        ...c,
        ...(evidenceCallId ?
          { _agentEvidenceRef: evidenceCallId, _agentTurnId: turnId }
        : {}),
        ...(provenance ? { _agentProvenance: provenance } : {}),
      });
      if (tool === "build_chart") {
        for (const c of result.charts) {
          deferredPlanCharts.push(
            deferredTemplateFromBuiltChart(tag(c as ChartSpec))
          );
        }
      } else {
        mergedCharts.push(...result.charts.map((c) => tag(c as ChartSpec)));
      }
    }
    if (result.insights?.length) {
      mergedInsights.push(...result.insights);
    }
    if (result.table) {
      table = result.table;
    }
    if (result.operationResult) {
      operationResult = result.operationResult;
    }
    if (result.answerFragment) {
      delegateAnswer = result.answerFragment;
    }
  };

  const maybeMidTurn = async (payload: AgentMidTurnSessionPayload) => {
    if (process.env.AGENT_MID_TURN_CONTEXT === "false") return;
    const fn = ctx.onMidTurnSessionContext;
    if (!fn) return;
    const now = Date.now();
    if (!payload.bypassThrottle && now - lastMidTurnPersist < midTurnThrottleMs) return;
    lastMidTurnPersist = Date.now();
    await fn({
      summary: payload.summary,
      phase: payload.phase,
      tool: payload.tool,
      ok: payload.ok,
    }).catch(() => {});
  };

  /** Survives catch if a post-synthesis step throws (e.g. visual planner). */
  let preservedAnswer = "";

  // W3 · clean fallback render — never echoes raw observation prefixes
  // (`[execute_query_plan]`, `Sample: [...]`, etc.) to the user. Returns
  // empty string when there are no observations at all so callers can fall
  // through to whatever upstream emergency-message they prefer.
  function observationsFallbackAnswer(): string {
    if (observations.length === 0) return "";
    return renderFallbackAnswer(observations).content;
  }

  // W2/W3: initialise the shared analytical blackboard for this turn.
  const blackboard = ctx.blackboard ?? createBlackboard();
  ctx.blackboard = blackboard;

  // W3: generate investigation hypotheses before the first planner call.
  // Non-fatal — planner works without hypotheses if LLM call fails.
  // W39: when MERGED_PRE_PLANNER=true, the merged call (hypothesis +
  // brief) runs HERE instead of the two separate calls. The merged path
  // mutates blackboard + ctx.analysisBrief in-place, mirroring the
  // per-task post-processing. On any failure it falls back to the
  // per-task path (so the merged option is always strictly safer).
  // W-CW1 · hypothesis brainstorming is depth-gated. A `minimal` ask (plain
  // lookup / direct-factual) never tests hypotheses and never gets an
  // investigation summary, so generating them is wasted LLM work that only
  // produces OPEN-status clutter. Skip the hypothesis block for minimal, but
  // still build the analysis brief when warranted — only the merged path hasn't
  // already built it at the earlier maybeRunAnalysisBrief call (L609), so the
  // non-merged path needs nothing here. Planner column-resolution is unaffected.
  // (invariant #12: gate at the call site on ctx.depthBudget; no private regex.)
  if (ctx.mode === "analysis" && minimalDepth) {
    if (isMergedPrePlannerEnabled() && shouldBuildAnalysisBrief(ctx)) {
      await maybeRunAnalysisBrief(ctx, turnId, onLlmCall);
    }
  } else if (ctx.mode === "analysis") {
    const briefStepLabel = isMergedPrePlannerEnabled()
      ? "Drafting analysis brief & hypotheses"
      : "Generating hypotheses";
    safeEmit("thinking", {
      step: briefStepLabel,
      status: "active",
      timestamp: Date.now(),
    });
    if (isMergedPrePlannerEnabled()) {
      const mergedShouldBuildBrief = shouldBuildAnalysisBrief(ctx);
      const merged = await runHypothesisAndBriefMerged(
        ctx,
        blackboard,
        turnId,
        onLlmCall,
        mergedShouldBuildBrief
      );
      if (!merged.ok) {
        // Fallback path mirrors the non-merged ordering exactly: brief
        // first (gated), then hypotheses.
        if (mergedShouldBuildBrief) {
          await maybeRunAnalysisBrief(ctx, turnId, onLlmCall);
        }
        await generateHypotheses(ctx, blackboard, turnId, onLlmCall);
      }
    } else {
      await generateHypotheses(ctx, blackboard, turnId, onLlmCall);
    }
    safeEmit("thinking", {
      step: briefStepLabel,
      status: "completed",
      timestamp: Date.now(),
      details: blackboard.hypotheses.length
        ? `${blackboard.hypotheses.length} hypothes${blackboard.hypotheses.length === 1 ? "is" : "es"}`
        : undefined,
    });
  }

  // P-A1: upfront RAG retrieval so the planner has semantic grounding on its
  // first call. Retrieval failures are non-fatal — planner still works on the
  // data summary alone; the block simply stays empty.
  let upfrontRagHitsBlock: string | undefined;
  let upfrontRagEmitted = false;
  try {
    const { isRagEnabled } = await import("../../rag/config.js");
    if (isRagEnabled()) {
      safeEmit("thinking", {
        step: "Retrieving session context",
        status: "active",
        timestamp: Date.now(),
      });
      upfrontRagEmitted = true;
      const { retrieveRagHits, formatHitsForPrompt } = await import(
        "../../rag/retrieve.js"
      );
      const { hits } = await retrieveRagHits({
        sessionId: ctx.sessionId,
        question: ctx.question,
        summary: ctx.summary,
        dataVersion: ctx.dataBlobVersion,
      });
      // Top few hits only; formatter already joins with separators.
      const topHits = hits.slice(0, 3);
      if (topHits.length > 0) {
        upfrontRagHitsBlock = formatHitsForPrompt(topHits);
        if (lastRagHitCount === undefined) {
          lastRagHitCount = topHits.length;
        }
      }
      safeEmit("thinking", {
        step: "Retrieving session context",
        status: "completed",
        timestamp: Date.now(),
        details: `${topHits.length} hit${topHits.length === 1 ? "" : "s"}`,
      });
    }
  } catch (err) {
    if (upfrontRagEmitted) {
      safeEmit("thinking", {
        step: "Retrieving session context",
        status: "completed",
        timestamp: Date.now(),
      });
    }
    agentLog("upfrontRag.failed", {
      turnId,
      error: errorMessage(err),
    });
  }

  // W60 · semantic recall over the per-session Analysis Memory journal.
  // Replaces the count-capped priorInvestigations block in the planner prompt
  // with unbounded session memory + bounded prompt size.
  let memoryRecallBlock: string | undefined;
  try {
    const { formatMemoryRecallForPlanner } = await import("./memoryRecall.js");
    const block = await formatMemoryRecallForPlanner({
      sessionId: ctx.sessionId,
      question: ctx.question,
      // No minDataVersion floor: prior findings stay informational context even
      // after data transforms; the narrator weighs relevance against the
      // current frame. Tighten only when a transform clearly invalidates them.
    });
    if (block) {
      memoryRecallBlock = block;
    }
  } catch (err) {
    agentLog("memoryRecall.failed", {
      turnId,
      error: errorMessage(err),
    });
  }

  // Phase-1: when DEEP_ANALYSIS_SKILLS_ENABLED=true and a registered skill
  // matches the brief, the first iteration bypasses the planner and runs
  // the skill's pre-sequenced steps. Subsequent iterations (after reflector
  // replan) fall back to the normal planner so replans still work.
  let skillBypassUsed = false;
  const {
    isDeepAnalysisSkillsEnabled: skillsFlagOn,
    selectSkill,
    expandSkill,
  } = await import("./skills/index.js");
  const { diagnosticMaxParallelBranches } = await import(
    "../../diagnosticPipelineConfig.js"
  );
  const { preResolveParallelSteps } = await import(
    "./skills/parallelResolve.js"
  );
  /**
   * PR 1.E: cache of pre-resolved tool results. Populated when a
   * parallelizable skill dispatches; the step loop consumes from this
   * cache first and only falls back to registry.execute if the step has
   * no entry. Keyed by step.id.
   */
  const preResolvedToolResults = new Map<string, ToolResult>();

  try {
    let replans = 0;
    // P-020: promoted to AgentConfig so operators can tune via AGENT_MAX_REPLANS_PER_STEP.
    while (replans <= config.maxReplansPerStep) {
      checkAbort("planner-loop");
      if (Date.now() > deadline) {
        trace.budgetHits?.push("wall_time");
        break;
      }

      const priorForPlanner =
        observations.length > 0
          ? observations.join("\n\n---\n\n").slice(0, config.observationMaxChars)
          : undefined;
      const workingMemoryBlock = formatWorkingMemoryBlock(workingMemory);
      const handoffDigest =
        isInterAgentPromptFeedbackEnabled() && trace.interAgentMessages?.length
          ? formatInterAgentHandoffsForPrompt(trace.interAgentMessages, 4000)
          : undefined;

      // Skill dispatch (first iteration only, flag-gated). When the skill
      // expands into zero steps or throws, fall through to the planner.
      let planResult:
        | { ok: true; rationale: string; steps: PlanStep[] }
        | Awaited<ReturnType<typeof runPlannerWithOneRetry>>
        | null = null;
      if (
        !skillBypassUsed &&
        replans === 0 &&
        skillsFlagOn() &&
        ctx.analysisBrief
      ) {
        try {
          const skill = selectSkill(ctx.analysisBrief, ctx);
          if (skill) {
            const invocation = expandSkill(skill, ctx.analysisBrief, ctx);
            if (invocation && invocation.steps.length > 0) {
              skillBypassUsed = true;
              safeEmit("skill_execution", {
                skill: skill.name,
                invocationId: invocation.id,
                label: invocation.label,
                stepCount: invocation.steps.length,
                rationale: invocation.rationale,
              });
              appendInterAgentMessage(
                trace,
                {
                  from: "Coordinator",
                  to: "Planner",
                  intent: `skill_dispatch:${skill.name}`,
                  artifacts: invocation.steps.map((s) => s.id),
                  meta: {
                    skill: skill.name,
                    invocationId: invocation.id,
                  },
                },
                safeEmit
              );
              planResult = {
                ok: true,
                rationale:
                  invocation.rationale ||
                  `Skill ${skill.name} expanded into ${invocation.steps.length} step(s).`,
                steps: invocation.steps,
              };

              // PR 1.E: when the skill opts into parallelism, pre-run the
              // independent steps (no dependsOn) in parallel up to the
              // diagnostic branch budget. The step loop picks these results
              // out of preResolvedToolResults instead of re-executing; per
              // -step reflector / verifier / state updates still run serial
              // in plan order.
              if (invocation.parallelizable === true) {
                const maxParallel = diagnosticMaxParallelBranches();
                try {
                  const parallelOut = await preResolveParallelSteps(
                    invocation,
                    (step) => registry.execute(step.tool, step.args, toolCtx),
                    maxParallel
                  );
                  if (parallelOut.stepIds.length > 0) {
                    safeEmit("skill_parallel_batch", {
                      invocationId: invocation.id,
                      stepIds: parallelOut.stepIds,
                      budget: maxParallel,
                      elapsedMs: parallelOut.elapsedMs,
                    });
                    for (const [id, result] of parallelOut.resolved) {
                      preResolvedToolResults.set(id, result);
                    }
                    agentLog("skill.parallel.resolved", {
                      turnId,
                      invocationId: invocation.id,
                      count: parallelOut.stepIds.length,
                      elapsedMs: parallelOut.elapsedMs,
                    });
                  }
                } catch (parallelErr) {
                  // Non-fatal: clear the cache and let the step loop
                  // execute tools sequentially via registry.execute.
                  preResolvedToolResults.clear();
                  agentLog("skill.parallel.failed", {
                    turnId,
                    error:
                      errorMessage(parallelErr),
                  });
                }
              }
            }
          }
        } catch (skillErr) {
          agentLog("skill.dispatch.failed", {
            turnId,
            error:
              errorMessage(skillErr),
          });
        }
      }

      if (!planResult) {
        // Wave B5 · format structured per-step insights collected so far in
        // this turn into a labelled block the planner can build on. This
        // closes the gap where W19 step insights were emitted to the UI but
        // never threaded back into the next planning iteration.
        const stepInsightsBlock =
          mergedInsights.length > 0
            ? mergedInsights
                .slice(-5) // last 5 steps' insights
                .map((ins, idx) => {
                  const text =
                    typeof (ins as { text?: string }).text === "string"
                      ? ((ins as { text?: string }).text as string)
                      : typeof ins === "string"
                        ? (ins as string)
                        : "";
                  return text ? `${idx + 1}. ${text.slice(0, 500)}` : "";
                })
                .filter(Boolean)
                .join("\n")
            : "";
        safeEmit("thinking", {
          step: "Planning approach",
          status: "active",
          timestamp: Date.now(),
        });
        planResult = await runPlannerWithOneRetry(
          ctx,
          registry,
          turnId,
          onLlmCall,
          priorForPlanner,
          workingMemoryBlock || undefined,
          handoffDigest,
          upfrontRagHitsBlock,
          memoryRecallBlock,
          stepInsightsBlock || undefined
        );
        safeEmit("thinking", {
          step: "Planning approach",
          status: "completed",
          timestamp: Date.now(),
          details:
            planResult?.ok && Array.isArray(planResult.steps)
              ? `${planResult.steps.length} step${planResult.steps.length === 1 ? "" : "s"}`
              : undefined,
        });
      }
      if (!planResult.ok) {
        trace.parseFailures = (trace.parseFailures || 0) + 1;
        trace.plannerRejectReason = planResult.reason;
        trace.plannerRejectDetail = [
          planResult.tool,
          planResult.stepId,
          planResult.argKeys,
          planResult.zod_error,
          planResult.apiError,
        ]
          .filter(Boolean)
          .join("|")
          .slice(0, 300);
        appendInterAgentMessage(
          trace,
          {
            from: "Planner",
            to: "Coordinator",
            intent: "plan_rejected",
            evidenceRefs: planResult.stepId ? [String(planResult.stepId)] : undefined,
            meta: {
              reason: String(planResult.reason ?? "unknown").slice(0, 80),
            },
          },
          safeEmit
        );
        trace.endedAt = Date.now();
        agentLog("turn.abort", {
          phase: "planner",
          turnId,
          reason: planResult.reason,
          parseFailures: trace.parseFailures ?? 0,
          questionLength: ctx.question.length,
          sessionIdLen: ctx.sessionId.length,
        });
        return {
          answer: "",
          charts: mergedCharts.length ? mergedCharts : undefined,
          insights: mergedInsights.length ? mergedInsights : undefined,
          table,
          operationResult,
          agentTrace: capAgentTrace(trace),
          agentSuggestionHints: agentSuggestionHints.length ? agentSuggestionHints : undefined,
          lastAnalyticalRowsForEnrichment: lastAnalyticalRowsSnapshot(ctx),
          ...briefOut(),
      ...appliedFiltersOut(),
      ...intentEnvelopeOut(),
        };
      }

      const plan = planResult;

      // DB3 · Dashboard coverage gate. When `brief.requestsDashboard` is true
      // and the LLM-emitted plan misses any low-cardinality dimension named in
      // `candidateDriverDimensions ∪ segmentationDimensions`, append a
      // deterministic `build_chart` step per missing dim. Single-flow policy
      // is preserved (no replan, no narrative override). High-cardinality dims
      // pass through to DB4's feature-sweep top-N+Other bucketing.
      const coverage = applyDashboardCoverage(plan.steps, ctx);
      if (coverage.extensions.length > 0) {
        safeEmit("dashboard_coverage_gate", {
          missingDimensions: coverage.missingDimensions,
          highCardinalityDimensions: coverage.highCardinalityDimensions,
          appendedStepIds: coverage.extensions.map((s) => s.id),
        });
        agentLog("dashboardCoverageGate.extended", {
          turnId,
          missing: coverage.missingDimensions.join(","),
          appended: coverage.extensions.length,
        });
      }

      trace.planRationale = plan.rationale;
      trace.steps = plan.steps;
      appendInterAgentMessage(
        trace,
        {
          from: "Planner",
          to: "Coordinator",
          intent: "plan_accepted",
          artifacts: plan.steps.map((s) => s.id),
          evidenceRefs: plan.steps.map((s) => s.id).slice(0, 12),
          meta: { stepCount: String(plan.steps.length) },
        },
        safeEmit
      );
      safeEmit("plan", {
        rationale: plan.rationale,
        steps: plan.steps.map((s) => ({
          id: s.id,
          tool: s.tool,
          args_summary: JSON.stringify(s.args).slice(0, 400),
        })),
      });

      if (ctx.mode === "analysis") {
        void maybeMidTurn({
          phase: "plan",
          summary: `Plan rationale:\n${(plan.rationale || "").slice(0, 2000)}\nSteps: ${plan.steps.map((s) => `${s.id}:${s.tool}`).join(" | ")}`,
          ok: true,
        });
      }

      let stopEarly = false;

      // W1: Track which steps should skip their individual reflector call because they
      // are non-terminal members of a parallel group. The last step in the group still
      // runs the reflector with all accumulated observations from the whole group.
      const skipReflectorStepIds = new Set<string>();

      // W1: Clear stale pre-resolved results from a prior replan iteration, then
      // pre-resolve independent steps that share a parallelGroup concurrently.
      // Results land in preResolvedToolResults; the step loop consumes them normally.
      if (replans > 0) preResolvedToolResults.clear();
      {
        const MAX_PARALLEL_TOOLS = 3;
        const groups = groupSortedStepsForExecution(plan.steps);
        for (const group of groups) {
          if (group.length < 2) continue;
          const parallelSteps = group.slice(0, MAX_PARALLEL_TOOLS);
          const t0 = Date.now();
          const settled = await Promise.all(
            parallelSteps.map(async (step) => {
              if (preResolvedToolResults.has(step.id)) return null; // already resolved by skill dispatch
              try {
                const r = await registry.execute(step.tool, step.args, toolCtx);
                return { id: step.id, result: r };
              } catch (err) {
                const msg = errorMessage(err);
                return {
                  id: step.id,
                  result: { ok: false, summary: `Parallel pre-resolve error: ${msg}` } as ToolResult,
                };
              }
            })
          );
          let addedCount = 0;
          for (const s of settled) {
            if (s) {
              preResolvedToolResults.set(s.id, s.result);
              addedCount++;
            }
          }
          if (addedCount >= 2) {
            for (const step of parallelSteps.slice(0, -1)) {
              skipReflectorStepIds.add(step.id);
            }
            agentLog("parallel.group.resolved", {
              turnId,
              parallelGroup: group[0]!.parallelGroup,
              count: addedCount,
              elapsedMs: Date.now() - t0,
            });
            safeEmit("parallel_group_resolved", {
              parallelGroup: group[0]!.parallelGroup,
              stepIds: parallelSteps.map((s) => s.id),
              count: addedCount,
            });
          }
        }
      }

      stepLoop: for (let si = 0; si < plan.steps.length; si++) {
        const step = plan.steps[si]!;
        if (Date.now() > deadline) {
          trace.budgetHits?.push("wall_time");
          stopEarly = true;
          break;
        }
        if (stepsWalked >= config.maxSteps) {
          trace.budgetHits?.push("max_steps");
          stopEarly = true;
          break;
        }
        if (toolCallsDone >= config.maxToolCalls) {
          trace.budgetHits?.push("max_tool_calls");
          stopEarly = true;
          break;
        }

        stepsWalked++;

        let stepResult: ToolResult | undefined;
        let finalCallId = "";
        let finalCandidate = "";

        attemptLoop: for (let attempt = 0; attempt < 2; attempt++) {
          const callId = `${step.id}-${toolCallsDone}`;
          const argsSummary = JSON.stringify(step.args).slice(0, 400);
          safeEmit("tool_call", { id: callId, name: step.tool, args_summary: argsSummary });

          const t0 = Date.now();
          // PR 1.E: consume the pre-resolved parallel-batch result if one
          // was computed during skill dispatch. Only first-attempt steps
          // use the cache — retries always hit registry.execute so a
          // transient failure isn't replayed from the cached failure.
          const cachedResult =
            attempt === 0 ? preResolvedToolResults.get(step.id) : undefined;
          if (cachedResult) {
            preResolvedToolResults.delete(step.id);
          }
          const result =
            cachedResult ?? (await registry.execute(step.tool, step.args, toolCtx));
          const t1 = Date.now();
          toolCallsDone++;

          const record: ToolCallRecord = {
            id: callId,
            name: step.tool,
            argsSummary,
            ok: result.ok,
            startedAt: t0,
            endedAt: t1,
            resultSummary: result.summary.slice(0, 2_500),
          };
          trace.toolCalls.push(record);
          // Wave A2 · capture full tool I/O (including the table / numericPayload
          // that the legacy `trace.toolCalls` truncates to a 2_500-char summary).
          {
            let argsJson = "{}";
            try {
              argsJson = JSON.stringify(step.args ?? {});
            } catch {
              /* fall through with empty */
            }
            let resultPayload: string | undefined;
            try {
              const obj: Record<string, unknown> = {};
              const tableLike = (result as { table?: unknown }).table;
              if (tableLike != null) obj.table = tableLike;
              if (result.numericPayload != null)
                obj.numericPayload = result.numericPayload;
              if (Object.keys(obj).length > 0) resultPayload = JSON.stringify(obj);
            } catch {
              /* skip on cyclic */
            }
            toolIOEntries.push({
              stepId: step.id,
              tool: step.tool,
              ok: result.ok,
              argsJson,
              resultSummary: result.summary,
              resultPayload,
              analyticalMeta: result.analyticalMeta as
                | {
                    inputRowCount?: number;
                    outputRowCount?: number;
                    appliedAggregation?: boolean;
                  }
                | undefined,
              durationMs: Math.max(0, t1 - t0),
            });
            // Wave B3 · lossless structured observation (full ToolResult).
            structuredObservations.push({
              id: `obs-${step.id}-${structuredObservations.length + 1}`,
              stepId: step.id,
              tool: step.tool,
              args: (step.args ?? {}) as Record<string, unknown>,
              result, // full ToolResult preserved
              resultSummary: result.summary,
              metrics: {
                inputRowCount: (result.analyticalMeta as { inputRowCount?: number } | undefined)
                  ?.inputRowCount,
                outputRowCount: (result.analyticalMeta as { outputRowCount?: number } | undefined)
                  ?.outputRowCount,
                appliedAggregation: (result.analyticalMeta as { appliedAggregation?: boolean } | undefined)
                  ?.appliedAggregation,
                durationMs: Math.max(0, t1 - t0),
              },
              findingIds: [], // populated below if Wave B4 path emits a structured finding
              createdAt: t1,
            });
          }

          safeEmit("tool_result", {
            id: callId,
            ok: result.ok,
            summary: result.summary.slice(0, 2000),
          });

          if (result.workbenchArtifact) {
            safeEmit("workbench", { entry: result.workbenchArtifact });
          }

          void maybeMidTurn({
            phase: "tool",
            tool: step.tool,
            summary: result.summary,
            ok: result.ok,
          });

          stepResult = result;
          finalCallId = callId;

          const invalidArgs =
            !result.ok && result.summary.startsWith("Invalid args for");
          if (invalidArgs) {
            trace.parseFailures = (trace.parseFailures || 0) + 1;
            const help = registry.getArgsHelpForTool(step.tool) ?? "{}";
            observations.push(
              `[SYSTEM_REPAIR] Tool "${step.tool}" args must match the schema. Allowed: ${help}. Error: ${result.summary.slice(0, 400)}`
            );
            workingMemory.push({
              callId,
              tool: step.tool,
              ok: false,
              summaryPreview: result.summary,
              suggestedColumns: undefined,
              slots: undefined,
            });
            replans++;
            break stepLoop;
          }

          if (result.clarify) {
            appendInterAgentMessage(
              trace,
              {
                from: "Executor",
                to: "Coordinator",
                intent: "tool_requests_clarify",
                evidenceRefs: [callId, step.id],
                meta: { tool: step.tool, stepId: step.id },
              },
              safeEmit
            );
            mergeStepArtifacts(step.tool, result, callId);
            materializeDeferredBuildCharts(ctx, deferredPlanCharts, mergedCharts);
            trace.endedAt = Date.now();
            return {
              answer: result.clarify,
              charts: mergedCharts.length ? mergedCharts : undefined,
              insights: mergedInsights.length ? mergedInsights : undefined,
              table,
              operationResult,
              agentTrace: capAgentTrace(trace),
              lastAnalyticalRowsForEnrichment: lastAnalyticalRowsSnapshot(ctx),
              ...briefOut(),
      ...appliedFiltersOut(),
      ...intentEnvelopeOut(),
            };
          }

          // W1 · The step-level verifier critiques narrative quality. Tool
          // summaries from analytical tools (execute_query_plan,
          // run_analytical_query, etc.) are evidence digests, not narrative
          // drafts — running the verifier on them produced false-positive
          // MISSING_NARRATIVE / MISSING_MAGNITUDES verdicts and noisy
          // verifier-rewrite-step flow_decisions. Gate on whether the tool
          // actually emitted a prose answerFragment.
          const hasNarrativeCandidate = Boolean(result.answerFragment?.trim());

          let candidate =
            result.answerFragment ||
            result.summary ||
            (result.ok ? "(no summary)" : "Tool failed.");
          if (result.suggestedColumns?.length) {
            candidate += `\nSuggested columns: ${result.suggestedColumns.join(", ")}`;
          }

          // Evidence is what the verifier inspects; kept generous (and consistent
          // with the larger narrator-side observation cap) so the verifier sees a
          // rich enough slice to judge groundedness.
          const evidence = `${result.summary}\n${lastNumeric || ""}`.slice(0, 14_000);

          if (hasNarrativeCandidate) {
            const vRound = 0;
            while (vRound < config.maxVerifierRoundsPerStep) {
              const verdict = await runVerifier(
                ctx,
                {
                  candidate,
                  evidenceSummary: evidence,
                  stepId: step.id,
                  turnId,
                  blackboard: ctx.blackboard,
                  planSteps: plan.steps,
                  charts: mergedCharts,
                  // Wave B6 · in-turn verifier history.
                  priorVerifierVerdicts: verifierVerdicts,
                },
                onLlmCall
              );

              trace.criticRounds.push({
                stepId: step.id,
                verdict: verdict.verdict,
                issueCodes: verdict.issues.map((i) => i.code),
                courseCorrection: verdict.course_correction,
              });
              // Wave A2 · structured verifier-verdict record persisted via
              // agentInternals so subsequent turns / debugging can replay.
              {
                const issueLines = verdict.issues
                  .map((i) => `${i.code}: ${i.description}`)
                  .join("\n")
                  .slice(0, 3_000);
                verifierVerdicts.push({
                  stepIndex: stepsWalked,
                  verdict: verdict.verdict,
                  rationale: verdict.course_correction || issueLines || "(no rationale)",
                  evidence: evidence?.slice(0, 6_000),
                });
              }

              safeEmit("critic_verdict", {
                stepId: step.id,
                verdict: verdict.verdict,
                issue_codes: verdict.issues.map((i) => i.code),
                course_correction: verdict.course_correction,
                // Wave WV8 · per-step verifier rounds never see a
                // NarratorOutput, so `confidenceOverclaim` is always
                // undefined here — but spread defensively in case a future
                // wave threads narrator state into the per-step path.
                ...(verdict.confidenceOverclaim
                  ? {
                      confidence_overclaim: {
                        claimed: verdict.confidenceOverclaim.claimed,
                        actual: verdict.confidenceOverclaim.actual,
                      },
                    }
                  : {}),
              });

              if (verdict.verdict === VERIFIER_VERDICT.pass) {
                break;
              }
              if (
                verdict.verdict === VERIFIER_VERDICT.reviseNarrative ||
                verdict.course_correction === VERIFIER_VERDICT.reviseNarrative
              ) {
                // Single-flow policy: rewriteNarrative is suppressed. Verifier's
                // verdict is still emitted as a critic_verdict SSE event (visible
                // in the workbench) so the user can see what the verifier flagged
                // without having the synthesized narrative silently swapped out.
                const issuesText = verdict.issues.map((i) => i.description).join("; ");
                safeEmit("flow_decision", {
                  layer: "verifier-rewrite-step",
                  chosen: "kept-original",
                  reason: `Rewrite suppressed (single-flow policy); ${issuesText.slice(0, 400)}`.slice(0, 500),
                  candidates: verdict.issues.map((i) => i.code).slice(0, 8),
                });
              }
              break;
            }
          }

          finalCandidate = candidate;

          const lastV = lastVerdictForStep(trace, step.id);
          if (lastV === VERIFIER_VERDICT.retryTool && attempt < 1) {
            trace.reflectorNotes.push(`retry_tool: re-exec ${step.tool}`);
            continue attemptLoop;
          }
          break attemptLoop;
        }

        if (!stepResult) {
          break;
        }

        {
          // W1 · skip the Verifier→Coordinator handoff message when the
          // step-level verifier did not actually run (analytical tools with
          // no narrative candidate). Without this gate the trace shows a
          // fake "step_verdict" inter-agent message with an empty verdict.
          const lv = lastVerdictForStep(trace, step.id);
          if (lv) {
            appendInterAgentMessage(
              trace,
              {
                from: "Verifier",
                to: "Coordinator",
                intent: "step_verdict",
                artifacts: [step.id],
                evidenceRefs: [finalCallId, step.id],
                meta: {
                  tool: step.tool,
                  verdict: lv,
                },
              },
              safeEmit
            );
          }
        }

        mergeStepArtifacts(step.tool, stepResult, finalCallId);

        if (
          stepResult.ok &&
          ctx.onIntermediateArtifact &&
          INTERMEDIATE_TABLE_TOOLS.has(step.tool)
        ) {
          const intermediateRows = sanitizeIntermediatePreviewRows(
            toolTableRowsForIntermediate(stepResult)
          );
          if (intermediateRows.length > 0) {
            const insight = buildIntermediateInsight(step.tool, stepResult);
            const isDataPrep = DATA_PREP_INTERMEDIATE_TOOLS.has(step.tool);
            const intermediateColumnOrder =
              toolTableColumnOrderForIntermediate(stepResult);
            // PVT1 · For execute_query_plan, route through the trace-aware
            // helper so the pivot respects groupBy + aggregations + dimension
            // filters. Filter-projection plans (groupBy with no aggregations)
            // would otherwise dump every numeric in the result slice into
            // VALUES via the dataset-preview categorizer.
            const tracePlan: QueryPlanBody | undefined =
              step.tool === "execute_query_plan"
                ? ((step.args as Record<string, unknown> | undefined)?.plan as
                    | QueryPlanBody
                    | undefined)
                : undefined;
            // Data-prep tools return the row-level frame with the new column /
            // bucket — never derive a pivot from that, it would produce the
            // "every dim on ROWS" cascade. The intermediate artifact still
            // emits so the workbench shows the action; just no pivot.
            let pivotDefaults: ReturnType<
              typeof mergePivotDefaultRowsAndValues
            > = undefined;
            let pivotFromTracePlan = false;
            if (!isDataPrep) {
              if (tracePlan && typeof tracePlan === "object") {
                pivotDefaults = mergePivotDefaultRowsAndValues({
                  dataSummary: ctx.summary,
                  tracePlan,
                  tableRows: intermediateRows,
                  tableColumns: intermediateColumnOrder ?? [],
                });
                pivotFromTracePlan = Boolean(pivotDefaults);
              } else {
                pivotDefaults = derivePivotDefaultsFromPreviewRows(
                  intermediateRows,
                  ctx.summary,
                  intermediateColumnOrder
                );
              }
              // PVT1 · Universal "when in doubt, don't auto-explode" guard.
              // If the derived defaults pile up more than 8 fields across
              // rows + values AND there's no trace-plan-derived shape we
              // trust, suppress entirely. Encodes the user's rule: never
              // fill everything when we don't understand what to do.
              if (!pivotFromTracePlan && pivotDefaults) {
                const totalFields =
                  (pivotDefaults.rows?.length ?? 0) +
                  (pivotDefaults.values?.length ?? 0);
                if (totalFields > 8) {
                  agentLog("pivot_defaults_suppressed_unclear", {
                    turnId,
                    tool: step.tool,
                    rows: pivotDefaults.rows?.length ?? 0,
                    values: pivotDefaults.values?.length ?? 0,
                  });
                  pivotDefaults = undefined;
                }
              }
            }
            // PVT1 · Filter-projection (rows from groupBy, no values) is now
            // a valid pivot hint — gate is rows.length > 0 OR values.length > 0,
            // not both. Empty rows AND empty values still suppresses.
            const hasPivotHint =
              !isDataPrep
              && Boolean(pivotDefaults)
              && (
                Boolean(pivotDefaults?.rows?.length)
                || Boolean(pivotDefaults?.values?.length)
              );
            // Scalar: a 1-row aggregate with no row dimensions. Flag it so the
            // chat stream skips the schema-heuristic fallback that otherwise
            // renders Postal-Code-by-week-style nonsense beneath the answer.
            // Data-prep outputs are not scalar (they're full row-level frames)
            // — they're already handled by skipping pivot derivation above.
            const executionScalar =
              !isDataPrep
              && intermediateRows.length <= 1
              && !pivotDefaults?.rows?.length;
            // PVT5 · intermediate parallel of the chat-stream signal — the
            // agent produced a non-scalar analytical table but the safety
            // contract suppressed the pivot (too many fields, alias-only
            // values, etc.). Tell the client to render the elegant "pivot
            // unavailable" fallback in the intermediate's Pivot tab.
            const intermediateUnavailable =
              !isDataPrep
              && !hasPivotHint
              && !executionScalar
              && intermediateRows.length > 1;
            // Wave P1 · Decide whether to embed the agent's result rows on
            // pivotDefaults so the pivot UI can render computed-alias
            // columns (e.g. `aov`, `avg_daily_sales`) that don't exist on
            // the base `data` table. Gate:
            //   - tool is execute_query_plan
            //   - trace plan has `computedAggregations` with at least one alias
            //   - result is non-scalar (rows.length > 0 after pivot hints)
            //   - result row count ≤ PIVOT_AGENT_RESULT_MAX_ROWS (200 today)
            // When ALL of these hold, the pivot UI switches to the
            // `dataSource: "agent_result"` path: it aggregates the embedded
            // rows in-memory rather than re-querying base data. Closes the
            // QL9.A non-scalar gap pinned in pivotDefaultsRatioShapeQL9.
            const computedAggsOnTrace =
              tracePlan &&
              typeof tracePlan === "object" &&
              Array.isArray(
                (tracePlan as QueryPlanBody).computedAggregations
              ) &&
              ((tracePlan as QueryPlanBody).computedAggregations?.length ?? 0) > 0;
            const eligibleForAgentResultRender =
              hasPivotHint &&
              step.tool === "execute_query_plan" &&
              computedAggsOnTrace &&
              intermediateRows.length > 0 &&
              intermediateRows.length <= PIVOT_AGENT_RESULT_MAX_ROWS &&
              !executionScalar;
            // When eligible, also UNION any computed-alias columns that
            // the standard merge dropped via PVT2 (alias not in
            // dataSummary.numericColumns) back into the values list. The
            // pivot's agent-result branch operates on the embedded rows,
            // so alias columns no longer crash the SQL build.
            let augmentedValues: string[] | undefined =
              pivotDefaults?.values;
            if (eligibleForAgentResultRender && computedAggsOnTrace) {
              const existing = new Set<string>(augmentedValues ?? []);
              const aliasNames = (
                (tracePlan as QueryPlanBody).computedAggregations ?? []
              )
                .map((c) => c?.alias)
                .filter(
                  (a): a is string => typeof a === "string" && a.length > 0
                );
              const resultCols = new Set<string>(
                intermediateColumnOrder ??
                  Object.keys(intermediateRows[0] ?? {})
              );
              const next = [...(augmentedValues ?? [])];
              // Remap source column names → alias names so values match
              // agentResultRows columns (which use aliases, not source names).
              const sourceToAlias = new Map<string, string>();
              for (const agg of (tracePlan as QueryPlanBody).aggregations ?? []) {
                const src = typeof agg?.column === "string" ? agg.column.trim() : "";
                const alias = typeof agg?.alias === "string" ? agg.alias.trim() : "";
                if (src && alias && src !== alias && resultCols.has(alias)) {
                  sourceToAlias.set(src, alias);
                }
              }
              for (let i = 0; i < next.length; i++) {
                const alias = sourceToAlias.get(next[i]!);
                if (alias && !existing.has(alias)) {
                  existing.delete(next[i]!);
                  next[i] = alias;
                  existing.add(alias);
                }
              }
              for (const a of aliasNames) {
                if (existing.has(a)) continue;
                if (!resultCols.has(a)) continue;
                next.push(a);
                existing.add(a);
              }
              augmentedValues = next;
              // Remap valueAggregators keys to match the aliased column names.
              if (pivotDefaults?.valueAggregators && sourceToAlias.size > 0) {
                const remapped: Record<string, PivotAggLiteral> = {};
                for (const [key, val] of Object.entries(pivotDefaults.valueAggregators)) {
                  remapped[sourceToAlias.get(key) ?? key] = val;
                }
                pivotDefaults = { ...pivotDefaults, valueAggregators: remapped };
              }
            }
            ctx.onIntermediateArtifact({
              // Smaller preview for data-prep status updates; the user just
              // needs to see the agent did something, not browse hundreds of
              // raw rows beneath the answer.
              preview: intermediateRows.slice(0, isDataPrep ? 5 : 50),
              insight,
              ...(hasPivotHint
                ? {
                    pivotDefaults: {
                      rows: pivotDefaults!.rows,
                      values: augmentedValues ?? pivotDefaults!.values,
                      ...(pivotDefaults!.columns?.length
                        ? { columns: pivotDefaults!.columns }
                        : {}),
                      ...(pivotDefaults!.filterFields?.length
                        ? { filterFields: pivotDefaults!.filterFields }
                        : {}),
                      ...(pivotDefaults!.filterSelections &&
                      Object.keys(pivotDefaults!.filterSelections).length
                        ? {
                            filterSelections: pivotDefaults!.filterSelections,
                          }
                        : {}),
                      // Wave PAG1 · forward per-column aggregator hints so the
                      // intermediate-card pivot's value chip is pre-set to the
                      // agent's actual aggregation function (Mean for "average
                      // X per Y" questions) instead of defaulting to Sum.
                      ...(pivotDefaults!.valueAggregators &&
                      Object.keys(pivotDefaults!.valueAggregators).length
                        ? {
                            valueAggregators:
                              pivotDefaults!.valueAggregators,
                          }
                        : {}),
                      // Wave P1 · agent-result render path. Embeds the
                      // result rows so the pivot can show computed
                      // aliases that aren't on the base table.
                      ...(eligibleForAgentResultRender
                        ? {
                            dataSource: "agent_result" as const,
                            agentResultRows: intermediateRows,
                            ...(intermediateColumnOrder?.length
                              ? { agentResultColumns: intermediateColumnOrder }
                              : {}),
                          }
                        : {}),
                    },
                  }
                : {}),
              ...(executionScalar ? { executionScalar: true } : {}),
              ...(intermediateUnavailable ? { pivotUnavailable: true } : {}),
            });
            // AMR3 · capture the aggregated pivot result for cross-session
            // recall. Only `execute_query_plan` steps with a real pivot shape
            // (rows OR values populated) — data-prep tools, scalar aggregates,
            // and "pivot unavailable" outputs would never benefit from recall.
            // Stored on `ctx.pivotArtifactsBuffer` (allocated lazily); drained
            // at the end of `runAgentTurn` onto `AgentLoopResult.pivotArtifacts`
            // for the chatStream service to materialize + patch.
            if (
              step.tool === "execute_query_plan" &&
              hasPivotHint &&
              pivotDefaults &&
              tracePlan &&
              typeof tracePlan === "object"
            ) {
              ctx.pivotArtifactsBuffer ??= [];
              ctx.pivotArtifactsBuffer.push({
                sessionId: ctx.sessionId,
                turnId,
                stepId: step.id,
                plan: tracePlan as unknown as Record<string, unknown>,
                pivotDefaults: {
                  ...(pivotDefaults.rows?.length ? { rows: pivotDefaults.rows } : {}),
                  ...(pivotDefaults.values?.length
                    ? { values: pivotDefaults.values }
                    : {}),
                  ...(pivotDefaults.columns?.length
                    ? { columns: pivotDefaults.columns }
                    : {}),
                  ...(pivotDefaults.filterFields?.length
                    ? { filterFields: pivotDefaults.filterFields }
                    : {}),
                  ...(pivotDefaults.filterSelections &&
                  Object.keys(pivotDefaults.filterSelections).length
                    ? { filterSelections: pivotDefaults.filterSelections }
                    : {}),
                  ...(pivotDefaults.valueAggregators &&
                  Object.keys(pivotDefaults.valueAggregators).length
                    ? { valueAggregators: pivotDefaults.valueAggregators }
                    : {}),
                },
                columnHeaders: intermediateColumnOrder ?? Object.keys(intermediateRows[0] ?? {}),
                rows: intermediateRows,
                questionContext: insight?.slice(0, 240),
              });
            }
          }
        }

        if (
          stepResult.ok &&
          stepResult.table &&
          Array.isArray(stepResult.table.rows) &&
          stepResult.table.rows.length > 0 &&
          (step.tool === "run_analytical_query" ||
            step.tool === "execute_query_plan" ||
            step.tool === "derive_dimension_bucket" ||
            step.tool === "add_computed_columns" ||
            step.tool === "run_readonly_sql" ||
            // RNK-chart · ranking results are a clean entity×metric frame
            // (already trimmed to topN by the tool). Route them through
            // `lastAnalyticalTable` so the chart-promotion + visual-planner
            // fallback can auto-build a bar chart for "top performers" answers.
            step.tool === "run_breakdown_ranking")
        ) {
          const analyticalRows = stepResult.table.rows as Record<string, unknown>[];
          // Wave C1 · `AGENT_IMMUTABLE_CTX_DATA` (default ON for new turns)
          // routes aggregate output through `lastAnalyticalTable` only,
          // leaving `ctx.data` pointing at the original row-level frame.
          // Removes the silent narrowing where chained tools after a
          // groupby saw aggregates instead of raw rows. Default is ON; set
          // env var to "false" to fall back to legacy behaviour.
          const immutable =
            (process.env.AGENT_IMMUTABLE_CTX_DATA ?? "true").toLowerCase() !==
            "false";
          if (!immutable) {
            ctx.data = analyticalRows;
          }
          ctx.lastAnalyticalTable = {
            rows: analyticalRows,
            columns: rowKeysFromFirstRow(analyticalRows),
            sourceTool: step.tool,
          };

          // Promote successful execute_query_plan / run_analytical_query
          // results into final-message charts so the rendered answer surfaces
          // every breakdown the agent ran, not just the one the planner
          // explicitly built. Dedupes by axis-signature against existing
          // mergedCharts. Final cap applied later via finalizeMergedCharts.
          // Env gate: AGENT_PROMOTE_INTERMEDIATE_CHARTS (default true).
          // Wave (ARCH-1/CQ-1) · extracted VERBATIM to ./agentLoop/
          // promoteChartPhase.ts; mutates the SAME `state.mergedCharts` array
          // the loop destructured from `state`.
          promoteIntermediateAnalyticalChart(state, ctx, step.tool, finalCallId, turnId);
        }

        if (stepResult.ok && step.tool === "derive_dimension_bucket") {
          const neu = step.args.newColumnName;
          if (typeof neu === "string" && neu.trim()) {
            registerDerivedColumnOnSummary(ctx.summary, neu, ctx.data);
          }
        }

        if (stepResult.ok && step.tool === "add_computed_columns") {
          const parsedArgs = addComputedColumnsArgsSchema.safeParse(step.args);
          if (parsedArgs.success) {
            registerComputedColumnsOnSummary(ctx.summary, parsedArgs.data, ctx.data);
          }
        }

        for (const line of lintAfterAnalyticalTool({
          tool: step.tool,
          ok: stepResult.ok,
          question: ctx.question,
          parsed: stepResult.queryPlanParsed,
          outputRowCount:
            stepResult.table?.rowCount ?? stepResult.analyticalMeta?.outputRowCount,
          outputColumns: Array.isArray(stepResult.table?.columns)
            ? (stepResult.table.columns as string[])
            : undefined,
          appliedAggregation: stepResult.analyticalMeta?.appliedAggregation,
        })) {
          observations.push(line);
        }

        const finalTrimmed = finalCandidate.trimStart();
        // If the tool already produced a structured SYSTEM_VALIDATION line, keep it
        // intact so the reflector can reliably detect it.
        if (finalTrimmed.startsWith("[SYSTEM_VALIDATION]")) {
          observations.push(finalTrimmed);
        } else {
          observations.push(`[${step.tool}] ${finalCandidate}`);
        }
        // O5: prevent unbounded growth across replan loops.
        if (observations.length > 80) observations.splice(0, observations.length - 80);

        // O1: wire successful tool results into the shared blackboard so narrator,
        // convergence check, and context-agent Round 2 all have structured evidence.
        if (stepResult.ok && ctx.blackboard) {
          // Small aggregated results (e.g. a 24-row ASM ranking) get a larger
          // detail budget so the full "Sample:" JSON isn't cut mid-array — the
          // narrator can then state the complete ranking instead of hedging
          // "only partially shown". Larger/raw results keep the tight 800-char
          // cap (they ride on the structured-observation rows surfaced by W1).
          const lowCardAgg =
            stepResult.analyticalMeta?.appliedAggregation === true &&
            typeof stepResult.analyticalMeta?.outputRowCount === "number" &&
            stepResult.analyticalMeta.outputRowCount <= 50;
          const finding = addFinding(ctx.blackboard, {
            sourceRef: finalCallId,
            label: `${step.tool}: ${String(step.args?.metrics ?? step.args?.groupBy ?? step.args?.columns ?? "").slice(0, 80)}`.trim(),
            detail: (stepResult.summary ?? "").slice(0, lowCardAgg ? 3000 : 800),
            significance: detectSignificance(stepResult.summary ?? ""),
            relatedColumns: stepResult.suggestedColumns ?? [],
          });
          // O2: if the planner bound this step to a hypothesis, resolve it now.
          // Multiple hypotheses can be linked when coalesceQueryPlanSteps merged
          // same-shape steps; resolve each one against the same finding.
          {
            const sig = finding.significance;
            const status = sig === "anomalous" ? "confirmed" : "partial";
            const linkedHypIds: string[] =
              step.hypothesisIds && step.hypothesisIds.length > 0
                ? step.hypothesisIds
                : step.hypothesisId
                  ? [step.hypothesisId]
                  : [];
            for (const hid of linkedHypIds) {
              resolveHypothesis(ctx.blackboard, hid, status, finding.id);
            }
          }
          // Wave B4 · structured finding side-channel. Carries claim/evidence/
          // magnitude/confidence so narrator + verifier can read typed state
          // instead of summarising-the-summary. Best-effort: bound to the same
          // legacy finding via shared id so cross-references stay aligned.
          {
            const lastObs =
              structuredObservations.length > 0
                ? structuredObservations[structuredObservations.length - 1]
                : undefined;
            const sf: import("./investigationState.js").StructuredFinding = {
              id: finding.id,
              claim: stepResult.summary?.slice(0, 600) ?? finding.label,
              hypothesisId: step.hypothesisId,
              significance: finding.significance,
              confidence: pickFindingConfidence(stepResult, finding.significance),
              sources: [step.id],
              evidence: {
                queries: [
                  {
                    stepId: step.id,
                    tool: step.tool,
                    query:
                      typeof step.args?.plan === "string"
                        ? (step.args.plan as string).slice(0, 1000)
                        : JSON.stringify(step.args ?? {}).slice(0, 1000),
                  },
                ],
                rowRefs:
                  stepResult.analyticalMeta?.outputRowCount
                    ? [
                        {
                          count: stepResult.analyticalMeta.outputRowCount,
                          producedByStepId: step.id,
                          sample: Array.isArray(
                            (stepResult.table as { rows?: Record<string, unknown>[] } | undefined)
                              ?.rows
                          )
                            ? ((stepResult.table as { rows: Record<string, unknown>[] }).rows.slice(
                                0,
                                5
                              ) as Record<string, unknown>[])
                            : undefined,
                        },
                      ]
                    : [],
                stats: extractStatsFromNumericPayload(stepResult.numericPayload, step.tool),
              },
              magnitude: extractMagnitudeFromSummary(stepResult.summary, stepResult.numericPayload),
              relatedColumns: stepResult.suggestedColumns ?? [],
              createdAt: Date.now(),
            };
            structuredFindings.push(sf);
            if (lastObs) lastObs.findingIds.push(sf.id);
            // Wave B10 · inconsistency watcher: cross-check against existing
            // findings on the same metric/scope, flag contradictions for the
            // reflector to investigate. Pure function, fires synchronously.
            try {
              const contradictions = detectContradictions(sf, structuredFindings);
              for (const c of contradictions) turnContradictions.push(c);
            } catch {
              /* watcher is best-effort */
            }
            // Wave C2 · magnitude ground-truth audit. Best-effort, async,
            // bounded to ~10 audits per turn. Drift > 5% downgrades the
            // finding's confidence so narrator caveats reflect reality.
            if (sf.magnitude) {
              void (async () => {
                try {
                  const audit = await auditMagnitude(ctx, sf);
                  if (audit) {
                    magnitudeAudits.push(audit);
                    if (audit.status === "drift") {
                      sf.confidence = "low";
                    }
                  }
                } catch {
                  /* swallow; audit is best-effort */
                }
              })();
            }
          }
        }

        workingMemory.push({
          callId: finalCallId,
          tool: step.tool,
          ok: stepResult.ok,
          summaryPreview: stepResult.summary,
          suggestedColumns: stepResult.suggestedColumns,
          slots: stepResult.memorySlots,
        });

        // W1: Skip the per-step reflector for non-terminal parallel group members.
        // The last step in the group runs the reflector with all accumulated observations.
        if (!skipReflectorStepIds.has(step.id)) {
          const refDigest =
            isInterAgentPromptFeedbackEnabled() && trace.interAgentMessages?.length
              ? formatInterAgentHandoffsForPrompt(trace.interAgentMessages, 3500)
              : undefined;
          // P-A3: aggregate distinct suggested columns from prior successful
          // tool calls so the reflector can see what's already been explored.
          const workingMemorySuggestedColumns = Array.from(
            new Set(
              workingMemory
                .filter((e) => e.ok && Array.isArray(e.suggestedColumns))
                .flatMap((e) => e.suggestedColumns ?? [])
            )
          );
          const ref = await runReflector(
            ctx,
            {
              observations,
              lastTool: step.tool,
              lastOk: stepResult.ok,
              lastAnalyticalMeta:
                step.tool === "run_analytical_query" ||
                step.tool === "execute_query_plan"
                  ? stepResult.analyticalMeta
                  : undefined,
              workingMemorySuggestedColumns,
              // Wave B6 · in-turn verdict history so the reflector can
              // detect repetition + verifier patterns.
              priorReflectorVerdicts: reflectorVerdicts,
              priorVerifierVerdicts: verifierVerdicts,
            },
            turnId,
            onLlmCall,
            refDigest
          );
          trace.reflectorNotes.push(ref.action + (ref.note ? `: ${ref.note}` : ""));
          // Wave A4 · debounced mid-turn checkpoint: snapshot the running
          // agentInternals to `chatDocument.currentTurnCheckpoint` so a
          // mid-turn process crash leaves a partial answer the next session
          // load can render. Best-effort, non-blocking, debounced (3s).
          // Wave (ARCH-1/CQ-1) · extracted VERBATIM to ./agentLoop/checkpointPhase.ts;
          // mirror the `let stepsWalked` local onto state.stepsWalked so the
          // phase reads the live count (the array accumulators it reads are the
          // SAME instances destructured from `state`).
          state.stepsWalked = stepsWalked;
          persistTurnCheckpoint(state, ctx, trace.startedAt);
          // Wave A2 · structured reflector verdict for agentInternals.
          reflectorVerdicts.push({
            stepIndex: stepsWalked,
            action: ref.action as
              | "continue"
              | "finish"
              | "replan"
              | "clarify"
              | "investigate_gap",
            rationale: ref.note ?? "(no rationale)",
            suggestedQuestions: ref.spawnedQuestions?.map((q) => q.question),
            gapFill: (ref as { gapFill?: { hypothesisId?: string; tool?: string; rationale?: string } })
              .gapFill?.tool
              ? {
                  hypothesisId: (ref as { gapFill?: { hypothesisId?: string } }).gapFill
                    ?.hypothesisId,
                  tool: (ref as { gapFill?: { tool: string } }).gapFill!.tool,
                  rationale: (ref as { gapFill?: { rationale?: string } }).gapFill?.rationale,
                }
              : undefined,
          });
          // W8: collect sub-questions emitted by the reflector.
          // MW1 · the single chokepoint — drop random-sample / duplicate /
          // per-identifier-grouping chips before they are accumulated or
          // streamed to the UI ("Investigating further"). "Never show random
          // samples" is a hard rule, enforced here deterministically.
          const cleanedSpawned = filterSpawnedQuestions(ref.spawnedQuestions ?? [], {
            priorQuestions: accumulatedSpawnedQuestions.map((q) => q.question),
            excludedColumns: ctx.summary.columns.map((c) => c.name),
          });
          if (cleanedSpawned.length) {
            // Stamp a stable UUID on every spawned question so per-question
            // feedback (thumbs up/down) can target it across reorders/edits.
            const stamped = cleanedSpawned.map((sq) => ({
              ...sq,
              id: sq.id ?? randomUUID(),
              suggestedColumns: sq.suggestedColumns ?? [],
            }));
            for (const sq of stamped) {
              accumulatedSpawnedQuestions.push(sq);
              // O1: persist spawned questions to the blackboard so convergence
              // and context-agent Round 2 can see open investigative threads.
              if (ctx.blackboard) {
                addOpenQuestion(ctx.blackboard, sq.question, sq.spawnReason ?? "", { priority: sq.priority ?? "medium" });
              }
            }
            // SSE payload carries the new {id, question}[] shape alongside the
            // legacy `questions: string[]` field so older clients still render.
            safeEmit("sub_question_spawned", {
              questions: stamped.map((q) => q.question),
              spawnedQuestions: stamped.map((q) => ({ id: q.id, question: q.question })),
            });
          }
          appendInterAgentMessage(
            trace,
            {
              from: "Reflector",
              to: "Coordinator",
              intent: `reflector_${ref.action}`,
              evidenceRefs: [step.id, finalCallId],
              meta: {
                stepId: step.id,
                tool: step.tool,
                note: (ref.note ?? "").slice(0, 200),
              },
            },
            safeEmit
          );

          if (ref.action === "finish") {
            const remaining = plan.steps.length - si - 1;
            if (remaining > 0) {
              trace.reflectorNotes.push(`finish_overridden: ${remaining} step(s) remain`);
            } else {
              stopEarly = true;
              break;
            }
          } else if (ref.action === "clarify" && ref.clarify_message) {
            appendInterAgentMessage(
              trace,
              {
                from: "Reflector",
                to: "Coordinator",
                intent: "clarify_user",
                evidenceRefs: [step.id, finalCallId],
                blockingQuestions: [ref.clarify_message.slice(0, 320)],
                meta: { stepId: step.id },
              },
              safeEmit
            );
            trace.endedAt = Date.now();
            materializeDeferredBuildCharts(ctx, deferredPlanCharts, mergedCharts);
            return {
              answer: ref.clarify_message,
              charts: mergedCharts.length ? mergedCharts : undefined,
              insights: mergedInsights.length ? mergedInsights : undefined,
              agentTrace: capAgentTrace(trace),
              lastAnalyticalRowsForEnrichment: lastAnalyticalRowsSnapshot(ctx),
              ...briefOut(),
      ...appliedFiltersOut(),
      ...intentEnvelopeOut(),
            };
          } else if (ref.action === "replan") {
            // Single-flow policy: replan is suppressed; continue with the
            // original plan. Reflector's note is preserved in the trace and
            // emitted as a flow_decision so the suggestion is still visible.
            appendInterAgentMessage(
              trace,
              {
                from: "Reflector",
                to: "Planner",
                intent: "replan_suggested_suppressed",
                evidenceRefs: [step.id, finalCallId],
                meta: { afterStep: step.id, tool: step.tool, policy: "single-flow" },
              },
              safeEmit
            );
            safeEmit("flow_decision", {
              layer: "reflector-replan",
              chosen: "continue-as-planned",
              reason: `Replan suggested but suppressed (single-flow policy). Reflector note: ${(
                ref.note ?? "(none)"
              ).slice(0, 350)}`.slice(0, 500),
              candidates: plan.steps.slice(0, 8).map((s) => `${s.id}:${s.tool}`),
            });
            trace.reflectorNotes.push(`replan_suppressed: ${ref.note ?? "(none)"}`);
          } else if (ref.action === "investigate_gap" && ref.gapFill) {
            // W11: inject a targeted tool step to fill an uncovered hypothesis.
            const gf = ref.gapFill;
            const gapStepId = `gap_${gf.hypothesisId}_${Date.now()}`;
            // W12a: use explicit args when provided; otherwise derive
            // question_override from hypothesis text so the tool targets the
            // specific gap rather than repeating the original question.
            const gapHypothesis = ctx.blackboard?.hypotheses.find(
              (h) => h.id === gf.hypothesisId
            );
            const fallbackGapArgs: Record<string, unknown> =
              gf.tool === "execute_query_plan"
                ? {}
                : { question_override: gapHypothesis?.text ?? gf.rationale };
            const gapStep: PlanStep = {
              id: gapStepId,
              tool: gf.tool,
              args: gf.args ?? fallbackGapArgs,
              hypothesisId: gf.hypothesisId,
            };
            plan.steps.splice(si + 1, 0, gapStep);
            appendInterAgentMessage(
              trace,
              {
                from: "Reflector",
                to: "Coordinator",
                intent: "investigate_gap",
                evidenceRefs: [step.id],
                meta: { hypothesisId: gf.hypothesisId, tool: gf.tool, gapStepId },
              },
              safeEmit
            );
            trace.reflectorNotes.push(`investigate_gap: hypothesis=${gf.hypothesisId} via ${gf.tool}`);
          }
        }
      }

      if (stopEarly) {
        break;
      }
      if (replans > 0 && observations.length > 0) {
        /* replan loop continues */
        continue;
      }
      break;
    }

    // Spawned-question follow-up pass (flag-gated · invariant #6). The plan loop
    // is done, so the reflector's "Investigating further" sub-questions are known.
    // With SPAWNED_FOLLOWUP_ENABLED on, investigate each as a bounded sub-turn
    // that SHARES this blackboard (findings flow into the one synthesis below) and
    // whose charts join mergedCharts (→ response chart cards AND dashboard tiles).
    // No cap on the number of sub-questions — only an aggregate LLM/wall budget.
    // The recursion guard (ctx.suppressSpawnedFollowUp, set on every sub-turn)
    // stops a sub-turn from spawning its own pass. Runs BEFORE RAG Round 2 so
    // Round 2 derives queries from the combined (incl. sub-investigation) findings.
    if (
      shouldRunSpawnedFollowUp(isSpawnedFollowUpEnabled(), {
        // Depth-budget gate (query-intent authority): never auto-investigate
        // spawned sub-questions for a plain lookup / direct factual ask.
        suppress: ctx.suppressSpawnedFollowUp || minimalDepth,
        mode: ctx.mode,
        questionCount: accumulatedSpawnedQuestions.length,
      })
    ) {
      try {
        safeEmit("flow_decision", {
          layer: "spawned-followup",
          chosen: "investigate",
          overriddenBy: "SPAWNED_FOLLOWUP_ENABLED",
          reason: `Auto-investigating ${accumulatedSpawnedQuestions.length} spawned sub-question(s); folding their charts + findings into one coherent answer.`.slice(
            0,
            500
          ),
          candidates: accumulatedSpawnedQuestions
            .slice(0, 8)
            .map((q) => q.question.slice(0, 200)),
        });
        const { runSpawnedFollowUpPass } = await import("./spawnedFollowUpPass.js");
        const pass = await runSpawnedFollowUpPass(
          ctx,
          accumulatedSpawnedQuestions,
          safeEmit
        );
        // Primary charts were pushed first (above); append sub-charts so the
        // dedupe/cap in finalizeMergedCharts keeps primary charts on collision.
        if (pass.charts.length) mergedCharts.push(...pass.charts);
        // Capture the investigated set for persistence (durable "Investigated"
        // badge on reload). Only entries with a stable id are useful to the UI.
        for (const inv of pass.investigated) {
          if (typeof inv.id === "string" && inv.id) {
            investigatedSubQuestionsOut.push({
              id: inv.id,
              question: inv.question,
              chartCount: inv.chartCount,
            });
          }
        }
        // B5 — weave each investigated sub-question's answer into the SHARED
        // blackboard as a provenance-tagged finding, BEFORE the narrator runs
        // below. Previously `pass.investigated[]` was only logged (a count), so
        // the investigation was invisible in the answer prose: the sub-turn's
        // raw tool findings reached the blackboard but carried no "this came
        // from an Investigating-further chip" signal, so the narrator never
        // mentioned it. This gives the ONE final synthesis an explicit,
        // attributed record of each sub-investigation's conclusion.
        if (ctx.blackboard) {
          for (const inv of pass.investigated) {
            const summary = (inv.answer ?? "").trim();
            if (!summary) continue;
            addFinding(ctx.blackboard, {
              sourceRef: `investigated_${inv.id ?? "sub"}`,
              label: `Investigated follow-up: ${inv.question}`.slice(0, 120),
              detail: summary.slice(0, 1200),
              // "notable" so it ranks above routine tool findings in
              // formatForNarrator without masquerading as an anomaly.
              significance: "notable",
            });
          }
        }
        agentLog("spawnedFollowUp.merged", {
          turnId,
          investigated: pass.investigated.length,
          chartsAdded: pass.charts.length,
          llmCalls: pass.llmCalls,
          budgetHalted: pass.budgetHalted,
        });
      } catch (e) {
        // Best-effort — a failed follow-up pass must never break the main answer.
        agentLog("spawnedFollowUp.pass_failed", {
          turnId,
          error: errorMessage(e),
        });
      }
    }

    // W4: RAG Round 2 — derive queries from blackboard findings and retrieve
    // additional domain context before synthesis. Non-fatal; runs once per turn.
    if (ctx.blackboard && ctx.mode === "analysis") {
      await runContextAgentRound2(ctx, ctx.blackboard, turnId);
    }

    // W-QL-FIX2 · fire-and-forget: the session-context merge inside
    // maybeMidTurn includes an LLM call + CosmosDB RMW (~24s observed).
    // Narrator reads `observations[]` + `blackboard`, not session context,
    // so this bookkeeping doesn't need to block synthesis.
    void maybeMidTurn({
      phase: "pre_synthesis",
      bypassThrottle: true,
      ok: true,
      summary: buildPreSynthesisMidTurnSummary(ctx, trace, observations, mergedCharts),
    });

    // W3 · `answerSource` flags whether `answer` is a real LLM-authored
    // narrative (`narrator` / `synthesizer`) or a deterministic placeholder
    // (`fallback`). W4 uses this to skip the final verifier on placeholders;
    // W5 logs it as telemetry. Default to `delegate` because that's the
    // tool-handed-off case (delegateAnswer non-empty above this block).
    let answerSource: "delegate" | "narrator" | "synthesizer" | "fallback" =
      "delegate";

    let answer = delegateAnswer || "";
    if (!answer && observations.length > 0) {
      try {
        // W5: narrator-first path when the blackboard has structured findings;
        // falls back to the existing synthesizer when blackboard is empty.
        const useNarrator =
          ctx.blackboard && shouldUseNarrator(ctx.blackboard) && ctx.mode === "analysis";

        let envKeyInsight: string | null | undefined;
        let envCtas: string[] = [];
        let envMagnitudes: typeof envelopeMagnitudes;
        let envUnexplained: string | undefined;

        if (useNarrator) {
          // W38 + W41 · attach a streaming hook so the narrator can
          // stream the partial response to the client via `answer_chunk`
          // SSE events. The hook fires only when
          // STREAMING_NARRATOR_ENABLED=true (gated inside
          // `completeJsonStreaming`); otherwise the call falls through
          // to non-streaming with zero behaviour change. Repair calls
          // (W17/W22/W35/W43) never receive the hook — they stay
          // non-stream.
          //
          // W41 · the hook now runs each delta through a
          // `JsonFieldStreamExtractor` keyed on the narrator's `body`
          // field. The client receives ONLY the decoded prose text,
          // not the surrounding JSON tokens. The extractor is safe by
          // design — it never throws and emits "" on any confusion,
          // so the W38 fallback to non-streaming on schema-failure is
          // still the correctness backstop.
          const bodyExtractor = new JsonFieldStreamExtractor("body");
          safeEmit("thinking", {
            step: "Synthesizing answer",
            status: "active",
            timestamp: Date.now(),
          });
          let firstChunkSeen = false;
          const narResult = await runNarrator(
            ctx,
            ctx.blackboard!,
            turnId,
            onLlmCall,
            undefined,
            {
              onPartial: ({ delta }) => {
                if (!delta) return;
                const cleaned = bodyExtractor.process(delta);
                if (cleaned) {
                  if (!firstChunkSeen) {
                    firstChunkSeen = true;
                    safeEmit("thinking", {
                      step: "Synthesizing answer",
                      status: "completed",
                      timestamp: Date.now(),
                    });
                  }
                  safeEmit("answer_chunk", { delta: cleaned });
                }
              },
            },
            // G4-P5 · structured per-step tool I/O so the narrator's
            // data-understanding block can list each step's tool, args, row
            // count. Distinguishes "step queried whole dataset" from "step
            // filtered to a subset" — fixes the "data is incomplete" hallucination.
            structuredObservations
          );
          if (!firstChunkSeen) {
            safeEmit("thinking", {
              step: "Synthesizing answer",
              status: "completed",
              timestamp: Date.now(),
            });
          }
          if (narResult) {
            // formatAnswerFromEnvelope signature is already in scope
            answer = formatAnswerFromEnvelope(narResult.body ?? "", narResult.keyInsight ?? null);
            envKeyInsight = narResult.keyInsight ?? undefined;
            envCtas = (narResult.ctas ?? []).map((c) => c.trim()).filter(Boolean).slice(0, 3);
            envMagnitudes = narResult.magnitudes;
            envUnexplained = narResult.unexplained;
            if (answer.trim()) answerSource = "narrator";
            // W5 + W8 · synthesis telemetry — narrator branch. W8 adds
            // bodyWordCount / implicationsCount / recommendationsCount /
            // domainLensLen so we can confirm the new envelope sections are
            // actually being produced post-rollout.
            agentLog("synthesis_result", {
              turnId,
              source: "narrator",
              answerLen: answer.length,
              bodyWordCount: countWords(narResult.body ?? ""),
              keyInsightLen: narResult.keyInsight?.length ?? 0,
              ctaCount: narResult.ctas?.length ?? 0,
              magnitudesCount: narResult.magnitudes?.length ?? 0,
              implicationsCount: narResult.implications?.length ?? 0,
              recommendationsCount: narResult.recommendations?.length ?? 0,
              domainLensLen: narResult.domainLens?.length ?? 0,
              questionShape: ctx.analysisBrief?.questionShape ?? "none",
              observationsCount: observations.length,
              observationsTotalLen: observations.reduce(
                (n, o) => n + (o?.length ?? 0),
                0
              ),
            });
            // W3 + W8 · capture the structured AnswerEnvelope. W8 adds
            // implications, recommendations, and domainLens so the AnswerCard
            // can render decision-grade sections.
            const env: NonNullable<import("../../../shared/schema.js").Message["answerEnvelope"]> = {};
            if (narResult.tldr) env.tldr = narResult.tldr;
            if (narResult.findings?.length) env.findings = narResult.findings;
            if (narResult.methodology) env.methodology = narResult.methodology;
            if (narResult.caveats?.length) env.caveats = narResult.caveats;
            // PA1 · surface deterministic-guard caveats (e.g. period-additivity
            // pinned the SUM to the latest 12 months) so the chosen slice is visible.
            if (ctx.deterministicCaveats?.length)
              env.caveats = [...(env.caveats ?? []), ...ctx.deterministicCaveats];
            // PVT3 · for direct factual questions ("What is the average X per
            // Y?", "Which Z has the most W?"), drop the narrator's
            // recommendations + suggested next-steps — the user's rule "if
            // user asks a direct quest, no need to go for further
            // investigation". Implications stay (those are findings, not
            // action prompts). Diagnostic / strategy questions retain the
            // full envelope.
            const suppressFollowUps = minimalDepth;
            if (envCtas.length && !suppressFollowUps) env.nextSteps = envCtas;
            if (narResult.implications?.length) env.implications = narResult.implications;
            if (narResult.recommendations?.length && !suppressFollowUps) {
              env.recommendations = narResult.recommendations;
            }
            if (narResult.domainLens) env.domainLens = narResult.domainLens;
            // W-CP1 · the hedged "Why this might be happening" lane. Sanitize at
            // emit (drop unhedged / number-bearing drivers, demote falsely
            // data-grounded ones) so a bad mechanism can never persist even if it
            // slipped past the model and the verifier. Available at ALL depths —
            // a minimal lookup still gets a tight causal "why" when one exists.
            {
              const drivers = sanitizeLikelyDrivers(
                narResult.likelyDrivers,
                ctx.summary.columns.map((c) => c.name)
              );
              if (drivers.length) env.likelyDrivers = drivers;
            }
            // W54 · deterministic recommendations + magnitudes when the
            // run_budget_optimizer tool produced a payload. The numbers must
            // come from the optimizer, not the LLM, so we override.
            if (isBudgetRedistributeOperationResult(operationResult)) {
              const payload = operationResult.payload;
              env.recommendations = buildRecommendationsFromBudgetOptimizer(payload);
              if (!env.domainLens) env.domainLens = buildDomainLensFromBudgetOptimizer(payload);
              const detMags = buildMagnitudesFromBudgetOptimizer(payload);
              envMagnitudes = [...detMags, ...(envMagnitudes ?? [])].slice(0, 6);
            }
            if (Object.keys(env).length) envelopeAnswerEnvelope = env;
          }
        }

        // Fallback: use existing synthesizer when narrator was skipped or returned null.
        // O4: prepend blackboard narrative block so synthesizer sees structured findings.
        if (!answer) {
          checkAbort("pre-synthesis");
          const synthObservations =
            ctx.blackboard && ctx.blackboard.findings.length > 0
              ? [`[BLACKBOARD]\n${formatForNarrator(ctx.blackboard, ctx.contextTrimmedSink).slice(0, 3000)}`, ...observations]
              : observations;
          const env = await synthesizeFinalAnswerEnvelope(
            ctx,
            synthObservations,
            turnId,
            onLlmCall,
            upfrontRagHitsBlock
          );
          answer = env.answer;
          agentSuggestionHints = env.suggestionHints;
          envKeyInsight = env.keyInsight;
          envCtas = (env.ctas ?? []).map((c) => c.trim()).filter(Boolean).slice(0, 3);
          envMagnitudes = env.magnitudes;
          envUnexplained = env.unexplained;
          // W3 · `fallback_dump` means the LLM paths all failed and the
          // clean renderer produced a markdown table. Anything else
          // (json_envelope, narrative_retry, plain_text_retry) is a real
          // synthesized narrative.
          answerSource = env.source === "fallback_dump" ? "fallback" : "synthesizer";
          // W8 · synthesizer also produces decision-grade envelope sections —
          // capture them so the AnswerCard renders the same shape regardless
          // of which writer ran. Skipped on `fallback_dump` (deterministic
          // markdown table; no envelope to surface).
          if (env.source !== "fallback_dump") {
            const synthEnv: NonNullable<
              import("../../../shared/schema.js").Message["answerEnvelope"]
            > = {};
            // PVT3 · same direct-factual gate as the narrator branch — strip
            // recommendations + nextSteps for plain "what is X" questions.
            const suppressFollowUps = minimalDepth;
            if (envCtas.length && !suppressFollowUps) synthEnv.nextSteps = envCtas;
            if (env.implications?.length) synthEnv.implications = env.implications;
            if (env.recommendations?.length && !suppressFollowUps) {
              synthEnv.recommendations = env.recommendations;
            }
            if (env.domainLens) synthEnv.domainLens = env.domainLens;
            // W-CP1 · synthesizer-fallback path emits the same sanitized causal
            // lane so the AnswerCard "Why" section renders identically.
            {
              const drivers = sanitizeLikelyDrivers(
                env.likelyDrivers,
                ctx.summary.columns.map((c) => c.name)
              );
              if (drivers.length) synthEnv.likelyDrivers = drivers;
            }
            // W54 · same deterministic override as the narrator branch — the
            // synthesizer fallback path also needs optimizer-derived numbers.
            if (isBudgetRedistributeOperationResult(operationResult)) {
              const payload = operationResult.payload;
              synthEnv.recommendations = buildRecommendationsFromBudgetOptimizer(payload);
              if (!synthEnv.domainLens)
                synthEnv.domainLens = buildDomainLensFromBudgetOptimizer(payload);
              const detMags = buildMagnitudesFromBudgetOptimizer(payload);
              envMagnitudes = [...detMags, ...(envMagnitudes ?? [])].slice(0, 6);
            }
            if (Object.keys(synthEnv).length) envelopeAnswerEnvelope = synthEnv;
          }
          // W5 + W8 · synthesis telemetry. When a fallback fires in production we
          // need to know which retry path failed and what the LLM produced
          // (or didn't) to fix the prompt at its source. W8 adds the same
          // depth-of-answer counters as the narrator branch.
          agentLog("synthesis_result", {
            turnId,
            source: env.source,
            answerLen: env.answer.length,
            bodyWordCount: countWords(env.answer),
            keyInsightLen: env.keyInsight?.length ?? 0,
            ctaCount: env.ctas?.length ?? 0,
            magnitudesCount: env.magnitudes?.length ?? 0,
            implicationsCount: env.implications?.length ?? 0,
            recommendationsCount: env.recommendations?.length ?? 0,
            domainLensLen: env.domainLens?.length ?? 0,
            questionShape: ctx.analysisBrief?.questionShape ?? "none",
            observationsCount: synthObservations.length,
            observationsTotalLen: synthObservations.reduce(
              (n, o) => n + (o?.length ?? 0),
              0
            ),
          });
        }

        // Depth-budget gate: a minimal-depth ask must not leak next-step chips
        // via the parallel `followUpPrompts` field even though `env.nextSteps`
        // was already suppressed above. This is the seam the suppression rule
        // previously lost on (the chips re-reached the client here).
        if (envCtas.length && !minimalDepth) followUpPrompts = envCtas;
        if (!agentSuggestionHints.length) {
          agentSuggestionHints = [...envCtas, ...(envKeyInsight ? [envKeyInsight] : [])];
        }

        // PR 1.G — capture Phase-1 rich fields.
        if (envMagnitudes && envMagnitudes.length > 0) {
          envelopeMagnitudes = envMagnitudes;
          safeEmit("magnitudes", { items: envMagnitudes });
        }
        if (envUnexplained) {
          envelopeUnexplained = envUnexplained;
          safeEmit("unexplained", { note: envUnexplained });
        }
        // W-CW1 · the narrator's keyInsight restates the tldr / implications the
        // structured envelope already carries, and the "Key Insights" card is
        // suppressed whenever an answerEnvelope is present (MessageBubble). Only
        // seed the legacy InsightCard when there is NO envelope (synthesis-
        // fallback / legacy turns) AND the ask warrants the fuller output — so a
        // minimal lookup never gets a duplicate headline card.
        if (!minimalDepth && !envelopeAnswerEnvelope) {
          appendEnvelopeInsight(mergedInsights, envKeyInsight ?? undefined);
          seededKeyInsightText = envKeyInsight?.trim() || undefined;
        }
        appendInterAgentMessage(
          trace,
          {
            from: "Synthesizer",
            to: "Coordinator",
            intent: "answer_drafted",
            evidenceRefs: [useNarrator ? "narrator" : "synthesis"],
            meta: {
              ctas: String(envCtas.length),
              approxLen: String(answer.length),
            },
          },
          safeEmit
        );
      } catch (synErr) {
        const msg = errorMessage(synErr);
        agentLog("synthesis_error", { turnId, err: msg.slice(0, 300) });
        answer = observationsFallbackAnswer();
        answerSource = "fallback";
      }
    }

    // W17 · deterministic envelope-completeness retry. Sits BEFORE the deep
    // verifier loop and is independent of the single-flow policy that
    // suppresses LLM-judged narrative rewrites — completeness here is
    // objective (e.g. `implications.length < 2` is a fact, not an opinion).
    // Bounded by `maxVerifierRoundsFinal` so a stuck narrator can't loop.
    // questionShape is one of the analytical shapes when set; "none" is only
    // a sentinel inside the synthesis prompt (not the brief schema). Presence
    // alone is sufficient to flag the turn as analytical.
    if (
      answerSource === "narrator" &&
      ctx.blackboard &&
      envelopeAnswerEnvelope &&
      ctx.analysisBrief?.questionShape
    ) {
      const domainSupplied = Boolean(ctx.domainContext?.trim());
      // W22 · pack-id list extracted once from the supplied domain context;
      // the citation check (anti-hallucination) compares envelope citations
      // against this list. Empty when no domain context was supplied.
      const suppliedPackIds = extractSuppliedPackIds(ctx.domainContext);
      let completenessRound = 0;
      while (completenessRound < config.maxVerifierRoundsFinal) {
        // Run completeness first (W17), then citation validity (W22). Both
        // share the same repair budget so one round can fix either issue;
        // alternating issues over rounds is bounded by maxVerifierRoundsFinal.
        const completenessGap = checkEnvelopeCompleteness(
          envelopeAnswerEnvelope,
          ctx.analysisBrief.questionShape,
          domainSupplied
        );
        const citationGap = completenessGap.ok
          ? checkDomainLensCitations(envelopeAnswerEnvelope, suppliedPackIds)
          : { ok: true as const };
        // W35 · numerical-fabrication check on `magnitudes`. Same repair
        // pipeline as W17/W22; passes when fewer than 2 magnitudes are
        // unsupported (rounding-artefact tolerance baked in).
        // W43 · this fires whenever completeness passed (no longer
        // requires citation to pass too) so citation + magnitudes can
        // batch into one composite repair via the same round. Still
        // gated by completenessGap.ok because checking magnitudes on a
        // fields-missing envelope produces noise.
        const magnitudesGap = completenessGap.ok
          ? checkMagnitudesAgainstObservations(envelopeMagnitudes, {
              observations,
              ragBlock: upfrontRagHitsBlock,
              domainContext: ctx.domainContext,
            })
          : { ok: true as const };
        // Wave T3 · single-bucket trend safety net. Gated by completeness
        // so we don't double-correct a fields-missing envelope.
        const temporalGap = completenessGap.ok
          ? checkTemporalTrendBuckets(ctx.question, structuredObservations)
          : { ok: true as const };
        // Wave QL4 · "Aggregation question not addressed" safety net. Catches
        // the residual case where Wave QL2's deterministic synthesis floor
        // misfired (ambiguous column, unusual phrasing) and the narrator
        // still claims the answer is uncomputable for a question whose
        // columns clearly exist. Forces ONE repair round; if Wave QL2 fixes
        // the next plan attempt, the repaired narrator output won't trip
        // this gate again.
        const aggregationGap = completenessGap.ok
          ? (() => {
              const perXForGate = detectPerXIntent(ctx.question, ctx.summary);
              const multiPerForGate = detectMultiPerIntent(ctx.question, ctx.summary);
              const metricResolves = Boolean(
                resolveMetricColumnFromQuestion(ctx.question, ctx.summary)
              );
              const hasAggregationIntent =
                metricResolves &&
                (perXForGate !== null ||
                  multiPerForGate !== null ||
                  /\b(average|avg|mean|total|sum|count|max|maximum|highest|min|minimum|lowest)\b/i.test(
                    ctx.question
                  ));
              const ranExecuteQueryPlan = trace.toolCalls.some(
                (t) => t.name === "execute_query_plan" && t.ok
              );
              return checkAggregationQuestionAddressed(envelopeAnswerEnvelope, {
                question: ctx.question,
                ranExecuteQueryPlan,
                hasAggregationIntent,
              });
            })()
          : { ok: true as const };
        if (
          completenessGap.ok &&
          citationGap.ok &&
          magnitudesGap.ok &&
          temporalGap.ok &&
          aggregationGap.ok
        )
          break;
        // W43 · batch ALL failed checks into a single composite repair so
        // a draft missing implications + citing a fake pack id + with a
        // fabricated magnitude triggers ONE narrator call instead of
        // three. Behaviour-equivalent on single-issue cases (composite is
        // just the one issue). Per-check ordering preserved (completeness
        // is short-circuited first to avoid cascading false positives;
        // when it fails, citation/magnitudes are skipped and only its
        // gap fires).
        // Common failed-gap shape (each check's failure variant has the
        // same three string fields we need here). Lifting to this shape
        // sidesteps a TS recursive-type-reference issue when storing
        // the union directly in an array.
        interface FailedGap {
          code: string;
          description: string;
          courseCorrection: string;
        }
        const failedGaps: FailedGap[] = [];
        if (!completenessGap.ok) failedGaps.push(completenessGap);
        if (!citationGap.ok) failedGaps.push(citationGap);
        if (!magnitudesGap.ok) failedGaps.push(magnitudesGap);
        if (!temporalGap.ok) failedGaps.push(temporalGap);
        if (!aggregationGap.ok) failedGaps.push(aggregationGap);
        if (failedGaps.length === 0) break; // unreachable; guard
        completenessRound++;
        const failedCodes = failedGaps.map((g) => g.code);
        const composite = {
          description: failedGaps.map((g) => g.description).join("\n\n"),
          courseCorrection:
            failedGaps.length === 1
              ? failedGaps[0]!.courseCorrection
              : failedGaps
                  .map((g, i) => `(${i + 1}) ${g.courseCorrection}`)
                  .join("\n\n"),
        };
        agentLog("envelope_repair", {
          turnId,
          round: completenessRound,
          codes: failedCodes.join(","),
          issueCount: failedCodes.length,
          missing: composite.description.slice(0, 200),
        });
        safeEmit("flow_decision", {
          layer:
            failedCodes.length === 1
              ? failedCodes[0] === "HALLUCINATED_DOMAIN_CITATION"
                ? "envelope-citations"
                : failedCodes[0] === "FABRICATED_MAGNITUDES"
                  ? "envelope-magnitudes"
                  : failedCodes[0] === "TEMPORAL_TREND_SINGLE_BUCKET"
                    ? "envelope-temporal-trend"
                    : failedCodes[0] === "AGGREGATION_QUESTION_NOT_ADDRESSED"
                      ? "envelope-aggregation-floor"
                      : "envelope-completeness"
              : "envelope-multi-issue",
          chosen: `repair-round-${completenessRound}`,
          reason: composite.description.slice(0, 300),
          candidates: failedCodes,
        });
        const repaired = await runNarrator(
          ctx,
          ctx.blackboard,
          turnId,
          onLlmCall,
          {
            issues: composite.description,
            priorDraft: answer,
            courseCorrection: composite.courseCorrection,
          },
          undefined,
          // G4-P5 · pass structured observations on the repair pass too.
          structuredObservations
        );
        if (!repaired) break;
        // Rebuild answer + envelope from the repaired narrator output. Mirror
        // the assembly in the initial narrator branch above so all envelope
        // fields ride through.
        answer = formatAnswerFromEnvelope(repaired.body ?? "", repaired.keyInsight ?? null);
        if (!answer.trim()) break;
        const envFresh: NonNullable<
          import("../../../shared/schema.js").Message["answerEnvelope"]
        > = {};
        if (repaired.tldr) envFresh.tldr = repaired.tldr;
        if (repaired.findings?.length) envFresh.findings = repaired.findings;
        if (repaired.methodology) envFresh.methodology = repaired.methodology;
        if (repaired.caveats?.length) envFresh.caveats = repaired.caveats;
        if (ctx.deterministicCaveats?.length)
          envFresh.caveats = [...(envFresh.caveats ?? []), ...ctx.deterministicCaveats];
        const repairedCtas = (repaired.ctas ?? [])
          .map((c) => c.trim())
          .filter(Boolean)
          .slice(0, 3);
        // Depth-budget gate: the verifier-revise path rebuilds the envelope
        // from scratch, so it must re-apply the same minimal-depth suppression
        // the narrator/synth branches do — otherwise a revised answer to a plain
        // lookup re-introduces next-steps + recommendations the loop just stripped.
        if (repairedCtas.length && !minimalDepth) envFresh.nextSteps = repairedCtas;
        if (repaired.implications?.length) envFresh.implications = repaired.implications;
        if (repaired.recommendations?.length && !minimalDepth)
          envFresh.recommendations = repaired.recommendations;
        if (repaired.domainLens) envFresh.domainLens = repaired.domainLens;
        // W-CP1 · re-emit the sanitized causal lane on the verifier-revise path.
        {
          const drivers = sanitizeLikelyDrivers(
            repaired.likelyDrivers,
            ctx.summary.columns.map((c) => c.name)
          );
          if (drivers.length) envFresh.likelyDrivers = drivers;
        }
        if (Object.keys(envFresh).length) envelopeAnswerEnvelope = envFresh;
        if (repaired.magnitudes?.length) envelopeMagnitudes = repaired.magnitudes;
        if (repaired.unexplained) envelopeUnexplained = repaired.unexplained;
        // IUX2 · keep the visible "Key Insights" entry in sync with the repaired
        // narration. The key insight is no longer mirrored into the answer body
        // (it lives only in mergedInsights → InsightCard), so a repair pass that
        // changes keyInsight must update the entry seeded earlier — otherwise the
        // user sees the STALE pre-repair insight. Replace in place (no duplicate
        // card); append if it wasn't already present.
        // W-CW1 · mirror the initial seed's gate: only the no-envelope legacy
        // path shows a "Key Insights" card, so only it needs the repaired
        // insight kept in sync. Enveloped turns are a no-op here.
        if (!minimalDepth && !envelopeAnswerEnvelope && repaired.keyInsight?.trim()) {
          const repairedKi = repaired.keyInsight.trim();
          const prevKi = (seededKeyInsightText ?? "").trim();
          const idx = prevKi ? mergedInsights.findIndex((i) => i.text === prevKi) : -1;
          if (idx >= 0) mergedInsights[idx] = { ...mergedInsights[idx]!, text: repairedKi };
          else appendEnvelopeInsight(mergedInsights, repairedKi);
          seededKeyInsightText = repairedKi;
        }
        if (repairedCtas.length && !minimalDepth) followUpPrompts = repairedCtas;
      }
    }

    preservedAnswer = answer;

    materializeDeferredBuildCharts(ctx, deferredPlanCharts, mergedCharts);

    // IUX · An explicit dashboard ask opens a long, previously-silent post-answer
    // phase (visual planner → feature sweep → dashboard build + persist) that
    // used to sit under a frozen "Synthesizing answer" pill for ~1 min. Bracket
    // the WHOLE phase with one "Building dashboard" thinking step so the client
    // can show a live rotating status. We emit `active` here (before the first
    // sub-stage) and `completed` after the build try/catch below — paired on the
    // same `announceDashboardBuild` guard so the pill always resolves, even on
    // failure. The signal is the same explicit-ask the feature sweep + the
    // auto_create dashboard track key off.
    const isExplicitDashboardAsk =
      DASHBOARD_EXPLICIT_RX.test(ctx.question) ||
      ctx.analysisBrief?.requestsDashboard === true;
    const announceDashboardBuild =
      isExplicitDashboardAsk && Boolean(answer?.trim());
    if (announceDashboardBuild) {
      safeEmit("thinking", {
        step: "Building dashboard",
        status: "active",
        timestamp: Date.now(),
      });
    }

    let visualExtra: Awaited<ReturnType<typeof proposeAndBuildExtraCharts>> = {
      charts: [],
    };
    try {
      checkAbort("pre-visual-planner");
      visualExtra = await proposeAndBuildExtraCharts(
        ctx,
        observations.join("\n\n---\n\n"),
        turnId,
        onLlmCall,
        mergedCharts,
        answer.trim().slice(0, 6000)
      );
    } catch (visErr) {
      const msg = errorMessage(visErr);
      agentLog("visual_planner_failed", { turnId, err: msg.slice(0, 300) });
    }
    if (visualExtra.charts.length) {
      mergedCharts.push(...visualExtra.charts);
      appendInterAgentMessage(
        trace,
        {
          from: "VisualPlanner",
          to: "Coordinator",
          intent: "extra_charts_added",
          evidenceRefs: visualExtra.charts.map((_, i) => `chart_${i}`).slice(0, 8),
          meta: { count: String(visualExtra.charts.length) },
        },
        safeEmit
      );
      if (ctx.mode === "analysis") {
        void maybeMidTurn({
          phase: "post_visual",
          summary: `Visual planner added: ${visualExtra.charts.map((c) => `${c.title}:${c.x}/${c.y}`).join("; ")}`,
          ok: true,
        });
      }
    }

    // Deterministic feature sweep — when the user explicitly asked for a
    // dashboard, fill coverage gaps the LLM-driven planner + visual planner
    // left behind. Bounded so total mergedCharts never exceeds the dashboard
    // cap. Only runs on the auto_create track (regex or brief flag); the
    // multi-chart "offer" track does NOT pad charts the user didn't request.
    // (`isExplicitDashboardAsk` is computed once above, where it also gates the
    // "Building dashboard" thinking step that brackets this whole phase.)
    // EXHAUSTIVE BREADTH (flag-gated · invariant #6). When on, ANALYSIS turns —
    // not just explicit dashboard asks — get one metric-sorted "outcome by
    // <dim>" chart for EVERY categorical dimension, plus a best/worst finding
    // per dimension. This is the engine behind "go full fledged: top & worst
    // performers at every level, all columns considered."
    const {
      enumerateMissingDashboardCharts,
      isExhaustiveBreadthEnabled,
      shouldRunFeatureSweep,
      resolveBreadthOutcomeMetric,
      computeDimensionLeaders,
    } = await import("./dashboardFeatureSweep.js");
    const breadthEnabled = isExhaustiveBreadthEnabled();
    // Depth-budget gate (query-intent authority · single enforcement point).
    // The cross-dimension breadth sweep (one chart per categorical column) is
    // breadth augmentation, which the authority's contract keeps OFF for a
    // `standard` descriptive/trend ask unless the user explicitly asked. So a
    // pointed "what is the daily trend in X" question must NOT sweep — only an
    // explicit dashboard ask, diagnostic/strategic (`full`) depth, or an
    // explicit breadth request ("all columns / every level / full fledged")
    // opts in. Gating on `!minimalDepth` (the old condition) was the bug behind
    // the "pointed question → 16 charts" report. See shouldRunFeatureSweep.
    const runFeatureSweep = shouldRunFeatureSweep({
      isExplicitDashboardAsk,
      depthBudget: ctx.depthBudget,
      breadthSignal: ctx.queryIntent?.signals?.breadth === true,
      breadthEnabled,
      mode: ctx.mode,
    });
    if (runFeatureSweep) {
      try {
        // Breadth ties its ceiling to the configured final-chart cap (40 in the
        // Marico deploy) so ~one chart per dimension survives finalize; the
        // narrower dashboard-only path keeps the legacy 24 hard cap.
        const finalCap = parseInt(
          process.env.AGENT_MAX_FINAL_CHARTS_PER_TURN || "24",
          10
        );
        const sweepCeil =
          breadthEnabled && Number.isFinite(finalCap) && finalCap > 0
            ? finalCap
            : DASHBOARD_CHART_HARD_CAP;
        // On a plain analysis turn there is no brief — resolve the metric to
        // break down from the charts the turn already produced (or a rate-shaped
        // column). Null ⇒ nothing meaningful to break down ⇒ skip the sweep.
        const breadthOutcome = breadthEnabled
          ? resolveBreadthOutcomeMetric(ctx, mergedCharts)
          : null;
        const remaining = Math.max(0, sweepCeil - mergedCharts.length);
        if (remaining > 0 && (!breadthEnabled || breadthOutcome)) {
          // DB4 · pass a report sink so the loop can emit telemetry for
          // bucketed (top-N+Other) dims and high-cardinality skips. Both are
          // user-actionable: bucketed dims may need a derive_dimension_bucket
          // step to be useful; skipped dims at >500 uniques tell the user
          // why a candidate driver dim never appeared.
          const sweepReport = {
            skippedHighCardinality: [] as Array<{ dimension: string; uniques: number }>,
            bucketedDimensions: [] as Array<{ dimension: string; uniques: number; topN: number }>,
          };
          const swept = enumerateMissingDashboardCharts(
            ctx,
            mergedCharts,
            {
              maxAdds: remaining,
              ...(breadthEnabled
                ? {
                    exhaustiveDimensions: true,
                    bucketHighCardinality: true,
                    ...(breadthOutcome ? { outcomeOverride: breadthOutcome } : {}),
                  }
                : {}),
            },
            sweepReport
          );
          if (sweepReport.bucketedDimensions.length || sweepReport.skippedHighCardinality.length) {
            safeEmit("dashboard_feature_sweep_diagnostic", {
              bucketedDimensions: sweepReport.bucketedDimensions,
              skippedHighCardinality: sweepReport.skippedHighCardinality,
            });
            agentLog("dashboard_feature_sweep_diagnostic", {
              turnId,
              bucketed: sweepReport.bucketedDimensions.length,
              skipped: sweepReport.skippedHighCardinality.length,
            });
          }
          if (swept.length) {
            mergedCharts.push(...swept);
            appendInterAgentMessage(
              trace,
              {
                from: "VisualPlanner",
                to: "Coordinator",
                intent: "feature_sweep_added",
                evidenceRefs: swept.map((c) => `${c.x}/${c.y}`).slice(0, 12),
                meta: { count: String(swept.length) },
              },
              safeEmit
            );
            agentLog("dashboard_feature_sweep", {
              turnId,
              addedCount: swept.length,
              totalCharts: mergedCharts.length,
            });

            // Top/worst at every level: write a deterministic best-vs-worst
            // finding per swept dimension so the ONE narrator states the leaders
            // in prose (not only as a chart the user must read off). Bounded so
            // the narrator prompt stays sane; charts cover the rest. Ranks by
            // MEAN (size-normalised — correct for a rate metric).
            if (breadthEnabled && breadthOutcome && ctx.blackboard) {
              const breadthRows = (ctx.turnStartDataRef ?? ctx.data) as
                | Record<string, unknown>[]
                | undefined;
              if (breadthRows?.length) {
                const MAX_BREADTH_FINDINGS = 16;
                const seenDimFinding = new Set<string>();
                let added = 0;
                for (const c of swept) {
                  if (added >= MAX_BREADTH_FINDINGS) break;
                  const dim = c.x;
                  if (!dim || seenDimFinding.has(dim)) continue;
                  seenDimFinding.add(dim);
                  const leaders = computeDimensionLeaders(breadthRows, dim, breadthOutcome);
                  if (!leaders) continue;
                  const fmt = (v: number) =>
                    Math.abs(v) < 1 ? v.toFixed(3) : v.toFixed(1);
                  addFinding(ctx.blackboard, {
                    sourceRef: `breadth_${dim}`,
                    label: `Top vs bottom ${breadthOutcome} by ${dim}`.slice(0, 120),
                    detail:
                      `Best ${dim}: "${leaders.best.key}" (${breadthOutcome} ≈ ${fmt(leaders.best.value)}); ` +
                      `worst: "${leaders.worst.key}" (≈ ${fmt(leaders.worst.value)}) ` +
                      `across ${leaders.groupCount} ${dim} values.`,
                    significance: "notable",
                    relatedColumns: [dim, breadthOutcome],
                  });
                  added++;
                }
                if (added > 0) {
                  agentLog("breadth_leader_findings", { turnId, added });
                }
              }
            }
          }
        }
      } catch (sweepErr) {
        agentLog("dashboard_feature_sweep_failed", {
          turnId,
          error: errorMessage(sweepErr),
        });
      }
    }

    // Final dedupe + cap on mergedCharts. After this point the response is
    // assembled, so all chart sources (per-step promotion, deferred build_chart,
    // visual planner, dashboard sweep) are flushed into one canonical list.
    {
      const beforeCount = mergedCharts.length;
      finalizeMergedCharts(mergedCharts, ctx.intentEnvelope);
      if (mergedCharts.length !== beforeCount) {
        agentLog("merged_charts_finalized", {
          turnId,
          before: beforeCount,
          after: mergedCharts.length,
        });
      }
    }

    // IUX3 · chart-aware follow-up cleanup. mergedCharts is now the canonical,
    // final tile set (per-step + deferred build + visual planner + sweep). Drop
    // any suggested follow-up that merely restates a breakdown the user can
    // already SEE on a chart ("How does X vary by <already-charted dim>?") — a
    // redundant chip that re-asks what the answer/dashboard already shows. The
    // dashboard surface additionally GENERATES deeper questions client-side from
    // these same charts (shared/followUpDeepening.deepenFollowUps); here we only
    // filter, so the chat respects whatever deeper CTAs the narrator produced.
    if (followUpPrompts?.length) {
      const cleaned = filterAnsweredFollowUps(followUpPrompts, mergedCharts);
      if (cleaned.length !== followUpPrompts.length) {
        agentLog("follow_ups_chart_filtered", {
          turnId,
          before: followUpPrompts.length,
          after: cleaned.length,
        });
      }
      followUpPrompts = cleaned.length ? cleaned : undefined;
    }
    // Keep the envelope's parallel `nextSteps` (same CTA source; persisted to
    // memory and surfaced in exports) in lockstep, so a redundant breakdown
    // chip can't survive on one field after being dropped from the other.
    if (envelopeAnswerEnvelope?.nextSteps?.length) {
      const cleanedNs = filterAnsweredFollowUps(
        envelopeAnswerEnvelope.nextSteps,
        mergedCharts,
      );
      if (cleanedNs.length !== envelopeAnswerEnvelope.nextSteps.length) {
        envelopeAnswerEnvelope = {
          ...envelopeAnswerEnvelope,
          nextSteps: cleanedNs.length ? cleanedNs : undefined,
        };
      }
    }

    if (!answer?.trim()) {
      const fb = observationsFallbackAnswer();
      if (fb) {
        answer = fb;
        preservedAnswer = fb;
        answerSource = "fallback";
        agentLog("synthesis_empty_fallback", {
          turnId,
          observationsCount: observations.length,
          toolCallsDone,
        });
      }
    }

    // Wave R3 · deterministic bibliography. When this turn pulled real external
    // web sources onto the blackboard (web_search hits, source: "web"), append a
    // "## Sources" list parsed mechanically from those hits so external-research
    // answers carry a verifiable bibliography. Built deterministically — never
    // LLM-authored — so citations can't be hallucinated or dropped. Best-effort:
    // any failure leaves the answer untouched. (No web sources → no block; the
    // knowledge-cutoff caveat for knowledge-only answers is narrator-authored.)
    if (answer?.trim()) {
      try {
        const { buildBibliographyBlock } = await import(
          "./tools/webSearchTool.js"
        );
        const webContents = (blackboard.domainContext ?? [])
          .filter((e) => e.source === "web")
          .map((e) => e.content);
        const biblio = buildBibliographyBlock(webContents);
        if (biblio) answer = `${answer}\n\n${biblio}`;
      } catch (err) {
        agentLog("bibliography.build_failed", {
          turnId,
          error: errorMessage(err),
        });
      }
    }

    // PR 2.B — emit a DashboardSpec draft. Two tracks:
    //   - auto_create: user explicitly asked (regex or brief flag) → build +
    //     persist + emit `dashboard_created` → client auto-navigates.
    //   - offer: multi-chart turn (>= MULTI_CHART_OFFER_THRESHOLD) without an
    //     explicit ask → build spec only; client renders a "Build Dashboard"
    //     button the user can click.
    // Non-fatal: failures leave dashboardDraft unset and the normal answer
    // still streams to the client.
    const rawDashIntent = classifyDashboardIntent({
      question: ctx.question,
      chartCount: mergedCharts.length,
      brief: ctx.analysisBrief,
    });
    // Depth-budget gate (query-intent authority). The unsolicited "offer" track
    // self-trips whenever a turn happens to accumulate ≥3 charts — which a plain
    // lookup never asked for. Suppress the offer for minimal-depth questions.
    // An EXPLICIT dashboard ask ("auto_create") is never minimal (the word
    // "dashboard" is in the analytical core), so this only drops the offer.
    const dashIntent =
      minimalDepth && rawDashIntent === "offer" ? "none" : rawDashIntent;
    agentLog("dashboard_intent", {
      turnId,
      intent: dashIntent,
      ...(dashIntent !== rawDashIntent ? { suppressedFrom: rawDashIntent, reason: "minimal_depth" } : {}),
      chartCount: mergedCharts.length,
    });
    try {
      const { dashboardBuildDecision, buildDashboardFromTurn } = await import(
        "./buildDashboard.js"
      );
      const dashDecision = dashboardBuildDecision({
        intent: dashIntent,
        charts: mergedCharts,
        userKey: ctx.username,
      });
      if (answer?.trim() && dashDecision.build) {
        const intermediateSummaries = trace.toolCalls
          .filter((t) => t.ok && t.resultSummary)
          .map((t) => `${t.name}: ${t.resultSummary}`);
        // W5 · build the slim envelope the dashboard prompt + persistence
        // expect. `envelopeAnswerEnvelope` lacks magnitudes (those live at
        // top-level on the message); merge them in here.
        const dashEnvelope = envelopeAnswerEnvelope
          ? {
              ...envelopeAnswerEnvelope,
              ...(envelopeMagnitudes && envelopeMagnitudes.length > 0
                ? { magnitudes: envelopeMagnitudes }
                : {}),
            }
          : envelopeMagnitudes && envelopeMagnitudes.length > 0
            ? { magnitudes: envelopeMagnitudes }
            : undefined;
        // FIX · auto-include the response's pivot on the dashboard. We use the
        // same `derivePivotDefaultsFromPreviewRows` the chat-side pivot uses
        // to seed its initial state — so the dashboard's pivot tile renders
        // the same view the user would see if they toggled "Pivot" in chat.
        // No tools re-run; the tile fetches data live from the same DuckDB
        // session at render time (same pattern as the chat-side pivot).
        const dashPivot = buildAutoPivotSpec({
          table,
          summary: ctx.summary,
          turnId,
          sessionId: ctx.sessionId,
        });
        // DPF2 · message-mirroring fields. Computed here in the same scope
        // the assistant message persist uses, so the dashboard sees the SAME
        // followUpPrompts / investigationSummary / priorInvestigationsSnapshot
        // the message saved to Cosmos. `priorInvestigations` is the BEFORE-
        // turn snapshot — the W21 append happens later in
        // `persistMergeAssistantSessionContext`, so the in-memory
        // `chatDocument.sessionAnalysisContext.sessionKnowledge.priorInvestigations`
        // still reflects what the agent knew BEFORE this turn ran (parity with
        // chatStream.service.ts:1500-1503).
        // W-CW1 · a minimal-depth ask never tested hypotheses, so an
        // investigation summary would be pure OPEN-status clutter. Gate it here
        // (the dashboard mirror) AND at the message-persist site below so both
        // producer paths inherit the same rule (L-019: gate every path).
        const dashInvestigationSummary = minimalDepth
          ? undefined
          : buildInvestigationSummary(
              ctx.blackboard,
              ctx.summary.columns.map((c) => c.name)
            );
        const dashPriorInvestigations =
          ctx.chatDocument?.sessionAnalysisContext?.sessionKnowledge?.priorInvestigations;
        const spec = await buildDashboardFromTurn({
          question: ctx.question,
          answerBody: answer,
          keyInsight: mergedInsights[0]?.text,
          charts: mergedCharts,
          magnitudes: envelopeMagnitudes,
          brief: ctx.analysisBrief,
          depthBudget: ctx.depthBudget,
          turnId,
          onLlmCall,
          intermediateSummaries,
          envelope: dashEnvelope,
          pivot: dashPivot,
          ...(followUpPrompts && followUpPrompts.length > 0
            ? { followUpPrompts }
            : {}),
          ...(dashInvestigationSummary
            ? { investigationSummary: dashInvestigationSummary }
            : {}),
          ...(dashPriorInvestigations && dashPriorInvestigations.length > 0
            ? { priorInvestigationsSnapshot: dashPriorInvestigations }
            : {}),
        });
        if (spec) {
          dashboardDraft = spec;
          safeEmit("dashboard_draft", {
            name: spec.name,
            template: spec.template,
            sheetCount: spec.sheets.length,
            chartCount: mergedCharts.length,
          });
          appendInterAgentMessage(
            trace,
            {
              from: "Synthesizer",
              to: "Coordinator",
              intent: "dashboard_drafted",
              meta: {
                template: spec.template,
                sheetCount: String(spec.sheets.length),
              },
            },
            safeEmit
          );

          // Auto-persist the draft so the user lands on /dashboard?open=<id>
          // without a manual click. Only on the auto_create track — the
          // multi-chart "offer" track relies on the client's explicit
          // BuildDashboardCallout button to create + navigate. Failure leaves
          // dashboardDraft as the fallback path (DashboardDraftCard's manual
          // "Create dashboard").
          if (dashDecision.persist && ctx.username) {
            try {
              const { createDashboardFromSpec } = await import(
                "../../../models/dashboard.model.js"
              );
              // F4 · Retry transient Cosmos errors (429/503/timeouts) so a
              // momentary blip doesn't drop the auto-persist and force the user
              // to click "Create" manually. 3 attempts with 200/400/800 ms
              // backoff, only on retryable errors.
              const isRetryable = (err: unknown): boolean => {
                const m = errorMessage(err);
                const code = (err as { code?: string | number })?.code;
                const status = (err as { statusCode?: number })?.statusCode;
                if (status === 429 || status === 503 || status === 408) return true;
                if (code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ECONNREFUSED") return true;
                return /timeout|ECONNRESET|ETIMEDOUT|429|503/i.test(m);
              };
              // Wave-FA6 · Snapshot the session's active filter onto the
              // dashboard spec for provenance. Charts are already filtered at
              // capture time (since `loadLatestData` honored the filter); this
              // records *which* slice the dashboard was built from so the
              // dashboard view can show a banner.
              const specWithFilter = ctx.chatDocument?.activeFilter &&
                ctx.chatDocument.activeFilter.conditions.length > 0
                ? { ...spec, capturedActiveFilter: ctx.chatDocument.activeFilter }
                : spec;
              let created: Awaited<ReturnType<typeof createDashboardFromSpec>>;
              const delays = [200, 400, 800];
              let attempt = 0;
              for (;;) {
                try {
                  created = await createDashboardFromSpec(
                    ctx.username,
                    specWithFilter,
                    ctx.sessionId
                  );
                  break;
                } catch (err) {
                  if (attempt >= delays.length || !isRetryable(err)) throw err;
                  agentLog("dashboard_auto_create_retry", {
                    turnId,
                    attempt: attempt + 1,
                    delayMs: delays[attempt],
                  });
                  await new Promise((r) => setTimeout(r, delays[attempt]));
                  attempt++;
                }
              }
              createdDashboardId = created.id;
              safeEmit("dashboard_created", {
                dashboardId: created.id,
                name: created.name,
                sheetCount: spec.sheets.length,
                chartCount: mergedCharts.length,
              });
              try {
                const { setLastCreatedDashboardForSession } = await import(
                  "../../../models/chat.model.js"
                );
                void setLastCreatedDashboardForSession(
                  ctx.sessionId,
                  ctx.username,
                  created.id
                );
              } catch {
                /* best-effort stamp; patch_dashboard still works without it */
              }
              agentLog("dashboard_auto_created", {
                turnId,
                dashboardId: created.id,
                chartCount: mergedCharts.length,
              });
            } catch (createErr) {
              agentLog("dashboard_auto_create_failed", {
                turnId,
                error:
                  errorMessage(createErr),
              });
            }
          }
        }
      }
    } catch (dashErr) {
      agentLog("buildDashboard.dispatch_failed", {
        turnId,
        error: errorMessage(dashErr),
      });
    }

    // Resolve the "Building dashboard" pill (opened before the visual planner)
    // on BOTH success and failure so the client's rotating status stops and the
    // step settles to completed. Paired with the `active` emit above.
    if (announceDashboardBuild) {
      safeEmit("thinking", {
        step: "Building dashboard",
        status: "completed",
        timestamp: Date.now(),
      });
    }

    if (!answer?.trim()) {
      trace.endedAt = Date.now();
      agentLog("turn.abort", {
        phase: "synthesis",
        turnId,
        observationsCount: observations.length,
        hadDelegateAnswer: Boolean(delegateAnswer?.trim()),
        toolCallsDone,
        chartsCount: mergedCharts.length,
        sessionIdLen: ctx.sessionId.length,
      });
      return {
        answer: "",
        charts: mergedCharts.length ? mergedCharts : undefined,
        insights: mergedInsights.length ? mergedInsights : undefined,
        table,
        operationResult,
        agentTrace: capAgentTrace(trace),
        agentSuggestionHints: agentSuggestionHints.length ? agentSuggestionHints : undefined,
        lastAnalyticalRowsForEnrichment: lastAnalyticalRowsSnapshot(ctx),
        ...briefOut(),
      ...appliedFiltersOut(),
      ...intentEnvelopeOut(),
      };
    }

    const finalRound = 0;
    const chartTitles = mergedCharts.map((c) => `${c.title}:${c.x}/${c.y}`).join("; ");
    const finalEvidence = buildFinalEvidence(
      observations,
      chartTitles,
      ctx.blackboard,
      envelopeMagnitudes
    );

    // W4 · The final verifier critiques narrative quality. When the answer
    // came from the deterministic fallback renderer (renderFallbackAnswer),
    // there is no narrative — only a markdown render of tool data — so the
    // verifier would always flag MISSING_MAGNITUDES / MISSING_NARRATIVE and
    // single-flow would lock the placeholder in place. Skip it instead and
    // emit a flow_decision so the trace remains transparent.
    if (answerSource === "fallback") {
      safeEmit("flow_decision", {
        layer: "verifier-rewrite-final",
        chosen: "fallback-skipped",
        reason:
          "Synthesis fallback used; verifier skipped because there is no narrative to critique.",
        candidates: [],
      });
    }

    while (answerSource !== "fallback" && finalRound < config.maxVerifierRoundsFinal) {
      // Wave WV3 · reconstruct a partial NarratorOutput from already-hoisted
      // envelope state so the verifier's confidence-overclaim detector can
      // fire. `body: ""` satisfies the schema; the detector only reads
      // magnitudes + implications.
      const wv3NarratorOutput =
        envelopeMagnitudes?.length || envelopeAnswerEnvelope?.implications?.length
          ? {
              body: "",
              magnitudes: envelopeMagnitudes,
              implications: envelopeAnswerEnvelope?.implications,
            }
          : undefined;
      const fv = await runVerifier(
        ctx,
        {
          candidate: answer,
          evidenceSummary: finalEvidence,
          stepId: "final",
          turnId,
          blackboard: ctx.blackboard,
          planSteps: trace.steps,
          charts: mergedCharts,
          // Wave B6 · in-turn verdict history.
          priorVerifierVerdicts: verifierVerdicts,
          // Wave WV3 · enables the pre-LLM confidence-overclaim detector.
          narratorOutput: wv3NarratorOutput,
        },
        onLlmCall
      );
      trace.criticRounds.push({
        stepId: "final",
        verdict: fv.verdict,
        issueCodes: fv.issues.map((i) => i.code),
        courseCorrection: fv.course_correction,
      });
      // Wave A2 · structured final-verifier verdict (stepIndex = -1 marker).
      {
        const issueLines = fv.issues
          .map((i) => `${i.code}: ${i.description}`)
          .join("\n")
          .slice(0, 1800);
        verifierVerdicts.push({
          stepIndex: -1,
          verdict: fv.verdict,
          rationale: fv.course_correction || issueLines || "(no rationale)",
          evidence: finalEvidence?.slice(0, 3500),
        });
      }
      safeEmit("critic_verdict", {
        stepId: "final",
        verdict: fv.verdict,
        issue_codes: fv.issues.map((i) => i.code),
        course_correction: fv.course_correction,
        // Wave WV8 · surface narrator-claimed vs. blackboard-actual tier
        // counts when the WV3 short-circuit fired. agentWorkbench.util.ts
        // renders these as "Narrator confidence: claimed Xh/Ym/Zl;
        // blackboard supports Xh/Ym/Zl" so the user sees what the
        // deterministic floor disagreed with, not just the issue code.
        // Always omitted when the final verifier passed through the deep
        // LLM (the report only exists on the short-circuit path).
        ...(fv.confidenceOverclaim
          ? {
              confidence_overclaim: {
                claimed: fv.confidenceOverclaim.claimed,
                actual: fv.confidenceOverclaim.actual,
              },
            }
          : {}),
      });
      if (fv.verdict === VERIFIER_VERDICT.pass) {
        break;
      }
      if (
        fv.verdict === VERIFIER_VERDICT.reviseNarrative ||
        fv.course_correction === VERIFIER_VERDICT.reviseNarrative
      ) {
        // Single-flow policy: narrator-repair and rewriteNarrative are both
        // suppressed. The verifier's verdict is still emitted as critic_verdict
        // (visible in workbench) so users see what was flagged without having
        // the synthesized answer silently swapped out.
        const issuesText = fv.issues.map((i) => i.description).join("; ");
        safeEmit("flow_decision", {
          layer: "verifier-rewrite-final",
          chosen: "kept-original",
          reason: `Rewrite suppressed (single-flow policy); ${issuesText.slice(0, 400)}`.slice(0, 500),
          candidates: fv.issues.map((i) => i.code).slice(0, 8),
        });
      }
      break;
    }

    {
      const finalCritic = [...trace.criticRounds]
        .reverse()
        .find((c) => c.stepId === "final");
      appendInterAgentMessage(
        trace,
        {
          from: "Verifier",
          to: "Coordinator",
          intent: "final_verdict",
          evidenceRefs: ["final", finalCritic?.verdict ?? "unknown"],
          meta: { verdict: finalCritic?.verdict ?? "" },
        },
        safeEmit
      );
    }

    preservedAnswer = answer;
    trace.endedAt = Date.now();
    agentLog("turn_done", {
      turnId,
      tools: toolCallsDone,
      llmCalls,
      mode: ctx.mode,
      legacyFallback: false,
      ragHitCount: lastRagHitCount,
    });

    // Post-verifier business-actions seam. Spawned (not awaited) so the
    // existing response/SSE timing is unchanged. The chatStream service
    // awaits this promise AFTER emitting the response event, then sends a
    // separate `business_actions` SSE event and patches the persisted
    // message. Hard-skipped when the env flag is off, the synthesis
    // cascaded to the fallback renderer, or there is no envelope.
    const businessActionsEnabled = isBusinessActionsEnabled();
    const businessActionsPromise =
      businessActionsEnabled &&
      answerSource !== "fallback" &&
      envelopeAnswerEnvelope
        ? runBusinessActions(ctx, envelopeAnswerEnvelope, {
            turnId,
            onLlmCall,
            contextTrimmedSink: ctx.contextTrimmedSink,
          }).catch((err) => {
            agentLog("businessActionsAgent.unhandled", {
              turnId,
              error: errorMessage(err),
            });
            return [] as Awaited<ReturnType<typeof runBusinessActions>>;
          })
        : undefined;

    return {
      answer,
      charts: mergedCharts.length ? mergedCharts : undefined,
      insights: mergedInsights.length ? mergedInsights : undefined,
      table,
      operationResult,
      agentTrace: capAgentTrace(trace),
      agentSuggestionHints: agentSuggestionHints.length ? agentSuggestionHints : undefined,
      ...(followUpPrompts?.length ? { followUpPrompts } : {}),
      ...(envelopeMagnitudes?.length ? { magnitudes: envelopeMagnitudes } : {}),
      ...(envelopeUnexplained ? { unexplained: envelopeUnexplained } : {}),
      ...(envelopeAnswerEnvelope ? { answerEnvelope: envelopeAnswerEnvelope } : {}),
      ...(businessActionsPromise ? { businessActionsPromise } : {}),
      // AMR3 · drain the pivot-artifact capture buffer onto the return shape so
      // the chatStream service can materialize (inline-vs-blob) and patch the
      // past_analyses doc. Empty buffer / undefined ⇒ no pivots captured this
      // turn (data-prep tools only, scalar aggregates, errored steps).
      ...(ctx.pivotArtifactsBuffer?.length
        ? { pivotArtifacts: ctx.pivotArtifactsBuffer }
        : {}),
      ...(dashboardDraft ? { dashboardDraft } : {}),
      ...(createdDashboardId ? { createdDashboardId } : {}),
      ...(accumulatedSpawnedQuestions.length ? { spawnedQuestions: accumulatedSpawnedQuestions } : {}),
      ...(investigatedSubQuestionsOut.length ? { investigatedSubQuestions: investigatedSubQuestionsOut } : {}),
      ...(ctx.blackboard ? { blackboard: ctx.blackboard } : {}),
      // W13 · compact persistable digest of the analytical blackboard so
      // the client can render an "Investigation summary" card. Returns
      // undefined when blackboard has nothing material to show.
      ...((() => {
        // W-CW1 · minimal asks get no investigation summary (see the dashboard
        // mirror above). buildInvestigationSummary itself now also drops
        // OPEN-only digests at source, so even standard/full asks stop showing
        // "N OPEN hypotheses that add nothing".
        if (minimalDepth) return {};
        const cols = ctx.summary.columns.map((c) => c.name);
        const summ = buildInvestigationSummary(ctx.blackboard, cols);
        return summ ? { investigationSummary: summ } : {};
      })()),
      // Wave A2 · full in-memory turn state for round-trip persistence to
      // Cosmos. Survives end-to-end: workingMemory, structured reflector +
      // verifier verdicts, blackboard snapshot, per-step tool I/O.
      agentInternals: buildAgentInternals({
        workingMemory,
        reflectorVerdicts,
        verifierVerdicts,
        blackboard: ctx.blackboard,
        toolIO: toolIOEntries,
      }),
      lastAnalyticalRowsForEnrichment: lastAnalyticalRowsSnapshot(ctx),
      ...briefOut(),
      ...appliedFiltersOut(),
      ...intentEnvelopeOut(),
    };
  } catch (e) {
    const msg = errorMessage(e);
    if (msg === "AGENT_CLIENT_ABORTED") {
      // F3 · client closed the SSE stream; drop further LLM work and return
      // whatever partial state we have without a noisy error fallback.
      trace.budgetHits?.push("client_aborted" as never);
      trace.endedAt = Date.now();
      agentLog("turn_aborted", { turnId, mode: ctx.mode });
      materializeDeferredBuildCharts(ctx, deferredPlanCharts, mergedCharts);
      return {
        answer:
          delegateAnswer ||
          observationsFallbackAnswer() ||
          "Request cancelled.",
        charts: mergedCharts.length ? mergedCharts : undefined,
        insights: mergedInsights.length ? mergedInsights : undefined,
        table,
        operationResult,
        agentTrace: capAgentTrace(trace),
        lastAnalyticalRowsForEnrichment: lastAnalyticalRowsSnapshot(ctx),
        ...briefOut(),
        ...appliedFiltersOut(),
        ...intentEnvelopeOut(),
      };
    }
    if (msg === "AGENT_LLM_BUDGET") {
      trace.budgetHits?.push("max_llm_calls");
      trace.endedAt = Date.now();
      agentLog("turn_budget", {
        turnId,
        kind: "llm",
        mode: ctx.mode,
        legacyFallback: false,
      });
      materializeDeferredBuildCharts(ctx, deferredPlanCharts, mergedCharts);
      const partial =
        delegateAnswer ||
        (observations.length > 0
          ? observations.join("\n\n").slice(0, config.observationMaxChars)
          : "Agent LLM budget exceeded for this turn.");
      return {
        answer: partial,
        charts: mergedCharts.length ? mergedCharts : undefined,
        insights: mergedInsights.length ? mergedInsights : undefined,
        table,
        operationResult,
        agentTrace: capAgentTrace(trace),
        lastAnalyticalRowsForEnrichment: lastAnalyticalRowsSnapshot(ctx),
        ...briefOut(),
      ...appliedFiltersOut(),
      ...intentEnvelopeOut(),
      };
    }
    trace.endedAt = Date.now();
    agentLog("turn_error", {
      turnId,
      err: msg.slice(0, 200),
      mode: ctx.mode,
      legacyFallback: false,
    });
    materializeDeferredBuildCharts(ctx, deferredPlanCharts, mergedCharts);
    const errFallback =
      preservedAnswer.trim() ||
      observationsFallbackAnswer() ||
      "";
    return {
      answer:
        errFallback ||
        `The analysis agent encountered an error (${msg.length > 200 ? `${msg.slice(0, 200)}…` : msg}). Please try again.`,
      charts: mergedCharts.length ? mergedCharts : undefined,
      insights: mergedInsights.length ? mergedInsights : undefined,
      table,
      operationResult,
      agentTrace: capAgentTrace(trace),
      ...(followUpPrompts?.length ? { followUpPrompts } : {}),
      lastAnalyticalRowsForEnrichment: lastAnalyticalRowsSnapshot(ctx),
      ...briefOut(),
      ...appliedFiltersOut(),
      ...intentEnvelopeOut(),
    };
  } finally {
    // PERF-10 · Close the per-turn shared DuckDB handle exactly once at turn
    // end (success, abort, or error). Idempotent — no-op if no analytical tool
    // ever asked for a handle. Read tools (run_analytical_query, compute_growth,
    // detect_seasonality, run_readonly_sql, execute_query_plan) borrow it via
    // getTurnColumnarStorage and never close it themselves.
    await closeTurnColumnarStorage(ctx);
  }
}
