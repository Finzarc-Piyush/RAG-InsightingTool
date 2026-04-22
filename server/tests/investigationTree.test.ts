import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { createBlackboard } from "../lib/agents/runtime/analyticalBlackboard.js";
import {
  createTree,
  addChildNode,
  markNodeRunning,
  markNodeAnswered,
  pruneNode,
  getReadyNodes,
  hasPendingNodes,
  withinBudget,
  canAddNode,
  summarizeTree,
  loadDeepInvestigationConfig,
  isDeepInvestigationEnabled,
  type SpawnedQuestion,
  type DeepInvestigationConfig,
} from "../lib/agents/runtime/investigationTree.js";

const cfg: DeepInvestigationConfig = {
  maxDepth: 3,
  maxNodes: 15,
  maxTotalLlmCalls: 120,
  maxTotalWallTimeMs: 1_500_000,
  maxChildrenPerNode: 3,
  maxParallelNodes: 3,
  perNodeLlmCalls: 12,
  perNodeWallMs: 90_000,
};

function sq(question: string, priority: SpawnedQuestion["priority"] = "medium"): SpawnedQuestion {
  return { question, spawnReason: "test reason", priority, suggestedColumns: [] };
}

describe("createTree", () => {
  it("creates a tree with a single root node", () => {
    const bb = createBlackboard();
    const tree = createTree("Why did sales drop?", bb);
    assert.strictEqual(Object.keys(tree.nodes).length, 1);
    const root = tree.nodes[tree.rootId];
    assert.strictEqual(root.question, "Why did sales drop?");
    assert.strictEqual(root.parentNodeId, null);
    assert.strictEqual(root.depth, 0);
    assert.strictEqual(root.status, "pending");
  });

  it("root node shares the provided blackboard", () => {
    const bb = createBlackboard();
    const tree = createTree("Q", bb);
    assert.strictEqual(tree.blackboard, bb);
  });
});

describe("addChildNode", () => {
  it("adds a child under the root", () => {
    const bb = createBlackboard();
    const tree = createTree("Root Q", bb);
    const child = addChildNode(tree, tree.rootId, sq("Sub Q"));
    assert.ok(child);
    assert.strictEqual(child!.parentNodeId, tree.rootId);
    assert.strictEqual(child!.depth, 1);
    assert.strictEqual(child!.status, "pending");
    assert.ok(tree.nodes[tree.rootId].spawnedChildIds.includes(child!.id));
  });

  it("returns null for unknown parentId", () => {
    const bb = createBlackboard();
    const tree = createTree("Root", bb);
    const result = addChildNode(tree, "nonexistent", sq("Sub Q"));
    assert.strictEqual(result, null);
  });

  it("depth increments correctly through multiple levels", () => {
    const bb = createBlackboard();
    const tree = createTree("Root", bb);
    const d1 = addChildNode(tree, tree.rootId, sq("D1"))!;
    const d2 = addChildNode(tree, d1.id, sq("D2"))!;
    const d3 = addChildNode(tree, d2.id, sq("D3"))!;
    assert.strictEqual(d3.depth, 3);
  });
});

describe("canAddNode", () => {
  it("returns false when maxDepth exceeded", () => {
    const bb = createBlackboard();
    const tree = createTree("Root", bb);
    const d1 = addChildNode(tree, tree.rootId, sq("D1"))!;
    const d2 = addChildNode(tree, d1.id, sq("D2"))!;
    const d3 = addChildNode(tree, d2.id, sq("D3"))!;
    // d3 is at depth 3 = maxDepth; adding a child would be depth 4
    assert.strictEqual(canAddNode(tree, d3.id, cfg), false);
  });

  it("returns false when maxNodes reached", () => {
    const smallCfg: DeepInvestigationConfig = { ...cfg, maxNodes: 2 };
    const bb = createBlackboard();
    const tree = createTree("Root", bb);
    addChildNode(tree, tree.rootId, sq("D1"));
    // Now 2 nodes = maxNodes
    assert.strictEqual(canAddNode(tree, tree.rootId, smallCfg), false);
  });

  it("returns false when maxChildrenPerNode reached", () => {
    const tightCfg: DeepInvestigationConfig = { ...cfg, maxChildrenPerNode: 1 };
    const bb = createBlackboard();
    const tree = createTree("Root", bb);
    addChildNode(tree, tree.rootId, sq("Child 1"));
    assert.strictEqual(canAddNode(tree, tree.rootId, tightCfg), false);
  });

  it("returns true when all limits are within budget", () => {
    const bb = createBlackboard();
    const tree = createTree("Root", bb);
    assert.strictEqual(canAddNode(tree, tree.rootId, cfg), true);
  });

  it("returns false when LLM budget exhausted", () => {
    const tightCfg: DeepInvestigationConfig = { ...cfg, maxTotalLlmCalls: 0 };
    const bb = createBlackboard();
    const tree = createTree("Root", bb);
    assert.strictEqual(canAddNode(tree, tree.rootId, tightCfg), false);
  });
});

describe("markNodeRunning / markNodeAnswered / pruneNode", () => {
  it("markNodeRunning sets status to running", () => {
    const bb = createBlackboard();
    const tree = createTree("Root", bb);
    assert.strictEqual(markNodeRunning(tree, tree.rootId), true);
    assert.strictEqual(tree.nodes[tree.rootId].status, "running");
  });

  it("markNodeRunning returns false for non-pending node", () => {
    const bb = createBlackboard();
    const tree = createTree("Root", bb);
    markNodeRunning(tree, tree.rootId);
    assert.strictEqual(markNodeRunning(tree, tree.rootId), false);
  });

  it("markNodeAnswered sets answer and accumulates budget", () => {
    const bb = createBlackboard();
    const tree = createTree("Root", bb);
    markNodeAnswered(tree, tree.rootId, "East drove the drop", { llmCalls: 5, wallMs: 10_000 });
    assert.strictEqual(tree.nodes[tree.rootId].status, "answered");
    assert.strictEqual(tree.nodes[tree.rootId].answer, "East drove the drop");
    assert.strictEqual(tree.totalBudgetUsed.llmCalls, 5);
    assert.strictEqual(tree.totalBudgetUsed.wallMs, 10_000);
  });

  it("pruneNode sets status to pruned for pending nodes", () => {
    const bb = createBlackboard();
    const tree = createTree("Root", bb);
    const child = addChildNode(tree, tree.rootId, sq("Low priority sub-Q"))!;
    assert.strictEqual(pruneNode(tree, child.id), true);
    assert.strictEqual(tree.nodes[child.id].status, "pruned");
  });

  it("pruneNode returns false for running or answered nodes", () => {
    const bb = createBlackboard();
    const tree = createTree("Root", bb);
    markNodeRunning(tree, tree.rootId);
    assert.strictEqual(pruneNode(tree, tree.rootId), false);
  });
});

describe("getReadyNodes", () => {
  it("returns root node when it is pending", () => {
    const bb = createBlackboard();
    const tree = createTree("Root", bb);
    const ready = getReadyNodes(tree);
    assert.strictEqual(ready.length, 1);
    assert.strictEqual(ready[0].id, tree.rootId);
  });

  it("returns child nodes only after parent is answered", () => {
    const bb = createBlackboard();
    const tree = createTree("Root", bb);
    const child = addChildNode(tree, tree.rootId, sq("Child"))!;
    // Parent still pending → child not ready
    assert.ok(!getReadyNodes(tree).some((n) => n.id === child.id));
    // Answer parent → child becomes ready
    markNodeAnswered(tree, tree.rootId, "root answer", { llmCalls: 1, wallMs: 100 });
    assert.ok(getReadyNodes(tree).some((n) => n.id === child.id));
  });

  it("does not return running or pruned nodes", () => {
    const bb = createBlackboard();
    const tree = createTree("Root", bb);
    markNodeRunning(tree, tree.rootId);
    assert.strictEqual(getReadyNodes(tree).length, 0);
  });
});

describe("hasPendingNodes / withinBudget", () => {
  it("hasPendingNodes is true when root is pending", () => {
    const bb = createBlackboard();
    const tree = createTree("Root", bb);
    assert.strictEqual(hasPendingNodes(tree), true);
  });

  it("hasPendingNodes is false when all nodes answered/pruned", () => {
    const bb = createBlackboard();
    const tree = createTree("Root", bb);
    markNodeAnswered(tree, tree.rootId, "done", { llmCalls: 1, wallMs: 100 });
    assert.strictEqual(hasPendingNodes(tree), false);
  });

  it("withinBudget is false when LLM cap exceeded", () => {
    const bb = createBlackboard();
    const tree = createTree("Root", bb);
    tree.totalBudgetUsed.llmCalls = 120;
    assert.strictEqual(withinBudget(tree, cfg), false);
  });

  it("withinBudget is true for a fresh tree", () => {
    const bb = createBlackboard();
    const tree = createTree("Root", bb);
    assert.strictEqual(withinBudget(tree, cfg), true);
  });
});

describe("summarizeTree", () => {
  it("counts nodes by status", () => {
    const bb = createBlackboard();
    const tree = createTree("Root", bb);
    const c1 = addChildNode(tree, tree.rootId, sq("C1"))!;
    markNodeAnswered(tree, tree.rootId, "ans", { llmCalls: 2, wallMs: 500 });
    markNodeRunning(tree, c1.id);
    const summary = summarizeTree(tree);
    assert.strictEqual(summary.totalNodes, 2);
    assert.strictEqual(summary.answeredNodes, 1);
    assert.strictEqual(summary.runningNodes, 1);
    assert.strictEqual(summary.pendingNodes, 0);
    assert.strictEqual(summary.maxDepthReached, 1);
    assert.strictEqual(summary.totalLlmCalls, 2);
  });
});

describe("loadDeepInvestigationConfig", () => {
  it("returns defaults when env vars are unset", () => {
    const c = loadDeepInvestigationConfig();
    assert.strictEqual(c.maxDepth, 3);
    assert.strictEqual(c.maxNodes, 15);
    assert.strictEqual(c.maxTotalLlmCalls, 120);
    assert.strictEqual(c.perNodeLlmCalls, 12);
  });
});

describe("isDeepInvestigationEnabled", () => {
  it("returns false when env var is unset", () => {
    delete process.env.DEEP_INVESTIGATION_ENABLED;
    assert.strictEqual(isDeepInvestigationEnabled(), false);
  });

  it("returns true when env var is 'true'", () => {
    process.env.DEEP_INVESTIGATION_ENABLED = "true";
    assert.strictEqual(isDeepInvestigationEnabled(), true);
    delete process.env.DEEP_INVESTIGATION_ENABLED;
  });
});

describe("O5: idPrefix namespacing prevents node ID collisions", () => {
  it("two trees with different prefixes produce non-colliding node IDs", () => {
    const bb1 = createBlackboard();
    const bb2 = createBlackboard();
    const treeA = createTree("question A", bb1, "sessionA_");
    const treeB = createTree("question B", bb2, "sessionB_");
    assert.notStrictEqual(treeA.rootId, treeB.rootId);
    assert.ok(treeA.rootId.startsWith("sessionA_"));
    assert.ok(treeB.rootId.startsWith("sessionB_"));
  });

  it("child nodes inherit the parent tree idPrefix", () => {
    const bb = createBlackboard();
    const tree = createTree("root question", bb, "pfx_");
    const sq: SpawnedQuestion = {
      question: "child question",
      spawnReason: "anomaly found",
      priority: "high",
      suggestedColumns: [],
    };
    const config = loadDeepInvestigationConfig();
    assert.ok(canAddNode(tree, tree.rootId, config));
    const child = addChildNode(tree, tree.rootId, sq);
    assert.ok(child !== null);
    assert.ok(child!.id.startsWith("pfx_"));
  });

  it("trees with no prefix still work (empty prefix)", () => {
    const bb = createBlackboard();
    const tree = createTree("question", bb);
    assert.ok(tree.rootId.startsWith("node-"));
    assert.strictEqual(tree.idPrefix, "");
  });
});
