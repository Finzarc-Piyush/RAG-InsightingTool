/**
 * ============================================================================
 * investigationOrchestrator.ts — the driver of a deep, self-directed inquiry
 * ============================================================================
 * WHAT THIS FILE DOES
 *   This is the "outer loop" for the deep-investigation mode. Given a hard
 *   question, it: (1) asks a coordinator to split it into a few parallel
 *   "threads" (sub-questions); (2) runs them breadth-first — answering a batch
 *   of ready sub-questions at once, each via one bounded agent turn that shares
 *   a common "blackboard" of findings; (3) lets answered nodes spawn fresh
 *   sub-questions when something surprising turns up, adding them to the tree
 *   as long as budget allows; (4) stops when the investigation "converges"
 *   (enough is known) or the budget runs out, then has the narrator write one
 *   synthesized answer from everything on the blackboard. ("BFS" =
 *   breadth-first search; it widens before it deepens.)
 *
 * WHY IT MATTERS
 *   This is the engine behind genuinely multi-step research answers, instead
 *   of a single shot. It is gated entirely behind DEEP_INVESTIGATION_ENABLED;
 *   if that flag is off, runDeepInvestigation returns null and the caller uses
 *   the normal single-turn flow. The budget caps and pruning keep a branching
 *   investigation from running forever or overspending. SSE rows (`flow_decision`,
 *   `sub_question_spawned`, `node_answered`, `investigation_progress`) make the
 *   inner workings visible to the UI as it runs.
 *
 * KEY PIECES
 *   - runDeepInvestigation — main entry; builds the tree, runs the BFS loop,
 *       synthesizes the final answer. Returns null when the flag is off.
 *   - investigateNode — runs ONE sub-question as a bounded agent turn.
 *   - isDeepInvestigationEnabled — re-exported flag check.
 *
 * HOW IT CONNECTS
 *   Uses investigationTree.js for the tree/budget bookkeeping, coordinatorAgent
 *   (decomposeQuestion) to split the question, agentLoop.service (runAgentTurn)
 *   to answer each node, analyticalBlackboard for the shared findings store,
 *   investigationBudget (evaluateBudgetExhaustion) to detect a budget halt, and
 *   narratorAgent (runNarrator) to write the final synthesized answer.
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
import type { AgentConfig, AgentExecutionContext, AgentLoopResult } from "./types.js";
import { evaluateBudgetExhaustion } from "./investigationBudget.js";

type OnAgentEvent = NonNullable<Parameters<typeof runAgentTurn>[2]>;
type ChartSpecList = NonNullable<AgentLoopResult["charts"]>;

export { isDeepInvestigationEnabled };

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
 * Reused by (a) investigateNode in the deep-investigation BFS and (b) the
 * single-flow spawned-question follow-up pass (spawnedFollowUpPass.ts).
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

/**
 * Run a single investigation node: one bounded runSubInvestigation with the
 * node's sub-question, shared blackboard, and a per-node budget.
 */
async function investigateNode(
  nodeId: string,
  tree: InvestigationTree,
  baseCtx: AgentExecutionContext,
  onAgentEvent?: OnAgentEvent
): Promise<{ nodeId: string } & SubInvestigationResult> {
  const node = tree.nodes[nodeId];
  const config = loadAgentConfigFromEnv();
  const deepCfg = loadDeepInvestigationConfig();

  // Override per-node budget caps
  const perNodeConfig: AgentConfig = {
    ...config,
    maxTotalLlmCallsPerTurn: deepCfg.perNodeLlmCalls,
    maxWallTimeMs: deepCfg.perNodeWallMs,
    maxSteps: Math.min(config.maxSteps, 8),
    maxToolCalls: Math.min(config.maxToolCalls, 20),
  };

  // Share the tree blackboard (== baseCtx.blackboard in runDeepInvestigation).
  const sub = await runSubInvestigation(
    { ...baseCtx, blackboard: tree.blackboard },
    node.question,
    perNodeConfig,
    onAgentEvent
  );

  return { nodeId, ...sub };
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

  if (threads && threads.length > 0) {
    try {
      onAgentEvent?.("flow_decision", {
        layer: "coordinator-decompose",
        chosen: "multi-thread",
        overriddenBy: "coordinatorAgent",
        reason: `Decomposed root question into ${threads.length} parallel thread(s) (single-turn plan abandoned).`.slice(0, 500),
        candidates: threads.slice(0, 8).map((t) => t.question.slice(0, 200)),
      });
    } catch {
      /* ignore */
    }
  }

  // Derive a request-scoped prefix to prevent node ID collisions in concurrent investigations.
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

  // B4 fix — aggregate charts produced by every investigated node so the
  // orchestrator return is no longer chart-less.
  const collectedCharts: ChartSpecList = [];

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

      // B4 — keep each node's charts; the narrator answer alone is chart-less.
      if (r.charts.length) collectedCharts.push(...r.charts);

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

  // Emit a flow_decision SSE row when the BFS loop terminated on a budget
  // cap (rather than converging or running out of pending nodes). Pure
  // detector — no behaviour change, just observability.
  const budgetExhaustion = evaluateBudgetExhaustion(tree, config);
  if (budgetExhaustion) {
    try {
      onAgentEvent?.("flow_decision", {
        layer: "investigation-budget",
        chosen: "halt",
        overriddenBy: "investigationBudget",
        reason: budgetExhaustion.message.slice(0, 500),
        candidates: [
          `${budgetExhaustion.reason}: ${budgetExhaustion.used} / ${budgetExhaustion.cap}`,
        ],
      });
    } catch {
      /* ignore — SSE is best-effort */
    }
    agentLog("investigationOrchestrator.budget_exhausted", {
      reason: budgetExhaustion.reason,
      used: budgetExhaustion.used,
      cap: budgetExhaustion.cap,
    });
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
    // B4 — surface the charts produced across all investigated nodes so the
    // caller (dataAnalyzer.answerQuestion) and the UI actually receive them.
    ...(collectedCharts.length ? { charts: collectedCharts } : {}),
    blackboard,
    agentSuggestionHints: [],
  };
}
