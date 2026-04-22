/**
 * Wave W7 · investigationTree
 *
 * Types and pure-function operations for the BFS investigation tree.
 * No I/O, no LLM calls — all state mutations are explicit arguments.
 */

import type { AnalyticalBlackboard } from "./analyticalBlackboard.js";

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
  const num = (v: string | undefined, d: number) => {
    const n = v ? parseInt(v, 10) : NaN;
    return Number.isFinite(n) ? n : d;
  };
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

export function isDeepInvestigationEnabled(): boolean {
  const v = process.env.DEEP_INVESTIGATION_ENABLED;
  return v === "true" || v === "1";
}

// ─── Node types ─────────────────────────────────────────────────────────────

export type NodeStatus = "pending" | "running" | "answered" | "pruned";

export interface SpawnedQuestion {
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
  /** O5: request-scoped prefix embedded in all node IDs to prevent collisions. */
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
  /** O5: request-scoped prefix to prevent node ID collisions in concurrent investigations. */
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
