import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { looksLikeBudgetReallocationQuestion } from "../lib/agents/runtime/analysisBrief.js";

describe("looksLikeBudgetReallocationQuestion", () => {
  const positives = [
    "How should I redistribute my marketing budget?",
    "Where should I reallocate my media spend across channels?",
    "Optimize my budget allocation across TV, digital, and OOH",
    "Run a media mix optimization for me",
    "Can you do an MMM analysis?",
    "Help me reshuffle my marketing spend",
    "What's the optimal budget mix?",
  ];
  for (const q of positives) {
    it(`positive: ${q}`, () => {
      assert.equal(looksLikeBudgetReallocationQuestion(q), true);
    });
  }

  const negatives = [
    "What is my total revenue?",
    "Show me sales by region",
    "Why did Q3 sales drop?",
    "What drives my conversion rate?",
    "Plot a trend of my orders",
    "Compare 2023 to 2024",
  ];
  for (const q of negatives) {
    it(`negative: ${q}`, () => {
      assert.equal(looksLikeBudgetReallocationQuestion(q), false);
    });
  }
});
