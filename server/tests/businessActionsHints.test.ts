/**
 * Pin behaviour of `extractStrategyIntentHints`.
 *
 * Critically: this function is *informational*, not a gate. The agent is
 * invoked on every passing turn regardless of regex hits. Tests focus on
 * "does the right surface form trip the right hint label" rather than
 * "does the agent fire" — the agent firing is a separate decision.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { extractStrategyIntentHints } from "../lib/agents/runtime/businessActionsHints.js";

describe("extractStrategyIntentHints", () => {
  test("returns empty for purely descriptive analytical questions", () => {
    assert.deepEqual(
      extractStrategyIntentHints("What are sales by brand last quarter?"),
      []
    );
    assert.deepEqual(
      extractStrategyIntentHints("Show me the top 10 SKUs by revenue"),
      []
    );
    assert.deepEqual(extractStrategyIntentHints("Plot trend for Q3"), []);
  });

  test("returns empty / null-safe for falsy input", () => {
    assert.deepEqual(extractStrategyIntentHints(""), []);
    assert.deepEqual(
      extractStrategyIntentHints(undefined as unknown as string),
      []
    );
  });

  test("matches action verb + business outcome pairings", () => {
    const cases = [
      "How do I increase sales?",
      "What can we do to grow revenue next quarter",
      "I need to rescue falling margins",
      "Improve customer retention",
      "Reduce churn for the loyalty segment",
      "Optimize the brand portfolio",
      "Defend market share against private label",
    ];
    for (const q of cases) {
      const hints = extractStrategyIntentHints(q);
      assert.ok(
        hints.some((h) => h.includes("action verb + business outcome")),
        `expected action+outcome hint for: ${q} (got ${JSON.stringify(hints)})`
      );
    }
  });

  test("matches imperative question shapes", () => {
    const cases = [
      "How should I prioritize the launches?",
      "What should we focus on this quarter?",
      "Should I cut the under-performing SKUs?",
      "Where should we invest next?",
    ];
    for (const q of cases) {
      const hints = extractStrategyIntentHints(q);
      assert.ok(
        hints.some((h) => h.includes("imperative shape")),
        `expected imperative-shape hint for: ${q}`
      );
    }
  });

  test("matches explicit strategy / decision asks", () => {
    const cases = [
      "Give me a strategy for Q4",
      "What are the action items here?",
      "Walk me through the decision",
      "Talk me through what to do",
      "Make a case for me",
      "What would you do in this situation?",
      "Recommendations for the brand team",
    ];
    for (const q of cases) {
      const hints = extractStrategyIntentHints(q);
      assert.ok(
        hints.some((h) => h.includes("explicit strategy ask")),
        `expected explicit-ask hint for: ${q}`
      );
    }
  });

  test("matches implicit decision framings (the cases regex was getting wrong before)", () => {
    const cases = [
      "Your take?",
      "Any thoughts on the situation?",
      "The team's wondering what to do about LASHE",
      "We're trying to decide between two paths",
      "Help me prioritize the next moves",
    ];
    for (const q of cases) {
      const hints = extractStrategyIntentHints(q);
      assert.ok(
        hints.length > 0,
        `expected at least one hint for the non-obvious phrasing: ${q} (got none)`
      );
    }
  });

  test("can stack multiple hints on a rich strategy question", () => {
    const hints = extractStrategyIntentHints(
      "How should we increase margin and what's your strategy for the LASHE relaunch?"
    );
    assert.ok(hints.length >= 2, `expected ≥2 hints, got ${JSON.stringify(hints)}`);
  });

  test("does NOT gate the agent — empty hints is informational, not a verdict", () => {
    // Naturally-phrased decision question that won't match obvious regexes.
    // The contract is: the AGENT decides what to do with the empty result.
    // This test simply documents that an empty array is a legitimate output.
    const subtleQuestion =
      "Look at the LASHE numbers and tell me where it leaves us";
    const hints = extractStrategyIntentHints(subtleQuestion);
    // Either empty or matches "decision framing" — both are correct.
    // The point is: this function never says "skip the agent", regardless.
    assert.ok(Array.isArray(hints), "result is always an array");
  });
});
