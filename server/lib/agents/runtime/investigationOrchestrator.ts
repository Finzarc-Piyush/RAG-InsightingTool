/**
 * Wave W9 · investigationOrchestrator
 *
 * BFS outer loop for deep self-directed investigations.
 * Activated only when DEEP_INVESTIGATION_ENABLED=true.
 *
 * Flow:
 *  1. Coordinator decomposes the question into root-level threads (or uses a
 *     single root node for simple questions).
 *  2. BFS loop: run ready nodes in parallel (up to maxParallelNodes at once).
 *     Each node calls runAgentTurn with a sub-question and the shared blackboard.
 *  3. After each batch: collect spawnedQuestions from node results, add child
 *     nodes within budget, check convergence.
 *  4. Convergence or budget exhausted → narrator synthesizes from full blackboard.
 */

import { agentLog } from "./agentLogger.js";
import {
  createTree,
  addChildNode,
  canAddNode,
  markNodeRunning,
  markNodeAnswered,
  pruneNode,
  getReadyNodes,
  hasPendingNodes,
  withinBudget,
  summarizeTree,
  isDeepInvestigationEnabled,
  loadDeepInvestigationConfig,
  type InvestigationTree,
  type SpawnedQuestion,
} from "./investigationTree.js";
import { createBlackboard, isConverged } from "./analyticalBlackboard.js";
import { decomposeQuestion } from "./coordinatorAgent.js";
import { runNarrator, shouldUseNarrator } from "./narratorAgent.js";
import { runAgentTurn } from "./agentLoop.service.js";
import { loadAgentConfigFromEnv } from "./types.js";
import type { AgentExecutionContext, AgentLoopResult } from "./types.js";

type OnAgentEvent = NonNullable<Parameters<typeof runAgentTurn>[2]>;

export { isDeepInvestigationEnabled };

/**
 * Run a single investigation node: one bounded runAgentTurn call with the
 * node's sub-question, shared blackboard, and a per-node budget.
 */
async function investigateNode(
  nodeId: string,
  tree: InvestigationTree,
  baseCtx: AgentExecutionContext,
  onAgentEvent?: OnAgentEvent
): Promise<{ nodeId: string; answer: string; spawnedQuestions: SpawnedQuestion[]; llmCalls: number; wallMs: number }> {
  const node = tree.nodes[nodeId];
  const config = loadAgentConfigFromEnv();
  const deepCfg = loadDeepInvestigationConfig();

  // Override per-node budget caps
  const perNodeConfig = {
    ...config,
    maxTotalLlmCallsPerTurn: deepCfg.perNodeLlmCalls,
    maxWallTimeMs: deepCfg.perNodeWallMs,
    maxSteps: Math.min(config.maxSteps, 8),
    maxToolCalls: Math.min(config.maxToolCalls, 20),
  };

  const nodeCtx: AgentExecutionContext = {
    ...baseCtx,
    question: node.question,
    blackboard: tree.blackboard,
  };

  const t0 = Date.now();
  let llmCalls = 0;

  const result = await runAgentTurn(
    nodeCtx,
    perNodeConfig,
    (event, payload) => {
      if (event === "llm_call") llmCalls++;
      onAgentEvent?.(event, payload);
    }
  );

  return {
    nodeId,
    answer: result?.answer ?? "",
    spawnedQuestions: result?.spawnedQuestions ?? [],
    llmCalls,
    wallMs: Date.now() - t0,
  };
}

/**
 * Main entry point. Returns an AgentLoopResult assembled from the full tree.
 * Falls back to null if deep investigation is disabled (caller uses single-turn).
 */
export async function runDeepInvestigation(
  ctx: AgentExecutionContext,
  onAgentEvent?: OnAgentEvent
): Promise<AgentLoopResult | null> {
  if (!isDeepInvestigationEnabled()) return null;

  const config = loadDeepInvestigationConfig();
  const blackboard = createBlackboard();
  ctx.blackboard = blackboard;

  // Build the tree: try coordinator decomposition first
  let tree: InvestigationTree;
  const threads = await decomposeQuestion(ctx, `di_${Date.now()}`, () => {});

  // O5: derive a request-scoped prefix to prevent node ID collisions in concurrent investigations.
  const idPrefix = `${(ctx.sessionId ?? "").slice(-6)}_${Date.now().toString(36)}_`;

  if (threads && threads.length > 0) {
    tree = createTree(ctx.question, blackboard, idPrefix);
    // Replace the single root with one child node per thread
    // (root stays as the original question; threads are depth-1 children)
    for (const t of threads) {
      const sq: SpawnedQuestion = {
        question: t.question,
        spawnReason: t.rationale,
        priority: "high",
        suggestedColumns: t.focusColumns,
      };
      if (canAddNode(tree, tree.rootId, config)) {
        addChildNode(tree, tree.rootId, sq);
      }
    }
    // Mark root as answered with a stub so its children become ready
    markNodeAnswered(tree, tree.rootId, ctx.question, { llmCalls: 1, wallMs: 0 });
  } else {
    tree = createTree(ctx.question, blackboard, idPrefix);
  }

  agentLog("investigationOrchestrator.start", {
    question: ctx.question.slice(0, 120),
    nodes: Object.keys(tree.nodes).length,
  });

  // BFS loop
  while (hasPendingNodes(tree) && withinBudget(tree, config)) {
    const batch = getReadyNodes(tree).slice(0, config.maxParallelNodes);
    if (batch.length === 0) break;

    for (const node of batch) markNodeRunning(tree, node.id);

    const results = await Promise.all(
      batch.map((node) => investigateNode(node.id, tree, ctx, onAgentEvent))
    );

    for (const r of results) {
      markNodeAnswered(tree, r.nodeId, r.answer, { llmCalls: r.llmCalls, wallMs: r.wallMs });

      // Spawn child nodes from anomalous findings
      for (const sq of r.spawnedQuestions) {
        if (canAddNode(tree, r.nodeId, config)) {
          addChildNode(tree, r.nodeId, sq);
          onAgentEvent?.("sub_question_spawned", { question: sq.question, parentNodeId: r.nodeId });
        }
      }

      onAgentEvent?.("node_answered", { nodeId: r.nodeId, answer: r.answer.slice(0, 200) });
    }

    onAgentEvent?.("investigation_progress", summarizeTree(tree));

    if (isConverged(blackboard)) {
      agentLog("investigationOrchestrator.converged", summarizeTree(tree));
      break;
    }

    // Prune low-priority pending nodes when budget >80% used
    const budgetFraction = tree.totalBudgetUsed.llmCalls / config.maxTotalLlmCalls;
    if (budgetFraction > 0.8) {
      for (const node of getReadyNodes(tree).filter((n) => {
        const parent = n.parentNodeId ? tree.nodes[n.parentNodeId] : null;
        return parent && (parent.spawnedChildIds.indexOf(n.id) > 0);
      })) {
        pruneNode(tree, node.id);
      }
    }
  }

  const summary = summarizeTree(tree);
  agentLog("investigationOrchestrator.done", summary);

  // Synthesize from the full blackboard via the narrator
  let answer = "";
  if (shouldUseNarrator(blackboard)) {
    const narResult = await runNarrator(ctx, blackboard, `di_synth_${Date.now()}`, () => {});
    if (narResult) {
      const body = narResult.body?.trim() ?? "";
      const ki = narResult.keyInsight?.trim();
      answer = ki ? `${body}\n\n**Key insight**: ${ki}` : body;
    }
  }

  if (!answer) {
    // Fallback: join node answers
    answer = Object.values(tree.nodes)
      .filter((n) => n.status === "answered" && n.answer)
      .map((n) => n.answer!)
      .join("\n\n---\n\n")
      .slice(0, 8000);
  }

  return {
    answer,
    blackboard,
    agentSuggestionHints: [],
  };
}
