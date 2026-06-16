/**
 * Integration test for the post-verifier business-actions seam in
 * `runAgentTurn`. Drives the full loop with stubbed LLMs and asserts:
 *   1. When the verifier passes AND the env flag is on, the loop attaches
 *      `businessActionsPromise` to the result; awaiting it yields the
 *      LLM-stubbed items.
 *   2. When the env flag is off, the promise is absent (zero LLM cost).
 *   3. When the envelope has zero findings + zero magnitudes, the agent
 *      hard-skips (cheap path).
 *
 * Mirrors the W20 e2e harness so the fixture stays single-step (no
 * DuckDB / RAG dependencies). Tests run sequentially with a shared
 * fixture; each one resets env flags it touches.
 */
import assert from "node:assert/strict";
import { describe, it, after, before } from "node:test";
import type {
  ChatDocument,
  DataSummary,
  SessionAnalysisContext,
} from "../shared/schema.js";

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
  "../lib/agents/runtime/runtimeConfig.js"
);
const { LLM_PURPOSE } = await import(
  "../lib/agents/runtime/llmCallPurpose.js"
);
const { installLlmStub, clearLlmStub } = await import("./helpers/llmStub.js");

after(() => clearLlmStub());

const summary: DataSummary = {
  rowCount: 24,
  columnCount: 3,
  columns: [
    { name: "Brand", type: "string", sampleValues: ["MARICO"] },
    { name: "Region", type: "string", sampleValues: ["South"] },
    { name: "Volume", type: "number", sampleValues: [100] },
  ],
  numericColumns: ["Volume"],
  dateColumns: [],
};

const sac: SessionAnalysisContext = {
  version: 1,
  dataset: {
    shortDescription: "fixture",
    columnRoles: [],
    caveats: [],
  },
  userIntent: { interpretedConstraints: [] },
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

function fixtureData(): Record<string, any>[] {
  return Array.from({ length: 24 }, (_, i) => ({
    Brand: i % 2 === 0 ? "MARICO" : "PURITE",
    Region: ["South", "East", "West", "North"][i % 4],
    Volume: 100 + i,
  }));
}

const businessActionsStubItems = [
  {
    title: "Run a 90-day shelf-share audit in metro stores",
    rationale:
      "MARICO share fell 4.2pp in Q4 vs Q3 (finding 1). Audit will isolate whether it's distribution, price, or promo.",
    horizon: "now",
    confidence: "high",
  },
  {
    title: "Tighten promo-depth rules for the South region",
    rationale: "South-region promo elasticity slipped (finding 2).",
    horizon: "this_quarter",
    confidence: "medium",
    expectedImpact: "Could recover 1-2pp share over 2 quarters",
  },
];

function installCommonStub(opts?: {
  businessActions?: { items: unknown[] };
  narratorFindingsCount?: number;
}) {
  const findingsCount = opts?.narratorFindingsCount ?? 2;
  installLlmStub({
    [LLM_PURPOSE.PLANNER]: () => ({
      rationale: "minimal",
      steps: [{ id: "s1", tool: "get_schema_summary", args: {} }],
    }),
    [LLM_PURPOSE.HYPOTHESIS]: () => ({
      hypotheses: [
        { text: "MARICO lost share to PURITE in metros.", targetColumn: "Volume" },
      ],
    }),
    [LLM_PURPOSE.ANALYSIS_BRIEF]: () => ({
      questionShape: "driver_discovery",
      outcomeMetricColumn: "Volume",
      segmentationDimensions: ["Brand", "Region"],
      candidateDriverDimensions: ["Brand", "Region"],
      epistemicNotes: "fixture",
    }),
    [LLM_PURPOSE.NARRATOR]: () => ({
      body: "MARICO lost share in South-region metros.",
      keyInsight: "Brand-specific decline.",
      ctas: [],
      tldr: "MARICO lost 4.2pp share in Q4.",
      findings: Array.from({ length: findingsCount }, (_, i) => ({
        headline: `Finding ${i + 1}`,
        evidence: `Evidence for finding ${i + 1}`,
        magnitude: `-${i + 1}.0pp`,
      })),
      methodology: "Brand × Region aggregation.",
      caveats: [],
      implications: [
        {
          statement: "Decline is brand-specific.",
          soWhat: "Action should target MARICO not the category.",
          confidence: "high",
        },
        {
          statement: "South region drives the decline.",
          soWhat: "Geographic focus matters.",
          confidence: "medium",
        },
      ],
      recommendations: [
        {
          action: "Drill into South-region SKU mix",
          rationale: "Narrow the diagnostic",
          horizon: "now",
        },
        {
          action: "Compare MT vs GT performance",
          rationale: "Channel mix may differ",
          horizon: "this_quarter",
        },
      ],
      domainLens:
        "Per `marico-haircare-portfolio`, MARICO is the flagship and category-leading SKU.",
      magnitudes: [
        { label: "Share drop", value: "-4.2pp", confidence: "high" },
      ],
      unexplained: "Channel split unanalysed.",
    }),
    [LLM_PURPOSE.VERIFIER_DEEP]: () => ({
      verdict: "pass",
      issues: [],
      course_correction: "pass",
    }),
    [LLM_PURPOSE.VISUAL_PLANNER]: () => ({ charts: [] }),
    [LLM_PURPOSE.REFLECTOR]: () => ({ verdict: "continue", reason: "fixture" }),
    [LLM_PURPOSE.BUSINESS_ACTIONS]: () =>
      opts?.businessActions ?? { items: businessActionsStubItems },
  });
}

before(() => {
  installCommonStub();
});

describe("agentLoop · post-verifier business-actions seam", () => {
  it("attaches businessActionsPromise on a passing turn; awaiting yields stubbed items", async () => {
    process.env.BUSINESS_ACTIONS_ENABLED = "true";
    installCommonStub();
    const ctx = buildAgentExecutionContext({
      sessionId: "fixture-session",
      username: "tester@example.com",
      question: "How do I rescue MARICO's falling share?",
      data: fixtureData(),
      summary,
      chatHistory: [],
      mode: "analysis",
      sessionAnalysisContext: sac,
      chatDocument: chatDocument as ChatDocument,
    });
    ctx.analysisBrief = {
      questionShape: "driver_discovery",
      outcomeMetricColumn: "Volume",
      segmentationDimensions: ["Brand", "Region"],
      candidateDriverDimensions: ["Brand", "Region"],
      epistemicNotes: "fixture",
      filters: [],
      requestsDashboard: false,
      clarifyingQuestions: [],
    };
    const result = await runAgentTurn(ctx, loadAgentConfigFromEnv());
    assert.ok(result.answerEnvelope, "envelope must be present on a passing turn");
    assert.ok(
      result.businessActionsPromise,
      "businessActionsPromise must be attached when env flag is on AND envelope exists"
    );
    const items = await result.businessActionsPromise!;
    assert.equal(items.length, 2, "expected 2 stubbed items");
    assert.equal(items[0].title.startsWith("Run a 90-day"), true);
    assert.equal(items[0].horizon, "now");
    assert.equal(items[0].confidence, "high");
    assert.equal(items[1].horizon, "this_quarter");
    assert.equal(items[1].expectedImpact, "Could recover 1-2pp share over 2 quarters");
  });

  it("omits businessActionsPromise when BUSINESS_ACTIONS_ENABLED=false", async () => {
    process.env.BUSINESS_ACTIONS_ENABLED = "false";
    installCommonStub();
    const ctx = buildAgentExecutionContext({
      sessionId: "fixture-session",
      username: "tester@example.com",
      question: "How do I rescue MARICO's falling share?",
      data: fixtureData(),
      summary,
      chatHistory: [],
      mode: "analysis",
      sessionAnalysisContext: sac,
      chatDocument: chatDocument as ChatDocument,
    });
    ctx.analysisBrief = {
      questionShape: "driver_discovery",
      outcomeMetricColumn: "Volume",
      segmentationDimensions: ["Brand", "Region"],
      candidateDriverDimensions: ["Brand", "Region"],
      epistemicNotes: "fixture",
      filters: [],
      requestsDashboard: false,
      clarifyingQuestions: [],
    };
    const result = await runAgentTurn(ctx, loadAgentConfigFromEnv());
    assert.equal(
      result.businessActionsPromise,
      undefined,
      "BUSINESS_ACTIONS_ENABLED=false must hard-skip"
    );
    // Reset for following tests
    process.env.BUSINESS_ACTIONS_ENABLED = "true";
  });

  it("agent self-gates to empty array — promise resolves but yields []", async () => {
    process.env.BUSINESS_ACTIONS_ENABLED = "true";
    installCommonStub({ businessActions: { items: [] } });
    const ctx = buildAgentExecutionContext({
      sessionId: "fixture-session",
      username: "tester@example.com",
      question: "What are sales by region last quarter?", // descriptive
      data: fixtureData(),
      summary,
      chatHistory: [],
      mode: "analysis",
      sessionAnalysisContext: sac,
      chatDocument: chatDocument as ChatDocument,
    });
    ctx.analysisBrief = {
      questionShape: "exploration",
      outcomeMetricColumn: "Volume",
      segmentationDimensions: ["Brand", "Region"],
      candidateDriverDimensions: [],
      epistemicNotes: "fixture",
      filters: [],
      requestsDashboard: false,
      clarifyingQuestions: [],
    };
    const result = await runAgentTurn(ctx, loadAgentConfigFromEnv());
    assert.ok(result.businessActionsPromise);
    const items = await result.businessActionsPromise!;
    assert.deepEqual(items, [], "self-gate yields empty array");
  });
});
