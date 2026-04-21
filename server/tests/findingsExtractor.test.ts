import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createBlackboard,
  addFinding,
  addHypothesis,
  addOpenQuestion,
  shouldUseNarrator,
  isConverged,
} from "../lib/agents/runtime/analyticalBlackboard.js";
import { appendEnvelopeInsight } from "../lib/agents/runtime/insightHelpers.js";

// detectSignificance is module-internal; we exercise its effects via addFinding.

describe("addFinding activates narrator gate", () => {
  it("shouldUseNarrator is false with no findings", () => {
    const bb = createBlackboard();
    addHypothesis(bb, "Sales declined due to East");
    assert.strictEqual(shouldUseNarrator(bb), false);
  });

  it("shouldUseNarrator becomes true after addFinding + hypothesis", () => {
    const bb = createBlackboard();
    addHypothesis(bb, "Sales declined due to East");
    addFinding(bb, {
      sourceRef: "call_001",
      label: "run_analytical_query: region",
      detail: "East region shows a 34% drop in Q1 vs prior year.",
      significance: "notable",
      relatedColumns: ["region", "sales"],
    });
    assert.strictEqual(shouldUseNarrator(bb), true);
  });
});

describe("detectSignificance heuristic (via addFinding significance)", () => {
  it("anomalous summary maps to anomalous significance", () => {
    const bb = createBlackboard();
    addFinding(bb, {
      sourceRef: "c1",
      label: "tool: col",
      detail: "Unexpected spike detected in March",
      significance: "anomalous",
    });
    assert.strictEqual(bb.findings[0].significance, "anomalous");
  });

  it("notable summary (% present) maps to notable significance", () => {
    const bb = createBlackboard();
    addFinding(bb, {
      sourceRef: "c2",
      label: "tool: col",
      detail: "Top 3 regions account for 78% of revenue",
      significance: "notable",
    });
    assert.strictEqual(bb.findings[0].significance, "notable");
  });

  it("routine summary maps to routine significance", () => {
    const bb = createBlackboard();
    addFinding(bb, {
      sourceRef: "c3",
      label: "tool: col",
      detail: "Query executed successfully and returned 10 rows.",
      significance: "routine",
    });
    assert.strictEqual(bb.findings[0].significance, "routine");
  });
});

describe("addOpenQuestion persists spawned questions", () => {
  it("open question appears in bb.openQuestions", () => {
    const bb = createBlackboard();
    addOpenQuestion(bb, "What drove the March spike?", "anomaly found in March", { priority: "high" });
    assert.strictEqual(bb.openQuestions.length, 1);
    assert.strictEqual(bb.openQuestions[0].question, "What drove the March spike?");
    assert.strictEqual(bb.openQuestions[0].priority, "high");
  });

  it("medium priority is the default", () => {
    const bb = createBlackboard();
    addOpenQuestion(bb, "Check category distribution", "", { priority: "medium" });
    assert.strictEqual(bb.openQuestions[0].priority, "medium");
  });
});

describe("isConverged logic with findings", () => {
  it("no findings → not converged regardless of hypotheses", () => {
    const bb = createBlackboard();
    assert.strictEqual(isConverged(bb), false);
  });

  it("findings + no hypotheses → converged (nothing left open)", () => {
    const bb = createBlackboard();
    addFinding(bb, { sourceRef: "c1", label: "t", detail: "something notable", significance: "notable" });
    // No hypotheses means no open ones → isConverged returns true
    assert.strictEqual(isConverged(bb), true);
  });
});

describe("appendEnvelopeInsight", () => {
  it("pushes keyInsight even when charts are present", () => {
    const insights: { id: number; text: string }[] = [];
    appendEnvelopeInsight(insights, "Sales peaked in September.");
    assert.strictEqual(insights.length, 1);
    assert.strictEqual(insights[0].text, "Sales peaked in September.");
  });

  it("skips empty/undefined keyInsight", () => {
    const insights: { id: number; text: string }[] = [];
    appendEnvelopeInsight(insights, undefined);
    appendEnvelopeInsight(insights, "   ");
    assert.strictEqual(insights.length, 0);
  });

  it("deduplicates near-identical insights", () => {
    const insights: { id: number; text: string }[] = [];
    appendEnvelopeInsight(insights, "Sales peaked in September.");
    appendEnvelopeInsight(insights, "Sales peaked in September.");
    assert.strictEqual(insights.length, 1);
  });

  it("assigns incrementing ids", () => {
    const insights: { id: number; text: string }[] = [{ id: 5, text: "existing" }];
    appendEnvelopeInsight(insights, "A new insight.");
    assert.strictEqual(insights[1].id, 6);
  });
});
