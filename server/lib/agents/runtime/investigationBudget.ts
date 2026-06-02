/**
 * ============================================================================
 * investigationBudget.ts — tells you WHY a deep investigation must stop
 * ============================================================================
 * WHAT THIS FILE DOES
 *   A "deep investigation" is the bigger, multi-branch version of answering a
 *   question: the agent spawns a tree of sub-questions and keeps digging. To
 *   avoid running forever (and burning money), it has hard budget caps — a max
 *   number of LLM calls, a max wall-clock time, and a max number of tree nodes.
 *   This file is a small pure helper (no I/O, no side effects) that looks at the
 *   current investigation tree plus its budget config and reports the FIRST cap
 *   that has been hit, with a human-readable explanation. Returns `null` while
 *   there is still budget left.
 *
 * WHY IT MATTERS
 *   Without this, the loop would just silently stop when budget ran out, leaving
 *   no trace of why. Here it produces a specific reason so the orchestrator can
 *   show the user (via a `flow_decision` SSE row / agent log) exactly which limit
 *   triggered the halt — observability for the hard budget caps.
 *
 * KEY PIECES
 *   - BudgetExhaustionReason — the three reasons: "llm_calls_exhausted",
 *     "wall_time_exhausted", "max_nodes_reached".
 *   - evaluateBudgetExhaustion — the main check; returns the first triggered
 *     reason in priority order, or null when within budget.
 *   - formatBudgetExhaustionMessage — builds the canonical message string.
 *
 * HOW IT CONNECTS
 *   Reads types from investigationTree.js (InvestigationTree, DeepInvestigationConfig).
 *   Called by the deep-investigation orchestrator to decide when to stop and what
 *   reason to emit.
 *
 * NOTE on the three caps:
 *   max_nodes is a SOFT cap — the loop may still drain already-pending nodes but
 *   cannot spawn new children once reached. The other two are hard halts.
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
