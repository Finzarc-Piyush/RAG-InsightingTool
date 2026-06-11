/**
 * investigationOrchestrator.ts — bounded sub-investigation helper.
 *
 * Runs ONE sub-question as a single bounded `runAgentTurn` that shares the
 * parent blackboard and forwards its charts. Consumed by the single-flow
 * spawned-question follow-up pass (spawnedFollowUpPass.ts).
 *
 * NOTE: the deep-investigation BFS orchestrator (`runDeepInvestigation` /
 * `investigateNode`) was removed. It was a SECOND, divergent answer producer
 * gated behind DEEP_INVESTIGATION_ENABLED (default off) that replaced
 * `runAgentTurn`'s result with a minimal envelope (no answerEnvelope /
 * magnitudes / table / businessActions) — bypassing the canonical synthesis.
 * Only the shared `runSubInvestigation` primitive remains. The investigation
 * tree/blackboard/budget primitives are retained as a tested subsystem.
 */

import { runAgentTurn } from "./agentLoop.service.js";
import type { SpawnedQuestion } from "./investigationTree.js";
import type {
  AgentConfig,
  AgentExecutionContext,
  AgentLoopResult,
} from "./types.js";

type OnAgentEvent = NonNullable<Parameters<typeof runAgentTurn>[2]>;
type ChartSpecList = NonNullable<AgentLoopResult["charts"]>;

/** Result of one bounded sub-investigation turn (shared with the follow-up pass). */
export interface SubInvestigationResult {
  answer: string;
  /** B3 fix — charts produced by the sub-turn, forwarded (not discarded). */
  charts: ChartSpecList;
  spawnedQuestions: SpawnedQuestion[];
  llmCalls: number;
  wallMs: number;
}

/**
 * Run ONE sub-question as a single bounded runAgentTurn that SHARES the parent
 * blackboard (so its findings land in the parent store the narrator reads) and
 * FORWARDS its charts (B3 — previously discarded). The sub-turn context carries
 * `suppressSpawnedFollowUp` so it never triggers its own follow-up pass
 * (recursion guard). Caller owns the budget via `perTurnConfig`.
 *
 * Used by the single-flow spawned-question follow-up pass (spawnedFollowUpPass.ts).
 */
export async function runSubInvestigation(
  baseCtx: AgentExecutionContext,
  question: string,
  perTurnConfig: AgentConfig,
  onAgentEvent?: OnAgentEvent,
  /** Injectable for tests; defaults to the real agent loop in production. */
  runTurn: typeof runAgentTurn = runAgentTurn
): Promise<SubInvestigationResult> {
  const nodeCtx: AgentExecutionContext = {
    ...baseCtx,
    question,
    blackboard: baseCtx.blackboard,
    // Recursion guard — a sub-turn must never spawn its own follow-up pass.
    suppressSpawnedFollowUp: true,
  };

  const t0 = Date.now();
  let llmCalls = 0;

  const result = await runTurn(nodeCtx, perTurnConfig, (event, payload) => {
    if (event === "llm_call") llmCalls++;
    onAgentEvent?.(event, payload);
  });

  return {
    answer: result?.answer ?? "",
    charts: result?.charts ?? [],
    spawnedQuestions: result?.spawnedQuestions ?? [],
    llmCalls,
    wallMs: Date.now() - t0,
  };
}
