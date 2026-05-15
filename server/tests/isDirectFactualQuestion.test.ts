/**
 * PVT3 · pin the direct-factual-question heuristic.
 *
 * When true, the agent loop strips `recommendations` and `nextSteps` from
 * the answer envelope so the user doesn't see "further investigation"
 * follow-up suggestions for plain factual asks.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isDirectFactualQuestion } from "../lib/agents/runtime/isDirectFactualQuestion.js";

describe("PVT3 · isDirectFactualQuestion", () => {
  it("matches direct factual leaders", () => {
    const cases = [
      "What is the average number of compliance visits per cluster?",
      "Which TSOE has the highest GCPC?",
      "How many TSOEs have not uploaded the PJP yet?",
      "List the clusters by ASM count",
      "Show me the top 5 by compliance visits",
      "Tell me the average for each region",
      "Name the cluster with the most non-compliance visits",
    ];
    for (const q of cases) {
      assert.equal(isDirectFactualQuestion(q), true, `should match: ${q}`);
    }
  });

  it("rejects diagnostic / strategic / why-driven questions", () => {
    const cases = [
      "Why did sales drop last quarter?",
      "What's driving the increase in compliance visits?",
      "How can I improve PJP adherence in Cluster 1 EAST?",
      "Compare Cluster 1 EAST vs Cluster 2 SOUTH on compliance visits",
      "What is the trend in compliance visits over time?",
      "Decompose the variance in GCPC adherence",
      "Investigate the root cause of low adherence",
      "What if we increased compliance visits by 20%?",
      "Predict next quarter's GCPC",
      "How do I rescue falling sales?",
      // Even a "what is" lead-in flips when paired with diagnostic cues.
      "What is the trend in compliance visits?",
      "Which drivers explain the variance?",
    ];
    for (const q of cases) {
      assert.equal(
        isDirectFactualQuestion(q),
        false,
        `should NOT match: ${q}`
      );
    }
  });

  it("handles edge cases gracefully", () => {
    assert.equal(isDirectFactualQuestion(""), false);
    assert.equal(isDirectFactualQuestion(undefined), false);
    assert.equal(isDirectFactualQuestion(null), false);
    assert.equal(isDirectFactualQuestion("?"), false);
    assert.equal(isDirectFactualQuestion("hi"), false);
  });
});
