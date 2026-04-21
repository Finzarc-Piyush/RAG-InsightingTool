import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createBlackboard, addFinding, addHypothesis, resolveHypothesis, isConverged } from "../lib/agents/runtime/analyticalBlackboard.js";
import {
  createTree,
  addChildNode,
  markNodeAnswered,
  getReadyNodes,
  hasPendingNodes,
  withinBudget,
  summarizeTree,
  isDeepInvestigationEnabled,
  loadDeepInvestigationConfig,
  type DeepInvestigationConfig,
  type SpawnedQuestion,
} from "../lib/agents/runtime/investigationTree.js";

/**
 * Wave W9 · investigationOrchestrator unit tests.
 *
 * runDeepInvestigation requires a live LLM + environment. We test the pure
 * BFS orchestration logic that is already unit-tested through the tree primitives,
 * plus the convergence and budget guard paths that gate the loop.
 */

const cfg: DeepInvestigationConfig = {
  maxDepth: 3,
  maxNodes: 10,
  maxTotalLlmCalls: 30,
  maxTotalWallTimeMs: 600_000,
  maxChildrenPerNode: 3,
  maxParallelNodes: 3,
  perNodeLlmCalls: 6,
  perNodeWallMs: 30_000,
};

function sq(question: string): SpawnedQuestion {
  return { question, spawnReason: "anomaly", priority: "high", suggestedColumns: [] };
}

describe("BFS orchestration logic — tree state transitions", () => {
  it("root node is ready immediately after tree creation", () => {
    const bb = createBlackboard();
    const tree = createTree("Why did sales drop?", bb);
    const ready = getReadyNodes(tree);
    assert.strictEqual(ready.length, 1);
    assert.strictEqual(ready[0].id, tree.rootId);
  });

  it("child nodes become ready only after parent answered", () => {
    const bb = createBlackboard();
    const tree = createTree("Root", bb);
    const c1 = addChildNode(tree, tree.rootId, sq("Child A"))!;
    const c2 = addChildNode(tree, tree.rootId, sq("Child B"))!;
    // Root still pending → no children ready
    assert.strictEqual(getReadyNodes(tree).length, 1); // only root
    // Answer root
    markNodeAnswered(tree, tree.rootId, "root done", { llmCalls: 2, wallMs: 500 });
    const ready = getReadyNodes(tree);
    assert.strictEqual(ready.length, 2);
    assert.ok(ready.some((n) => n.id === c1.id));
    assert.ok(ready.some((n) => n.id === c2.id));
  });

  it("hasPendingNodes returns false when all nodes answered", () => {
    const bb = createBlackboard();
    const tree = createTree("Root", bb);
    markNodeAnswered(tree, tree.rootId, "done", { llmCalls: 1, wallMs: 100 });
    assert.strictEqual(hasPendingNodes(tree), false);
  });

  it("BFS batch simulation: 3 parallel nodes answered, budget accumulated", () => {
    const bb = createBlackboard();
    const tree = createTree("Root", bb);
    // Simulate coordinator decomposing to 3 threads
    markNodeAnswered(tree, tree.rootId, "root", { llmCalls: 1, wallMs: 0 });
    const c1 = addChildNode(tree, tree.rootId, sq("Thread A"))!;
    const c2 = addChildNode(tree, tree.rootId, sq("Thread B"))!;
    const c3 = addChildNode(tree, tree.rootId, sq("Thread C"))!;

    const batch = getReadyNodes(tree);
    assert.strictEqual(batch.length, 3);

    // Simulate parallel execution
    markNodeAnswered(tree, c1.id, "A done", { llmCalls: 5, wallMs: 2000 });
    markNodeAnswered(tree, c2.id, "B done", { llmCalls: 4, wallMs: 1500 });
    markNodeAnswered(tree, c3.id, "C done", { llmCalls: 6, wallMs: 2500 });

    assert.strictEqual(tree.totalBudgetUsed.llmCalls, 1 + 5 + 4 + 6);
    assert.strictEqual(hasPendingNodes(tree), false);
  });

  it("withinBudget returns false after exhausting LLM calls", () => {
    const bb = createBlackboard();
    const tree = createTree("Root", bb);
    tree.totalBudgetUsed.llmCalls = cfg.maxTotalLlmCalls;
    assert.strictEqual(withinBudget(tree, cfg), false);
  });
});

describe("convergence detection in BFS loop", () => {
  it("blackboard isConverged returns true after all hypotheses resolved and findings present", () => {
    const bb = createBlackboard();
    const h = addHypothesis(bb, "East drove the drop");
    resolveHypothesis(bb, h.id, "confirmed", "callId-1");
    addFinding(bb, { sourceRef: "callId-1", label: "East -23%", detail: "detail" });
    assert.strictEqual(isConverged(bb), true);
  });

  it("blackboard isConverged returns false while hypotheses are still open", () => {
    const bb = createBlackboard();
    addHypothesis(bb, "Untested hypothesis");
    addFinding(bb, { sourceRef: "c1", label: "F1", detail: "d" });
    assert.strictEqual(isConverged(bb), false);
  });

  it("empty blackboard never converges", () => {
    const bb = createBlackboard();
    assert.strictEqual(isConverged(bb), false);
  });
});

describe("summarizeTree after multi-node investigation", () => {
  it("counts correctly across depth levels", () => {
    const bb = createBlackboard();
    const tree = createTree("Root", bb);
    markNodeAnswered(tree, tree.rootId, "root done", { llmCalls: 2, wallMs: 100 });
    const c1 = addChildNode(tree, tree.rootId, sq("C1"))!;
    const c2 = addChildNode(tree, tree.rootId, sq("C2"))!;
    markNodeAnswered(tree, c1.id, "c1 done", { llmCalls: 4, wallMs: 200 });
    const gc1 = addChildNode(tree, c1.id, sq("GC1"))!;

    const s = summarizeTree(tree);
    assert.strictEqual(s.totalNodes, 4);
    assert.strictEqual(s.answeredNodes, 2);
    assert.strictEqual(s.pendingNodes, 2); // c2, gc1
    assert.strictEqual(s.maxDepthReached, 2);
    assert.strictEqual(s.totalLlmCalls, 6);
  });
});

describe("isDeepInvestigationEnabled", () => {
  it("returns false when DEEP_INVESTIGATION_ENABLED is not set", () => {
    delete process.env.DEEP_INVESTIGATION_ENABLED;
    assert.strictEqual(isDeepInvestigationEnabled(), false);
  });

  it("returns true when set to '1'", () => {
    process.env.DEEP_INVESTIGATION_ENABLED = "1";
    assert.strictEqual(isDeepInvestigationEnabled(), true);
    delete process.env.DEEP_INVESTIGATION_ENABLED;
  });
});

describe("loadDeepInvestigationConfig defaults", () => {
  it("provides safe defaults for all fields", () => {
    const c = loadDeepInvestigationConfig();
    assert.ok(c.maxDepth >= 1);
    assert.ok(c.maxNodes >= 5);
    assert.ok(c.maxTotalLlmCalls >= 60);
    assert.ok(c.perNodeLlmCalls >= 6);
    assert.ok(c.maxParallelNodes >= 1);
  });
});
