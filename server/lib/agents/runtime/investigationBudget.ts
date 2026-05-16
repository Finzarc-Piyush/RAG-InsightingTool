/**
 * Wave W74 · investigation budget exhaustion detector.
 *
 * Pure helper that inspects an `InvestigationTree` + `DeepInvestigationConfig`
 * and reports WHY the deep-investigation loop would terminate (or has
 * terminated) on budget grounds, so the orchestrator can surface a
 * `flow_decision` SSE row with a specific reason instead of silently
 * stopping when `withinBudget` flips false.
 *
 * Closes the second item of Workstream 3 (W74) from the [1000x master
 * plan](/Users/tida/.claude/plans/go-through-the-entire-partitioned-yao.md): *hard budget caps with
 * explicit observability when they trigger*.
 *
 * Three exhaustion reasons (priority-ordered — same priority the
 * `withinBudget` + `canAddNode` checks already enforce):
 *
 *  - `llm_calls_exhausted` — `totalBudgetUsed.llmCalls >= maxTotalLlmCalls`.
 *  - `wall_time_exhausted` — `elapsedMs >= maxTotalWallTimeMs`.
 *  - `max_nodes_reached` — total node count >= `maxNodes`. Soft cap: the
 *    loop may still drain pending nodes but no new children can be spawned.
 *
 * Returns `null` when budget remains.
 */

import type {
  DeepInvestigationConfig,
  InvestigationTree,
} from "./investigationTree.js";

export type BudgetExhaustionReason =
  | "llm_calls_exhausted"
  | "wall_time_exhausted"
  | "max_nodes_reached";

export interface BudgetExhaustionDetails {
  reason: BudgetExhaustionReason;
  /** Resource value at the moment of exhaustion. */
  used: number;
  /** Configured cap for the same resource. */
  cap: number;
  /** Human-readable explanation suitable for SSE / agentLog payloads. */
  message: string;
}

/** Pure check. Inspects tree + config and returns the first triggered
 *  reason in priority order. Returns null when within budget. */
export function evaluateBudgetExhaustion(
  tree: InvestigationTree,
  config: DeepInvestigationConfig,
  nowMs: number = Date.now(),
): BudgetExhaustionDetails | null {
  if (tree.totalBudgetUsed.llmCalls >= config.maxTotalLlmCalls) {
    return {
      reason: "llm_calls_exhausted",
      used: tree.totalBudgetUsed.llmCalls,
      cap: config.maxTotalLlmCalls,
      message: formatMessage(
        "llm_calls_exhausted",
        tree.totalBudgetUsed.llmCalls,
        config.maxTotalLlmCalls,
      ),
    };
  }
  const elapsedMs = nowMs - tree.startedAt;
  if (elapsedMs >= config.maxTotalWallTimeMs) {
    return {
      reason: "wall_time_exhausted",
      used: elapsedMs,
      cap: config.maxTotalWallTimeMs,
      message: formatMessage(
        "wall_time_exhausted",
        elapsedMs,
        config.maxTotalWallTimeMs,
      ),
    };
  }
  const nodeCount = Object.keys(tree.nodes).length;
  if (nodeCount >= config.maxNodes) {
    return {
      reason: "max_nodes_reached",
      used: nodeCount,
      cap: config.maxNodes,
      message: formatMessage(
        "max_nodes_reached",
        nodeCount,
        config.maxNodes,
      ),
    };
  }
  return null;
}

/** Build the canonical message string for a given reason + used/cap. */
export function formatBudgetExhaustionMessage(
  reason: BudgetExhaustionReason,
  used: number,
  cap: number,
): string {
  return formatMessage(reason, used, cap);
}

function formatMessage(reason: BudgetExhaustionReason, used: number, cap: number): string {
  switch (reason) {
    case "llm_calls_exhausted":
      return `Investigation halted: LLM call budget exhausted (${used} / ${cap}).`;
    case "wall_time_exhausted":
      return `Investigation halted: wall-time budget exhausted (${used} ms / ${cap} ms).`;
    case "max_nodes_reached":
      return `Investigation halted: max node count reached (${used} / ${cap}). Pending nodes pruned.`;
  }
}
