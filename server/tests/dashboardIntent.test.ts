import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyDashboardIntent,
  EXPLICIT_RX,
  MULTI_CHART_OFFER_THRESHOLD,
} from "../lib/agents/runtime/dashboardIntent.js";

describe("EXPLICIT_RX · explicit dashboard ask phrasings", () => {
  const positives = [
    "Build me a dashboard",
    "build me a sales dashboard",
    "Create a sales report",
    "make this a monitoring view",
    "make me a dashboard for Q3",
    "turn into a dashboard",
    "turn this into a dashboard",
    "Generate a dashboard",
    "Give me a dashboard for haircare",
    "Show me a dashboard of regional sales",
    "I want a dashboard",
    "I need an executive summary",
    "Design a report",
    "put together a dashboard",
  ];
  for (const q of positives) {
    it(`matches: ${q}`, () => {
      assert.ok(EXPLICIT_RX.test(q), `expected match for "${q}"`);
    });
  }

  const negatives = [
    "What are the top regions?",
    "Compare 2024 vs 2025 sales",
    "the report says we grew 12%", // "report" without a build verb
    "Show me top categories", // no dashboard noun
    "What is the dashboard pattern in our data?", // dashboard noun but no build verb in the right slot
    "Why did sales drop in March?",
  ];
  for (const q of negatives) {
    it(`does not match: ${q}`, () => {
      assert.strictEqual(EXPLICIT_RX.test(q), false, `expected no match for "${q}"`);
    });
  }
});

describe("classifyDashboardIntent", () => {
  it("returns auto_create on explicit regex match regardless of chartCount", () => {
    assert.strictEqual(
      classifyDashboardIntent({ question: "Build me a sales dashboard", chartCount: 0 }),
      "auto_create"
    );
    assert.strictEqual(
      classifyDashboardIntent({ question: "Build me a sales dashboard", chartCount: 5 }),
      "auto_create"
    );
  });

  it("returns auto_create when brief.requestsDashboard is true (LLM backup)", () => {
    assert.strictEqual(
      classifyDashboardIntent({
        question: "What are sales by region?",
        chartCount: 1,
        brief: { requestsDashboard: true },
      }),
      "auto_create"
    );
  });

  it(`returns offer when chartCount >= ${MULTI_CHART_OFFER_THRESHOLD} and no explicit ask`, () => {
    assert.strictEqual(
      classifyDashboardIntent({
        question: "Show me sales by month, region, and category",
        chartCount: 3,
      }),
      "offer"
    );
    assert.strictEqual(
      classifyDashboardIntent({
        question: "Show me sales by month, region, and category",
        chartCount: 7,
      }),
      "offer"
    );
  });

  it("returns none when chartCount is below the offer threshold and no explicit ask", () => {
    assert.strictEqual(
      classifyDashboardIntent({ question: "What's my top region?", chartCount: 1 }),
      "none"
    );
    assert.strictEqual(
      classifyDashboardIntent({ question: "Trend of sales", chartCount: 2 }),
      "none"
    );
    assert.strictEqual(
      classifyDashboardIntent({ question: "How are we doing?", chartCount: 0 }),
      "none"
    );
  });

  it("explicit regex takes priority over offer threshold", () => {
    assert.strictEqual(
      classifyDashboardIntent({
        question: "Build me a dashboard",
        chartCount: 5,
      }),
      "auto_create"
    );
  });

  it("brief.requestsDashboard=false does not force auto_create", () => {
    assert.strictEqual(
      classifyDashboardIntent({
        question: "What are sales by region?",
        chartCount: 1,
        brief: { requestsDashboard: false },
      }),
      "none"
    );
  });
});
