// W50 · `fallbackInsightsFromRaw` is what `generateCorrelationInsights` uses
// when the LLM JSON parse fails or returns an empty/garbage insight list.
// Pre-W50, those code paths returned [] silently — a successful tool call
// surfaced 0 insights even though raw correlations were available. Pin the
// shape and content so a future refactor can't quietly drop the safety net.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

process.env.AGENTIC_ALLOW_NO_RAG = process.env.AGENTIC_ALLOW_NO_RAG ?? "true";
process.env.AZURE_OPENAI_API_KEY ??= "test";
process.env.AZURE_OPENAI_ENDPOINT ??= "https://test.openai.azure.com";
process.env.AZURE_OPENAI_DEPLOYMENT_NAME ??= "test-deployment";

const { fallbackInsightsFromRaw } = await import("../lib/correlationAnalyzer.js");

describe("fallbackInsightsFromRaw", () => {
  it("emits one insight per correlation (top 5) with r and direction for numeric variables", () => {
    const insights = fallbackInsightsFromRaw(
      "Sales",
      [
        { variable: "Price", correlation: -0.78, nPairs: 120 },
        { variable: "AdSpend", correlation: 0.62, nPairs: 100 },
      ],
      new Set()
    );

    assert.equal(insights.length, 2);
    assert.match(insights[0].text, /\*\*Price\*\*/);
    assert.match(insights[0].text, /negative/);
    assert.match(insights[0].text, /r=-0\.78/);
    assert.match(insights[0].text, /n=120/);
    assert.match(insights[0].text, /Correlation does not imply causation/);

    assert.match(insights[1].text, /\*\*AdSpend\*\*/);
    assert.match(insights[1].text, /positive/);
    assert.match(insights[1].text, /r=0\.62/);
  });

  it("phrases categorical variables with η and variance-explained, not r", () => {
    const insights = fallbackInsightsFromRaw(
      "Sales",
      [{ variable: "Region", correlation: 0.42, nPairs: 200 }],
      new Set(["Region"])
    );

    assert.equal(insights.length, 1);
    assert.match(insights[0].text, /\*\*Region\*\*/);
    assert.match(insights[0].text, /η=0\.42/); // η character
    assert.match(insights[0].text, /42% of variance/);
    assert.match(insights[0].text, /n=200/);
    // Categorical phrasing should NOT use Pearson r terminology.
    assert.doesNotMatch(insights[0].text, /\br=/);
  });

  it("caps at the top 5 correlations to match insight UI bandwidth", () => {
    const lots = Array.from({ length: 10 }, (_, i) => ({
      variable: `Col${i}`,
      correlation: 0.9 - i * 0.05,
      nPairs: 100,
    }));

    const insights = fallbackInsightsFromRaw("Y", lots, new Set());

    assert.equal(insights.length, 5);
    assert.match(insights[0].text, /\*\*Col0\*\*/);
    assert.match(insights[4].text, /\*\*Col4\*\*/);
  });

  it("handles missing nPairs gracefully (renders n=NA)", () => {
    const insights = fallbackInsightsFromRaw(
      "Y",
      [{ variable: "X", correlation: 0.5 }],
      new Set()
    );

    assert.equal(insights.length, 1);
    assert.match(insights[0].text, /n=NA/);
  });
});
