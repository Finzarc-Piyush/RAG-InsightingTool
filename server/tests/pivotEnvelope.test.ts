import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

// Stub Azure OpenAI env BEFORE the dynamic import so the module chain
// (callLlm → openai client) doesn't crash at module load.
process.env.AZURE_OPENAI_API_KEY ??= "test";
process.env.AZURE_OPENAI_ENDPOINT ??= "https://test.openai.azure.com";
process.env.AZURE_OPENAI_DEPLOYMENT_NAME ??= "test-deployment";

const { generatePivotEnvelope } = await import(
  "../lib/insightGenerator/pivotEnvelope.js"
);
const { installLlmStub, clearLlmStub } = await import("./helpers/llmStub.js");
const { LLM_PURPOSE } = await import("../lib/agents/runtime/llmCallPurpose.js");

const formatY = (n: number): string => {
  if (!isFinite(n)) return String(n);
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
};

const skewedChartData = [
  { Region: "West", Sales: 600 },
  { Region: "East", Sales: 200 },
  { Region: "North", Sales: 100 },
  { Region: "South", Sales: 60 },
  { Region: "Central", Sales: 40 },
];
const chartSpec = { type: "bar" as const, x: "Region", y: "Sales", title: "Sales by Region" };

describe("generatePivotEnvelope", () => {
  afterEach(() => clearLlmStub());

  it("returns the LLM envelope when output is well-formed and not shallow", async () => {
    installLlmStub({
      [LLM_PURPOSE.INSIGHT_GEN]: () => ({
        findings: [
          {
            headline: "Sales heavily concentrated in West",
            evidence: "West holds 600 of the 1000 total — 60% of overall Sales by Region.",
            magnitude: "60% concentration",
          },
        ],
        implications: [
          {
            statement: "One region carries the metric.",
            soWhat: "A West-side disruption (channel mix, distribution) moves the whole P&L; benchmarking laggards against West will mislead because they face structural ceilings.",
          },
        ],
        recommendations: [
          {
            action: "Split West by channel and product mix to test whether the lead is structural or promo-driven.",
            rationale: "Determines whether to plan around West as a stable anchor or treat its share as cyclical.",
          },
        ],
      }),
    });

    const env = await generatePivotEnvelope({
      chartSpec,
      chartData: skewedChartData,
      formatY,
    });

    assert.equal(env.findings.length, 1);
    assert.match(env.findings[0]!.headline, /West/);
    assert.equal(env.findings[0]!.magnitude, "60% concentration");
    assert.equal(env.implications.length, 1);
    assert.equal(env.recommendations.length, 1);
  });

  it("falls back to a deterministic envelope when LLM returns shallow phrasing", async () => {
    installLlmStub({
      [LLM_PURPOSE.INSIGHT_GEN]: () => ({
        findings: [
          {
            headline: "West has the highest Sales",
            evidence: "West has 600.",
          },
        ],
        implications: [
          { statement: "Sales are uneven", soWhat: "Increase Sales where Sales is low" },
        ],
        recommendations: [
          { action: "Lift the weaker segments", rationale: "Boost overall Sales" },
        ],
      }),
    });

    const env = await generatePivotEnvelope({
      chartSpec,
      chartData: skewedChartData,
      formatY,
    });

    // Deterministic envelope kicks in. Findings should NOT contain the shallow phrase.
    const allText = [
      ...env.findings.map((f) => `${f.headline} ${f.evidence}`),
      ...env.implications.map((i) => `${i.statement} ${i.soWhat}`),
      ...env.recommendations.map((r) => `${r.action} ${r.rationale}`),
    ].join(" ");

    assert.doesNotMatch(allText, /Increase Sales where Sales is low/i);
    assert.doesNotMatch(allText, /Lift the weaker segments/i);
    assert.ok(env.findings.length > 0, "deterministic fallback should produce at least one finding");
    assert.ok(env.recommendations.length > 0, "deterministic fallback should produce at least one recommendation");
  });

  it("falls back to a deterministic envelope when LLM returns empty", async () => {
    installLlmStub({
      [LLM_PURPOSE.INSIGHT_GEN]: () => ({}),
    });

    const env = await generatePivotEnvelope({
      chartSpec,
      chartData: skewedChartData,
      formatY,
    });

    assert.ok(env.findings.length > 0);
    // The deterministic fallback for high-concentration data names the leader.
    assert.match(env.findings[0]!.headline + env.findings[0]!.evidence, /West/);
  });

  it("returns empty envelope when chartData is empty", async () => {
    installLlmStub({});

    const env = await generatePivotEnvelope({
      chartSpec,
      chartData: [],
      formatY,
    });

    assert.equal(env.findings.length, 0);
    assert.equal(env.implications.length, 0);
    assert.equal(env.recommendations.length, 0);
  });
});
