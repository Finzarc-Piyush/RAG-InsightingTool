import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateBudgetExhaustion,
  formatBudgetExhaustionMessage,
} from "../lib/agents/runtime/investigationBudget.js";
import type {
  DeepInvestigationConfig,
  InvestigationTree,
} from "../lib/agents/runtime/investigationTree.js";

const baseConfig = (overrides: Partial<DeepInvestigationConfig> = {}): DeepInvestigationConfig => ({
  maxDepth: 3,
  maxNodes: 5,
  maxTotalLlmCalls: 80,
  maxTotalWallTimeMs: 60_000,
  maxChildrenPerNode: 3,
  maxParallelNodes: 3,
  perNodeLlmCalls: 12,
  perNodeWallMs: 30_000,
  ...overrides,
});

const baseTree = (overrides: Partial<InvestigationTree> = {}): InvestigationTree => ({
  rootId: "root",
  nodes: {
    root: {
      id: "root",
      question: "q",
      parentNodeId: null,
      depth: 0,
      spawnReason: null,
      status: "answered",
      answer: "a",
      spawnedChildIds: [],
      budgetUsed: { llmCalls: 0, wallMs: 0 },
    },
  },
  blackboard: {
    hypotheses: [],
    findings: [],
    openQuestions: [],
    domainContext: [],
    _seq: 0,
  },
  totalBudgetUsed: { llmCalls: 0, wallMs: 0 },
  startedAt: Date.now(),
  idPrefix: "test_",
  ...overrides,
});

describe("W74 · evaluateBudgetExhaustion — within budget", () => {
  it("returns null when all budgets healthy", () => {
    const result = evaluateBudgetExhaustion(baseTree(), baseConfig());
    assert.equal(result, null);
  });

  it("returns null at exactly half capacity", () => {
    const tree = baseTree({ totalBudgetUsed: { llmCalls: 40, wallMs: 0 } });
    const result = evaluateBudgetExhaustion(tree, baseConfig(), tree.startedAt + 30_000);
    assert.equal(result, null);
  });
});

describe("W74 · evaluateBudgetExhaustion — llm_calls_exhausted", () => {
  it("detects exact-cap exhaustion (used == cap)", () => {
    const tree = baseTree({ totalBudgetUsed: { llmCalls: 80, wallMs: 0 } });
    const result = evaluateBudgetExhaustion(tree, baseConfig({ maxTotalLlmCalls: 80 }), tree.startedAt);
    assert.notEqual(result, null);
    assert.equal(result!.reason, "llm_calls_exhausted");
    assert.equal(result!.used, 80);
    assert.equal(result!.cap, 80);
  });

  it("detects above-cap exhaustion", () => {
    const tree = baseTree({ totalBudgetUsed: { llmCalls: 100, wallMs: 0 } });
    const result = evaluateBudgetExhaustion(tree, baseConfig({ maxTotalLlmCalls: 80 }), tree.startedAt);
    assert.notEqual(result, null);
    assert.equal(result!.reason, "llm_calls_exhausted");
  });

  it("takes priority over wall_time + max_nodes when llm budget is the first cap hit", () => {
    const tree = baseTree({
      totalBudgetUsed: { llmCalls: 80, wallMs: 0 },
      nodes: Object.fromEntries(
        Array.from({ length: 5 }, (_, i) => [`n${i}`, {
          id: `n${i}`,
          question: "q",
          parentNodeId: null,
          depth: 0,
          spawnReason: null,
          status: "answered" as const,
          answer: "a",
          spawnedChildIds: [],
          budgetUsed: { llmCalls: 0, wallMs: 0 },
        }]),
      ),
    });
    const result = evaluateBudgetExhaustion(
      tree,
      baseConfig({ maxTotalLlmCalls: 80, maxNodes: 5 }),
      tree.startedAt + 70_000,
    );
    assert.equal(result!.reason, "llm_calls_exhausted", "llm_calls reported first");
  });
});

describe("W74 · evaluateBudgetExhaustion — wall_time_exhausted", () => {
  it("detects when elapsed time exceeds the wall-time cap", () => {
    const tree = baseTree();
    const result = evaluateBudgetExhaustion(
      tree,
      baseConfig({ maxTotalWallTimeMs: 60_000 }),
      tree.startedAt + 70_000,
    );
    assert.notEqual(result, null);
    assert.equal(result!.reason, "wall_time_exhausted");
    assert.equal(result!.used, 70_000);
    assert.equal(result!.cap, 60_000);
  });

  it("does NOT detect wall time when llm calls already exhausted", () => {
    const tree = baseTree({ totalBudgetUsed: { llmCalls: 80, wallMs: 0 } });
    const result = evaluateBudgetExhaustion(
      tree,
      baseConfig({ maxTotalLlmCalls: 80, maxTotalWallTimeMs: 60_000 }),
      tree.startedAt + 70_000,
    );
    assert.equal(result!.reason, "llm_calls_exhausted");
  });
});

describe("W74 · evaluateBudgetExhaustion — max_nodes_reached", () => {
  it("detects when node count >= maxNodes", () => {
    const tree = baseTree({
      nodes: Object.fromEntries(
        Array.from({ length: 5 }, (_, i) => [`n${i}`, {
          id: `n${i}`,
          question: "q",
          parentNodeId: null,
          depth: 0,
          spawnReason: null,
          status: "answered" as const,
          answer: "a",
          spawnedChildIds: [],
          budgetUsed: { llmCalls: 0, wallMs: 0 },
        }]),
      ),
    });
    const result = evaluateBudgetExhaustion(
      tree,
      baseConfig({ maxNodes: 5 }),
      tree.startedAt,
    );
    assert.notEqual(result, null);
    assert.equal(result!.reason, "max_nodes_reached");
    assert.equal(result!.used, 5);
    assert.equal(result!.cap, 5);
  });

  it("falls behind wall_time in priority order", () => {
    const tree = baseTree({
      nodes: Object.fromEntries(
        Array.from({ length: 5 }, (_, i) => [`n${i}`, {
          id: `n${i}`,
          question: "q",
          parentNodeId: null,
          depth: 0,
          spawnReason: null,
          status: "answered" as const,
          answer: "a",
          spawnedChildIds: [],
          budgetUsed: { llmCalls: 0, wallMs: 0 },
        }]),
      ),
    });
    const result = evaluateBudgetExhaustion(
      tree,
      baseConfig({ maxNodes: 5, maxTotalWallTimeMs: 60_000 }),
      tree.startedAt + 70_000,
    );
    assert.equal(result!.reason, "wall_time_exhausted");
  });
});

describe("W74 · formatBudgetExhaustionMessage", () => {
  it("emits a parsable llm_calls_exhausted message", () => {
    const msg = formatBudgetExhaustionMessage("llm_calls_exhausted", 80, 80);
    assert.match(msg, /LLM call budget exhausted/);
    assert.match(msg, /80 \/ 80/);
  });

  it("emits a parsable wall_time message", () => {
    const msg = formatBudgetExhaustionMessage("wall_time_exhausted", 70_000, 60_000);
    assert.match(msg, /wall-time budget exhausted/);
    assert.match(msg, /70000 ms \/ 60000 ms/);
  });

  it("emits a parsable max_nodes message", () => {
    const msg = formatBudgetExhaustionMessage("max_nodes_reached", 5, 5);
    assert.match(msg, /max node count reached/);
    assert.match(msg, /5 \/ 5/);
  });
});

describe("W74 · message in BudgetExhaustionDetails", () => {
  it("attaches the canonical message to llm_calls exhaustion", () => {
    const tree = baseTree({ totalBudgetUsed: { llmCalls: 80, wallMs: 0 } });
    const result = evaluateBudgetExhaustion(tree, baseConfig({ maxTotalLlmCalls: 80 }), tree.startedAt);
    assert.match(result!.message, /LLM call budget exhausted/);
  });

  it("attaches the canonical message to wall_time exhaustion", () => {
    const tree = baseTree();
    const result = evaluateBudgetExhaustion(
      tree,
      baseConfig({ maxTotalWallTimeMs: 60_000 }),
      tree.startedAt + 70_000,
    );
    assert.match(result!.message, /wall-time budget exhausted/);
  });
});
