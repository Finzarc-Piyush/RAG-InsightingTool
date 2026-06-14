/**
 * ============================================================================
 * investigationTree.ts — the data structure for a deep, branching investigation
 * ============================================================================
 * WHAT THIS FILE DOES
 *   For hard questions, the tool doesn't just answer once — it can break the
 *   question into sub-questions, answer those, and spawn further sub-questions
 *   from what it finds. This file defines the TREE that tracks all of that: a
 *   root question, child "nodes" (each a sub-question), each node's status
 *   (pending / running / answered / pruned), and a shared "blackboard" where
 *   every node writes findings that all other nodes can see. It explores
 *   breadth-first ("BFS" = answer all nodes at one level before going deeper).
 *   It also holds the budget caps (max depth, max nodes, max LLM calls, max
 *   wall-clock time) that stop a runaway investigation.
 *
 * WHY IT MATTERS
 *   This is pure bookkeeping — no LLM calls, no I/O, every change passed in as
 *   an explicit argument — which makes the deep-investigation engine easy to
 *   test and reason about. The orchestrator (investigationOrchestrator.ts)
 *   drives the actual thinking; this file is the safe scaffolding that keeps
 *   it bounded and ordered. Without the budget caps a deep investigation could
 *   loop forever or blow the cost ceiling.
 *
 * KEY PIECES
 *   - InvestigationTree / InvestigationNode — the tree and its nodes.
 *   - DeepInvestigationConfig + loadDeepInvestigationConfig — budget caps (env).
 *   - isDeepInvestigationEnabled — feature flag (DEEP_INVESTIGATION_ENABLED).
 *   - createTree / addChildNode / canAddNode — build and grow the tree safely.
 *   - markNodeRunning / markNodeAnswered / pruneNode — node state transitions.
 *   - getReadyNodes / hasPendingNodes / withinBudget — BFS scheduling helpers.
 *   - summarizeTree — a tally (nodes, depth, LLM calls, elapsed) for telemetry.
 *
 * HOW IT CONNECTS
 *   Consumed by investigationOrchestrator.ts, which runs the BFS loop. The
 *   shared blackboard type comes from analyticalBlackboard.js. This file only
 *   gates behind the DEEP_INVESTIGATION_ENABLED flag — it never calls models.
 */

import type { AnalyticalBlackboard } from "./analyticalBlackboard.js";
import { envInt, envFlagOn } from "../../envFlags.js";

// ─── Configuration ──────────────────────────────────────────────────────────

export interface DeepInvestigationConfig {
  /** Max recursion depth (root = 0). */
  maxDepth: number;
  /** Max total nodes across the whole tree. */
  maxNodes: number;
  /** Max LLM calls across the entire investigation. */
  maxTotalLlmCalls: number;
  /** Max wall-time in ms for the entire investigation. */
  maxTotalWallTimeMs: number;
  /** Max child nodes per parent. */
  maxChildrenPerNode: number;
  /** Max nodes running concurrently. */
  maxParallelNodes: number;
  /** LLM call budget per individual node. */
  perNodeLlmCalls: number;
  /** Wall-time budget per individual node in ms. */
  perNodeWallMs: number;
}

export function loadDeepInvestigationConfig(): DeepInvestigationConfig {
  const num = envInt;
  return {
    maxDepth: num(process.env.DEEP_INVESTIGATION_MAX_DEPTH, 3),
    maxNodes: num(process.env.DEEP_INVESTIGATION_MAX_NODES, 15),
    maxTotalLlmCalls: num(process.env.DEEP_INVESTIGATION_MAX_LLM_CALLS, 120),
    maxTotalWallTimeMs: num(process.env.DEEP_INVESTIGATION_MAX_WALL_MS, 1_500_000),
    maxChildrenPerNode: num(process.env.DEEP_INVESTIGATION_MAX_CHILDREN, 3),
    maxParallelNodes: num(process.env.DEEP_INVESTIGATION_MAX_PARALLEL, 3),
    perNodeLlmCalls: num(process.env.DEEP_INVESTIGATION_PER_NODE_LLM, 12),
    perNodeWallMs: num(process.env.DEEP_INVESTIGATION_PER_NODE_WALL_MS, 90_000),
  };
}

// Master switch for the BFS deep-investigation path (unwired by the single-flow
// policy, invariant #6). THE single definition — the byte-for-byte duplicate
// that used to sit in diagnosticPipelineConfig.ts was removed.
export function isDeepInvestigationEnabled(): boolean {
  return envFlagOn(process.env.DEEP_INVESTIGATION_ENABLED);
}

// ─── Spawned-question follow-up pass (single-flow) ───────────────────────────
//
// Distinct from deep investigation: this drives the in-turn auto-investigation
// of the reflector's "Investigating further" sub-questions. By design there is
// **no cap on the NUMBER of sub-questions** — the pass investigates every one —
// but it is hard-bounded by an aggregate LLM-call + wall-time budget so "no
// count cap" can never mean "no resource cap" (the only runaway brake, since
// each sub-turn is a full runAgentTurn with its own per-turn LLM counter).

export interface SpawnedFollowUpConfig {
  /** Aggregate LLM-call ceiling across ALL sub-investigations this turn. */
  maxLlmCalls: number;
  /** Aggregate wall-time ceiling (ms) across ALL sub-investigations this turn. */
  maxWallMs: number;
  /** How many sub-questions to investigate concurrently (small batches). */
  parallel: number;
  /** LLM-call budget for a single sub-investigation turn. */
  perSubLlmCalls: number;
  /** Wall-time budget (ms) for a single sub-investigation turn. */
  perSubWallMs: number;
  /** Plan-step cap for a single sub-investigation turn. */
  perSubMaxSteps: number;
  /** Tool-call cap for a single sub-investigation turn. */
  perSubMaxToolCalls: number;
}

export function loadSpawnedFollowUpConfig(): SpawnedFollowUpConfig {
  const num = envInt;
  return {
    maxLlmCalls: num(process.env.SPAWNED_FOLLOWUP_MAX_LLM_CALLS, 60),
    maxWallMs: num(process.env.SPAWNED_FOLLOWUP_MAX_WALL_MS, 120_000),
    parallel: Math.max(1, num(process.env.SPAWNED_FOLLOWUP_PARALLEL, 2)),
    perSubLlmCalls: num(process.env.SPAWNED_FOLLOWUP_PER_SUB_LLM, 8),
    perSubWallMs: num(process.env.SPAWNED_FOLLOWUP_PER_SUB_WALL_MS, 60_000),
    perSubMaxSteps: num(process.env.SPAWNED_FOLLOWUP_PER_SUB_STEPS, 6),
    perSubMaxToolCalls: num(process.env.SPAWNED_FOLLOWUP_PER_SUB_TOOL_CALLS, 15),
  };
}

export function isSpawnedFollowUpEnabled(): boolean {
  const v = process.env.SPAWNED_FOLLOWUP_ENABLED;
  return v === "true" || v === "1";
}

/**
 * Gate for the in-turn spawned-question follow-up pass. Pure (no env / no ctx
 * import) so it stays cycle-free and unit-testable. Fires only when the flag is
 * on, this is NOT already a sub-investigation (recursion guard), the turn is an
 * analysis turn, and the reflector actually spawned questions.
 */
export function shouldRunSpawnedFollowUp(
  enabled: boolean,
  opts: { suppress?: boolean; mode?: string; questionCount: number }
): boolean {
  return (
    enabled &&
    !opts.suppress &&
    opts.mode === "analysis" &&
    opts.questionCount > 0
  );
}

// ─── Node types ─────────────────────────────────────────────────────────────

export type NodeStatus = "pending" | "running" | "answered" | "pruned";

export interface SpawnedQuestion {
  /** Stable id (UUID) generated at spawn time so per-question feedback can target it. */
  id: string;
  question: string;
  spawnReason: string;
  priority: "high" | "medium" | "low";
  suggestedColumns: string[];
}

export interface InvestigationNode {
  id: string;
  question: string;
  parentNodeId: string | null;
  depth: number;
  spawnReason: string | null;
  status: NodeStatus;
  /** Condensed answer written by the node's investigateNode call. */
  answer: string | null;
  spawnedChildIds: string[];
  budgetUsed: { llmCalls: number; wallMs: number };
}

// ─── Tree ────────────────────────────────────────────────────────────────────

export interface InvestigationTree {
  rootId: string;
  nodes: Record<string, InvestigationNode>;
  /** Shared across ALL nodes — findings written by any node are visible to all. */
  blackboard: AnalyticalBlackboard;
  totalBudgetUsed: { llmCalls: number; wallMs: number };
  startedAt: number;
  /** Request-scoped prefix embedded in all node IDs to prevent collisions
   *  between concurrent investigations. */
  idPrefix: string;
}

// ─── Creation ────────────────────────────────────────────────────────────────

let _nodeSeq = 0;
function nextNodeId(prefix = ""): string {
  return `${prefix}node-${++_nodeSeq}`;
}

export function createTree(
  rootQuestion: string,
  blackboard: AnalyticalBlackboard,
  /** Request-scoped prefix to prevent node ID collisions in concurrent investigations. */
  idPrefix = ""
): InvestigationTree {
  const rootId = nextNodeId(idPrefix);
  return {
    rootId,
    nodes: {
      [rootId]: {
        id: rootId,
        question: rootQuestion,
        parentNodeId: null,
        depth: 0,
        spawnReason: null,
        status: "pending",
        answer: null,
        spawnedChildIds: [],
        budgetUsed: { llmCalls: 0, wallMs: 0 },
      },
    },
    blackboard,
    totalBudgetUsed: { llmCalls: 0, wallMs: 0 },
    startedAt: Date.now(),
    idPrefix,
  };
}

// ─── Node operations ─────────────────────────────────────────────────────────

export function canAddNode(
  tree: InvestigationTree,
  parentId: string,
  config: DeepInvestigationConfig
): boolean {
  const parent = tree.nodes[parentId];
  if (!parent) return false;
  if (parent.depth + 1 > config.maxDepth) return false;
  if (Object.keys(tree.nodes).length >= config.maxNodes) return false;
  if (parent.spawnedChildIds.length >= config.maxChildrenPerNode) return false;
  if (tree.totalBudgetUsed.llmCalls >= config.maxTotalLlmCalls) return false;
  if (Date.now() - tree.startedAt >= config.maxTotalWallTimeMs) return false;
  return true;
}

export function addChildNode(
  tree: InvestigationTree,
  parentId: string,
  sq: SpawnedQuestion
): InvestigationNode | null {
  const parent = tree.nodes[parentId];
  if (!parent) return null;
  const id = nextNodeId(tree.idPrefix);
  const node: InvestigationNode = {
    id,
    question: sq.question,
    parentNodeId: parentId,
    depth: parent.depth + 1,
    spawnReason: sq.spawnReason,
    status: "pending",
    answer: null,
    spawnedChildIds: [],
    budgetUsed: { llmCalls: 0, wallMs: 0 },
  };
  tree.nodes[id] = node;
  parent.spawnedChildIds.push(id);
  return node;
}

export function markNodeRunning(tree: InvestigationTree, nodeId: string): boolean {
  const node = tree.nodes[nodeId];
  if (!node || node.status !== "pending") return false;
  node.status = "running";
  return true;
}

export function markNodeAnswered(
  tree: InvestigationTree,
  nodeId: string,
  answer: string,
  budgetUsed: { llmCalls: number; wallMs: number }
): boolean {
  const node = tree.nodes[nodeId];
  if (!node) return false;
  node.status = "answered";
  node.answer = answer;
  node.budgetUsed = budgetUsed;
  tree.totalBudgetUsed.llmCalls += budgetUsed.llmCalls;
  tree.totalBudgetUsed.wallMs += budgetUsed.wallMs;
  return true;
}

export function pruneNode(tree: InvestigationTree, nodeId: string): boolean {
  const node = tree.nodes[nodeId];
  if (!node || node.status === "running" || node.status === "answered") return false;
  node.status = "pruned";
  return true;
}

// ─── BFS helpers ─────────────────────────────────────────────────────────────

/**
 * Returns nodes ready to run in the next BFS batch:
 * - pending nodes whose parent is answered (or whose parentNodeId is null = root).
 * - Does not include running/pruned/answered nodes.
 */
export function getReadyNodes(tree: InvestigationTree): InvestigationNode[] {
  return Object.values(tree.nodes).filter((n) => {
    if (n.status !== "pending") return false;
    if (n.parentNodeId === null) return true;
    const parent = tree.nodes[n.parentNodeId];
    return parent?.status === "answered";
  });
}

export function hasPendingNodes(tree: InvestigationTree): boolean {
  return Object.values(tree.nodes).some((n) => n.status === "pending" || n.status === "running");
}

export function withinBudget(
  tree: InvestigationTree,
  config: DeepInvestigationConfig
): boolean {
  if (tree.totalBudgetUsed.llmCalls >= config.maxTotalLlmCalls) return false;
  if (Date.now() - tree.startedAt >= config.maxTotalWallTimeMs) return false;
  return true;
}

// ─── Summary ─────────────────────────────────────────────────────────────────

export interface TreeSummary {
  totalNodes: number;
  answeredNodes: number;
  pendingNodes: number;
  runningNodes: number;
  prunedNodes: number;
  maxDepthReached: number;
  totalLlmCalls: number;
  elapsedMs: number;
}

export function summarizeTree(tree: InvestigationTree): TreeSummary {
  const nodes = Object.values(tree.nodes);
  return {
    totalNodes: nodes.length,
    answeredNodes: nodes.filter((n) => n.status === "answered").length,
    pendingNodes: nodes.filter((n) => n.status === "pending").length,
    runningNodes: nodes.filter((n) => n.status === "running").length,
    prunedNodes: nodes.filter((n) => n.status === "pruned").length,
    maxDepthReached: Math.max(...nodes.map((n) => n.depth)),
    totalLlmCalls: tree.totalBudgetUsed.llmCalls,
    elapsedMs: Date.now() - tree.startedAt,
  };
}
