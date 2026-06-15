/**
 * ============================================================================
 * spawnedFollowUpPass.ts — auto-investigate the "Investigating further" chips
 * ============================================================================
 * WHAT THIS FILE DOES
 *   The reflector emits follow-up "spawnedQuestions" (the "Investigating
 *   further" chips). In the single-flow turn they used to be DECORATIVE — never
 *   investigated. This pass runs each one as a bounded sub-investigation that
 *   SHARES the parent blackboard (so its findings reach the one final synthesis)
 *   and FORWARDS its charts into the parent turn (so they become chart cards and
 *   dashboard tiles). The result: the spawned sub-questions are investigated and
 *   woven into one coherent final response.
 *
 * WHY IT MATTERS
 *   This is the engine behind "the investigated things show up in the response."
 *   It sits behind the SPAWNED_FOLLOWUP_ENABLED flag (invariant #6). There is
 *   **no cap on the NUMBER of sub-questions** — every one is investigated — but
 *   the pass is hard-bounded by an aggregate LLM-call + wall-time budget so "no
 *   count cap" never means "no resource cap" (each sub-turn is a full
 *   runAgentTurn with its OWN per-turn LLM counter, so only this aggregate
 *   ceiling stops runaway cost).
 *
 * HOW IT CONNECTS
 *   Called from agentLoop.service.ts after the plan loop, BEFORE RAG Round 2 and
 *   synthesis, so the shared blackboard + mergedCharts carry the sub-findings
 *   into the existing rich synthesizer and dashboard builder. Reuses
 *   runSubInvestigation (investigationOrchestrator.ts) for each bounded sub-turn;
 *   markQuestionActioned (analyticalBlackboard.ts) to resolve open questions.
 */

import { agentLog } from "./agentLogger.js";
import { runSubInvestigation } from "./investigationOrchestrator.js";
import {
  loadSpawnedFollowUpConfig,
  type SpawnedFollowUpConfig,
  type SpawnedQuestion,
} from "./investigationTree.js";
import { markQuestionActioned } from "./analyticalBlackboard.js";
import { loadAgentConfigFromEnv } from "./types.js";
import type { AgentConfig, AgentExecutionContext, AgentLoopResult } from "./types.js";
import { errorMessage } from "../../../utils/errorMessage.js";

/** Mirrors AgentSseEmitter; inlined so this module doesn't import agentLoop. */
type SseEmit = (event: string, data: unknown) => void;
type ChartSpecList = NonNullable<AgentLoopResult["charts"]>;

/**
 * Events a sub-turn would emit that must NOT reach the client — they would
 * thrash the UI with interleaved partial answers, nested spawn chips, or a
 * premature "final" before the ONE real synthesis runs.
 */
const SUPPRESSED_SUBTURN_EVENTS = new Set<string>([
  "answer_chunk",
  "thinking",
  "sub_question_spawned",
  "response",
  "response_charts",
  "dashboard_draft",
  "dashboard_created",
  "business_actions",
  "persist_status",
  "session_context_updated",
  "done",
]);

export interface InvestigatedSubQuestion {
  id?: string;
  question: string;
  answer: string;
  chartCount: number;
}

export interface SpawnedFollowUpPassResult {
  /** Charts from all investigated sub-questions, provenance-tagged. */
  charts: ChartSpecList;
  /** Per-sub-question summaries (for the synthesis hint + client surface). */
  investigated: InvestigatedSubQuestion[];
  /** Aggregate LLM calls consumed by the pass. */
  llmCalls: number;
  /** Aggregate wall-time of the pass (ms). */
  wallMs: number;
  /** True if the pass stopped launching sub-turns on the aggregate budget. */
  budgetHalted: boolean;
}

type RunSub = typeof runSubInvestigation;

/**
 * Investigate every spawned sub-question (no count cap) as a bounded sub-turn
 * sharing `ctx.blackboard`, collecting their charts. Best-effort: a throwing
 * sub-turn is logged and skipped; the parent turn is never aborted.
 */
export async function runSpawnedFollowUpPass(
  ctx: AgentExecutionContext,
  questions: ReadonlyArray<SpawnedQuestion>,
  emit?: SseEmit,
  config: SpawnedFollowUpConfig = loadSpawnedFollowUpConfig(),
  /** Injectable for tests; defaults to the real bounded sub-investigation. */
  runSub: RunSub = runSubInvestigation
): Promise<SpawnedFollowUpPassResult> {
  const charts: ChartSpecList = [];
  const investigated: InvestigatedSubQuestion[] = [];
  let llmCalls = 0;
  let budgetHalted = false;
  const startedAt = Date.now();

  // Defence-in-depth dedup (filterSpawnedQuestions already ran upstream): never
  // investigate the same sub-question twice in one pass.
  const seen = new Set<string>();
  const queue = questions.filter((q) => {
    const k = (q?.question ?? "").trim().toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  if (queue.length === 0) {
    return { charts, investigated, llmCalls, wallMs: 0, budgetHalted };
  }

  // Per-sub-turn bounded config.
  const base = loadAgentConfigFromEnv();
  const perSubConfig: AgentConfig = {
    ...base,
    maxTotalLlmCallsPerTurn: config.perSubLlmCalls,
    maxWallTimeMs: config.perSubWallMs,
    maxSteps: Math.min(base.maxSteps, config.perSubMaxSteps),
    maxToolCalls: Math.min(base.maxToolCalls, config.perSubMaxToolCalls),
  };

  // Filtered emitter: suppress sub-turn answer/streaming/nested-spawn events so
  // the client isn't thrashed; the user's answer_chunk comes only from the ONE
  // final synthesis.
  const subEmit: SseEmit | undefined = emit
    ? (event, data) => {
        if (!SUPPRESSED_SUBTURN_EVENTS.has(event)) emit(event, data);
      }
    : undefined;

  // Investigate in small parallel batches; check the AGGREGATE budget before
  // each batch (no cap on the number of questions — only the resource budget).
  for (let i = 0; i < queue.length; i += config.parallel) {
    const elapsed = Date.now() - startedAt;
    if (llmCalls >= config.maxLlmCalls || elapsed >= config.maxWallMs) {
      budgetHalted = true;
      break;
    }

    const batch = queue.slice(i, i + config.parallel);
    const results = await Promise.all(
      batch.map(async (q) => {
        try {
          const sub = await runSub(ctx, q.question, perSubConfig, subEmit);
          return { q, sub };
        } catch (e) {
          agentLog("spawnedFollowUp.sub_failed", {
            question: q.question.slice(0, 120),
            error: errorMessage(e),
          });
          return null; // best-effort — skip a failed sub-question
        }
      })
    );

    for (const r of results) {
      if (!r) continue;
      const { q, sub } = r;
      llmCalls += sub.llmCalls;

      // Tag each chart with the originating sub-question. SCHEMA-VALID ONLY:
      // append to _agentProvenance.sources; never add unknown keys (the planner
      // arg-repair / zod parse strips them). toolCalls is required → preserve it.
      const label = `Investigated sub-question: ${q.question}`.slice(0, 120);
      for (const c of sub.charts) {
        const existing = (c as {
          _agentProvenance?: { toolCalls?: unknown[]; sources?: string[] };
        })._agentProvenance;
        const tagged = {
          ...c,
          _agentProvenance: {
            ...(existing ?? {}),
            toolCalls: existing?.toolCalls ?? [],
            sources: [...(existing?.sources ?? []), label],
          },
        } as ChartSpecList[number];
        charts.push(tagged);
      }

      investigated.push({
        id: q.id,
        question: q.question,
        answer: sub.answer,
        chartCount: sub.charts.length,
      });

      // Resolve the matching open question so convergence / investigationSummary
      // / next-turn priorInvestigations reflect that it WAS investigated.
      if (ctx.blackboard) {
        const oq = ctx.blackboard.openQuestions.find(
          (x) => x.question === q.question && !x.actionedByNodeId
        );
        if (oq) markQuestionActioned(ctx.blackboard, oq.id, `followup_${oq.id}`);
      }

      // Per-sub progress event for the "Investigating further" surface (W6
      // registers it; emitting an unregistered name is harmless to the stream).
      emit?.("sub_question_investigated", {
        id: q.id,
        question: q.question,
        chartCount: sub.charts.length,
      });
    }
  }

  const wallMs = Date.now() - startedAt;
  agentLog("spawnedFollowUp.done", {
    investigated: investigated.length,
    queued: queue.length,
    charts: charts.length,
    llmCalls,
    wallMs,
    budgetHalted,
  });

  if (budgetHalted) {
    emit?.("flow_decision", {
      layer: "spawned-followup-budget",
      chosen: "halt",
      overriddenBy: "spawnedFollowUpBudget",
      reason: `Spawned follow-up halted on budget: ${llmCalls}/${config.maxLlmCalls} LLM calls, ${wallMs}/${config.maxWallMs}ms`.slice(
        0,
        500
      ),
    });
  }

  return { charts, investigated, llmCalls, wallMs, budgetHalted };
}
