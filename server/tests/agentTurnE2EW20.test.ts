/**
 * Wave W20 · E2E agent-turn smoke
 *
 * Drives `runAgentTurn` end-to-end against a Marico-shaped fixture with every
 * LLM call stubbed via the W18 harness. Asserts the *combined* shape that
 * waves W7–W19 produce — no individual unit test does this. Failure here =
 * regression in any of those waves.
 *
 * Stays single-flow on purpose: planner returns one cheap step
 * (`get_schema_summary`), so the loop exits quickly and we don't depend on
 * DuckDB / RAG / chart-data services. The LLM stubs supply rich envelope
 * content (implications, recommendations, domainLens) so the W17
 * completeness gate is satisfied without a repair.
 */
import assert from "node:assert/strict";
import { describe, it, after, before } from "node:test";
import type {
  ChatDocument,
  DataSummary,
  SessionAnalysisContext,
} from "../shared/schema.js";

// Stub Azure env so transitive openai imports don't crash at module load.
process.env.AZURE_OPENAI_API_KEY ??= "test";
process.env.AZURE_OPENAI_ENDPOINT ??= "https://test.openai.azure.com";
process.env.AZURE_OPENAI_DEPLOYMENT_NAME ??= "test-deployment";
process.env.AGENTIC_LOOP_ENABLED = "true";
process.env.AGENTIC_ALLOW_NO_RAG = "true";
process.env.AGENT_INTER_AGENT_MESSAGES = "false";

const { runAgentTurn } = await import("../lib/agents/runtime/agentLoop.service.js");
const { buildAgentExecutionContext } = await import(
  "../lib/agents/runtime/context.js"
);
const { loadAgentConfigFromEnv } = await import(
  "../lib/agents/runtime/types.js"
);
const { LLM_PURPOSE } = await import(
  "../lib/agents/runtime/llmCallPurpose.js"
);
const { installLlmStub, clearLlmStub } = await import(
  "./helpers/llmStub.js"
);

after(() => clearLlmStub());

// ── Fixture ──────────────────────────────────────────────────────────
// 60 rows × 6 cols of FMCG-shaped data. Numbers are coherent but synthetic —
// the LLM is stubbed, so the data is never actually aggregated.
function buildFixtureData(): Record<string, any>[] {
  const brands = ["Saffola", "Parachute", "Nihar", "Hair&Care"];
  const regions = ["South", "East", "West", "North"];
  const channels = ["MT", "GT", "EC"];
  const months = ["2024-07", "2024-08", "2024-09"];
  const rows: Record<string, any>[] = [];
  let seed = 1;
  for (const brand of brands) {
    for (const region of regions) {
      for (const channel of channels) {
        const month = months[seed % months.length];
        rows.push({
          Brand: brand,
          Region: region,
          Channel: channel,
          Month: month,
          Volume_MT: 100 + ((seed * 7) % 350),
          Value_INR: 25_000 + ((seed * 137) % 80_000),
        });
        seed++;
      }
    }
  }
  return rows.slice(0, 60);
}

const summary: DataSummary = {
  rowCount: 60,
  columnCount: 6,
  columns: [
    { name: "Brand", type: "string", sampleValues: ["Saffola", "Parachute"] },
    { name: "Region", type: "string", sampleValues: ["South", "East"] },
    { name: "Channel", type: "string", sampleValues: ["MT", "GT", "EC"] },
    { name: "Month", type: "date", sampleValues: ["2024-07"] },
    { name: "Volume_MT", type: "number", sampleValues: [120, 240] },
    { name: "Value_INR", type: "number", sampleValues: [25000, 60000] },
  ],
  numericColumns: ["Volume_MT", "Value_INR"],
  dateColumns: ["Month"],
};

const sac: SessionAnalysisContext = {
  version: 1,
  dataset: {
    shortDescription: "Marico monthly brand-region-channel volume tracker.",
    grainGuess: "one row per Brand × Region × Channel × Month",
    columnRoles: [
      { name: "Brand", role: "dimension" },
      { name: "Region", role: "dimension" },
      { name: "Channel", role: "dimension" },
      { name: "Volume_MT", role: "metric" },
      { name: "Value_INR", role: "metric" },
    ],
    caveats: [],
  },
  userIntent: { interpretedConstraints: ["Q3 focus"] },
  sessionKnowledge: { facts: [], analysesDone: [] },
  suggestedFollowUps: [],
  lastUpdated: { reason: "seed", at: new Date().toISOString() },
};

const chatDocument: Partial<ChatDocument> = {
  id: "fixture-session",
  sessionId: "fixture-session",
  dataSummary: summary,
  sessionAnalysisContext: sac,
};

before(() => {
  installLlmStub({
    // Return a single cheap step so the loop exits quickly without DuckDB.
    [LLM_PURPOSE.PLANNER]: () => ({
      rationale: "Use get_schema_summary to confirm the dataset shape, then synthesise.",
      steps: [{ id: "s1", tool: "get_schema_summary", args: {} }],
    }),
    // Hypothesis count drives the W13 investigation summary — emit 2 to test
    // the hypothesis section renders.
    [LLM_PURPOSE.HYPOTHESIS]: () => ({
      hypotheses: [
        { text: "Saffola lost MT-channel volume due to pack-mix shift.", targetColumn: "Volume_MT" },
        { text: "South-region distribution gap explains the Q3 dip.", targetColumn: "Volume_MT" },
      ],
    }),
    // Analysis brief sets questionShape — required to trigger the W17
    // completeness check.
    [LLM_PURPOSE.ANALYSIS_BRIEF]: () => ({
      questionShape: "driver_discovery",
      outcomeMetricColumn: "Volume_MT",
      segmentationDimensions: ["Brand", "Region", "Channel"],
      candidateDriverDimensions: ["Brand", "Region", "Channel"],
      epistemicNotes: "fixture",
    }),
    // Narrator emits the full W8 envelope so the W17 completeness check
    // passes on the first try (no repair).
    [LLM_PURPOSE.NARRATOR]: () => ({
      body:
        "Saffola lost share in MT in Q3, concentrated in the South region. The pack-mix shift toward 1L SKUs aligns with a private-label squeeze; promo-depth elasticity also slipped meaningfully versus benchmarks.",
      keyInsight: "South-MT share loss is brand-specific, not category-wide.",
      ctas: ["What is Saffola's MT vs GT trade margin gap?"],
      tldr: "Saffola lost MT share in Q3 — concentrated in South-region 1L SKUs.",
      findings: [
        { headline: "South-MT volume −8% MoM", evidence: "Q3 aggregation", magnitude: "-8%" },
        { headline: "Pack-mix shifted to 1L", evidence: "SKU breakdown", magnitude: "-3 ppt" },
      ],
      methodology: "Aggregated brand × region × channel for Q3.",
      caveats: ["MT-only; GT/EC not analysed"],
      implications: [
        {
          statement: "South-MT volume drop is brand-specific to Saffola.",
          soWhat: "Likely a price/pack response to private label, not category softness.",
          confidence: "high",
        },
        {
          statement: "Premium-SKU mix loss compounds the volume drop.",
          soWhat: "Margin-per-unit slipping; brand-equity work needed.",
          confidence: "medium",
        },
      ],
      recommendations: [
        {
          action: "Review MT pack-size mix vs. private label",
          rationale: "1L SKUs overlap top private-label price points",
          horizon: "this_quarter",
        },
        {
          action: "Tighten promo-depth rules in MT",
          rationale: "Promo elasticity slipped 12% vs benchmark",
          horizon: "now",
        },
      ],
      domainLens:
        "Per `marico-foods-edible-oils-portfolio`, Saffola is the flagship in this category and any MT slippage compounds the franchise's overall trading profile.",
      magnitudes: [
        { label: "South-MT volume drop", value: "-8% MoM", confidence: "high" },
        { label: "Pack-mix shift", value: "-3 ppt", confidence: "medium" },
      ],
      unexplained: "GT vs MT cannibalisation not isolated.",
    }),
    [LLM_PURPOSE.VERIFIER_DEEP]: () => ({
      verdict: "pass",
      issues: [],
      course_correction: "pass",
      scores: { goal_alignment: 0.9, evidence_consistency: 0.9, completeness: 0.9 },
    }),
    [LLM_PURPOSE.VISUAL_PLANNER]: () => ({ charts: [] }),
    // Reflector / context-agent / coordinator emit benign defaults.
    [LLM_PURPOSE.REFLECTOR]: () => ({ verdict: "continue", reason: "fixture" }),
  });
});

describe("W20 · runAgentTurn end-to-end against Marico fixture", () => {
  it("produces a fully-populated AgentLoopResult — answer + envelope + investigation summary", async () => {
    const ctx = buildAgentExecutionContext({
      sessionId: "fixture-session",
      username: "tester@example.com",
      question: "Why did Saffola lose share in MT in Q3?",
      data: buildFixtureData(),
      summary,
      chatHistory: [],
      mode: "analysis",
      permanentContext: "Always pivot by Brand first; revenue is in INR.",
      domainContext:
        "<<DOMAIN PACK: marico-foods-edible-oils-portfolio>>\n# Marico Foods & Edible Oils\nSaffola is the flagship.\n<</DOMAIN PACK>>",
      sessionAnalysisContext: sac,
      chatDocument: chatDocument as ChatDocument,
    });
    // Pre-set the analysis brief so the W17 completeness check is exercised.
    // (The brief LLM-call path is gated on diagnostic intent; we bypass that
    // gate here to drive the path under test.)
    ctx.analysisBrief = {
      questionShape: "driver_discovery",
      outcomeMetricColumn: "Volume_MT",
      segmentationDimensions: ["Brand", "Region", "Channel"],
      candidateDriverDimensions: ["Brand", "Region", "Channel"],
      epistemicNotes: "Observational data; avoid causal claims.",
      filters: [],
      requestsDashboard: false,
      clarifyingQuestions: [],
    };

    const config = loadAgentConfigFromEnv();
    const result = await runAgentTurn(ctx, config);

    // ── Answer body ──
    assert.ok(result.answer && result.answer.length > 200, `answer too short: ${result.answer?.length}`);
    assert.match(result.answer!, /Saffola/);

    // ── W7/W8 · decision-grade envelope ──
    assert.ok(result.answerEnvelope, "answerEnvelope must be populated");
    const env = result.answerEnvelope!;
    assert.ok(env.tldr && env.tldr.length > 0, "tldr present");
    assert.ok(Array.isArray(env.findings) && env.findings!.length >= 2, "≥2 findings");
    assert.ok(Array.isArray(env.implications) && env.implications!.length >= 2, "≥2 implications");
    assert.equal(env.implications![0].confidence, "high");
    assert.match(env.implications![0].soWhat, /private label|category softness/);
    assert.ok(Array.isArray(env.recommendations) && env.recommendations!.length >= 2, "≥2 recommendations");
    assert.equal(env.recommendations![1].horizon, "now");
    assert.ok(env.domainLens && /marico-foods-edible-oils-portfolio/.test(env.domainLens), "domainLens cites pack id");

    // ── W13 · investigation summary digest ──
    assert.ok(result.investigationSummary, "investigationSummary must be populated");
    const inv = result.investigationSummary!;
    assert.ok(Array.isArray(inv.hypotheses) && inv.hypotheses!.length >= 1, "≥1 hypothesis");
    assert.match(inv.hypotheses![0].text, /Saffola/);

    // ── W8 · magnitudes & telemetry surfaces ──
    assert.ok(Array.isArray(result.magnitudes) && result.magnitudes!.length >= 2, "≥2 magnitudes");
    assert.match(result.magnitudes![0].value, /%|MoM/);
    assert.ok(result.unexplained && result.unexplained.length > 0, "unexplained populated");

    // ── Trace shape ──
    assert.ok(result.agentTrace);
    assert.ok(Array.isArray(result.agentTrace!.steps), "steps array present");
    assert.ok(result.agentTrace!.steps.length >= 1, "at least one planned step");

    // ── Blackboard digest ──
    assert.ok(result.blackboard);
    assert.ok(result.blackboard!.hypotheses.length >= 2, "blackboard has hypotheses");
  });
});
