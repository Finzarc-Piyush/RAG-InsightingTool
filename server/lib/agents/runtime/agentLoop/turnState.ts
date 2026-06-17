/**
 * agentLoop/turnState.ts — the explicit per-turn mutable-state bundle for
 * `runAgentTurn` (findings ARCH-1 / CQ-1).
 *
 * WHAT THIS IS
 *   `runAgentTurn` is the system's core orchestrator. Historically it declared
 *   ~30 mutable accumulators as bare `const`/`let` locals at the top of the
 *   function and threaded them implicitly through one giant closure. That
 *   implicit threading is exactly what makes the function impossible to split:
 *   any extracted phase would have to take a dozen positional args.
 *
 *   `TurnState` bundles those accumulators into ONE object created once at the
 *   top of the turn. Extracted phases take `state: TurnState` (plus the few
 *   read-only collaborators — `ctx`, `trace`, `config`) and read/write
 *   `state.x` instead of a free local. The bundling is behaviour-preserving by
 *   construction: a phase that did `mergedCharts.push(c)` now does
 *   `state.mergedCharts.push(c)` against the SAME array instance.
 *
 * WHY `any` SURVIVES ON A FEW FIELDS
 *   `table` / `operationResult` carried a bare `: any` type ANNOTATION on their
 *   original `let` declarations (tool results are heterogeneous; the narrow
 *   types live downstream). Keeping that ANNOTATION here is a faithful move of
 *   the original declaration — it is a type annotation, NOT a value-position
 *   cast — so it does not touch the type-escape ratchet (which counts only
 *   cast hatches). Narrowing them is a separate, out-of-scope cleanup.
 *
 * SCOPE NOTE
 *   This bundles ONLY the shared mutable accumulators. The read-only per-turn
 *   collaborators (`registry`, `toolCtx`, `safeEmit`, `checkAbort`, `onLlmCall`,
 *   `deadline`, `blackboard`) stay as locals in `runAgentTurn` and are passed
 *   explicitly to phases that need them — they are not mutable turn state.
 */
import { z } from "zod";
import type { ChartSpec, DashboardSpec, Insight, Message } from "../../../../shared/schema.js";
import type { WorkingMemoryEntry } from "../types.js";
import type {
  ReflectorVerdictRecord,
  VerifierVerdictRecord,
  ToolIORecord,
} from "../buildAgentInternals.js";
import type {
  StructuredObservation,
  StructuredFinding,
  ScratchpadEntry,
  SubQuestion,
  MagnitudeAudit as MagnitudeAuditEntry,
  Contradiction,
} from "../investigationState.js";
import type { SpawnedQuestion } from "../investigationTree.js";
import type { DeferredBuildChartTemplate } from "../agentLoopDeferredCharts.js";
import type { magnitudeSchema } from "./synthesis.js";

/**
 * The bundle of mutable accumulators a single `runAgentTurn` invocation grows
 * as it plans → acts → synthesises. One instance is created per turn via
 * `createTurnState()` and threaded to every extracted phase.
 *
 * Field-by-field this mirrors the former top-of-function locals 1:1 (same
 * names, same initial values) so the extraction is a pure rename.
 */
export interface TurnState {
  // ── Observation + answer accumulators ──
  observations: string[];
  agentSuggestionHints: string[];
  followUpPrompts: string[] | undefined;
  accumulatedSpawnedQuestions: SpawnedQuestion[];
  investigatedSubQuestionsOut: Array<{ id: string; question: string; chartCount: number }>;

  // ── Rich-envelope surfaces (populated during synthesis) ──
  envelopeMagnitudes: z.infer<typeof magnitudeSchema>[] | undefined;
  envelopeUnexplained: string | undefined;
  envelopeAnswerEnvelope: Message["answerEnvelope"] | undefined;

  // ── Dashboard outputs ──
  dashboardDraft: DashboardSpec | undefined;
  createdDashboardId: string | undefined;

  // ── Working memory + structured per-step records (persisted via agentInternals) ──
  workingMemory: WorkingMemoryEntry[];
  reflectorVerdicts: ReflectorVerdictRecord[];
  verifierVerdicts: VerifierVerdictRecord[];
  toolIOEntries: ToolIORecord[];
  structuredObservations: StructuredObservation[];
  structuredFindings: StructuredFinding[];
  turnScratchpad: ScratchpadEntry[];
  turnSubQuestions: SubQuestion[];
  magnitudeAudits: MagnitudeAuditEntry[];
  turnContradictions: Contradiction[];

  // ── Charts / insights / deferred chart templates ──
  mergedCharts: ChartSpec[];
  mergedInsights: Insight[];
  deferredPlanCharts: DeferredBuildChartTemplate[];

  // ── Last-result handles (heterogeneous tool output; `any` preserved verbatim) ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  operationResult: any;
  lastNumeric: string;
  delegateAnswer: string | undefined;
  lastRagHitCount: number | undefined;

  // ── Budget / progress counters ──
  toolCallsDone: number;
  stepsWalked: number;
  lastMidTurnPersist: number;
  /** Survives catch if a post-synthesis step throws (e.g. visual planner). */
  preservedAnswer: string;
}

/**
 * Initialise the per-turn state bundle. Every field starts at the SAME initial
 * value the former bare locals used, so swapping `const observations = []` for
 * `state.observations` is behaviour-identical.
 */
export function createTurnState(): TurnState {
  return {
    observations: [],
    agentSuggestionHints: [],
    followUpPrompts: undefined,
    accumulatedSpawnedQuestions: [],
    investigatedSubQuestionsOut: [],
    envelopeMagnitudes: undefined,
    envelopeUnexplained: undefined,
    envelopeAnswerEnvelope: undefined,
    dashboardDraft: undefined,
    createdDashboardId: undefined,
    workingMemory: [],
    reflectorVerdicts: [],
    verifierVerdicts: [],
    toolIOEntries: [],
    structuredObservations: [],
    structuredFindings: [],
    turnScratchpad: [],
    turnSubQuestions: [],
    magnitudeAudits: [],
    turnContradictions: [],
    mergedCharts: [],
    mergedInsights: [],
    deferredPlanCharts: [],
    table: undefined,
    operationResult: undefined,
    lastNumeric: "",
    delegateAnswer: undefined,
    lastRagHitCount: undefined,
    toolCallsDone: 0,
    stepsWalked: 0,
    lastMidTurnPersist: 0,
    preservedAnswer: "",
  };
}
