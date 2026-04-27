import assert from "node:assert/strict";
import { describe, it, after, beforeEach } from "node:test";
import type {
  AgentWorkbenchEntry,
  SessionAnalysisContext,
} from "../shared/schema.js";

// Stub Azure env so transitive openai imports don't crash at module load.
process.env.AZURE_OPENAI_API_KEY ??= "test";
process.env.AZURE_OPENAI_ENDPOINT ??= "https://test.openai.azure.com";
process.env.AZURE_OPENAI_DEPLOYMENT_NAME ??= "test-deployment";

const { enrichStepInsights, isRichStepInsightsEnabled } = await import(
  "../lib/agents/runtime/enrichStepInsights.js"
);
const { LLM_PURPOSE } = await import("../lib/agents/runtime/llmCallPurpose.js");
const { installLlmStub, clearLlmStub } = await import("./helpers/llmStub.js");

after(() => clearLlmStub());
beforeEach(() => clearLlmStub());

const baseSAC: SessionAnalysisContext = {
  version: 1,
  dataset: {
    shortDescription: "Monthly brand-region-channel volume tracker.",
    columnRoles: [],
    caveats: [],
  },
  userIntent: { interpretedConstraints: [] },
  sessionKnowledge: { facts: [], analysesDone: [] },
  suggestedFollowUps: [],
  lastUpdated: { reason: "seed", at: new Date().toISOString() },
};

const buildWorkbench = (): AgentWorkbenchEntry[] => [
  {
    id: "plan-1",
    kind: "plan",
    title: "Plan",
    code: "...",
    insight: "Pivoting Saffola sales by Region first.",
  },
  {
    id: "call-1",
    kind: "tool_call",
    title: "Tool: execute_query_plan",
    code: "{}",
    insight: "Calling `execute_query_plan` with metric=Volume_MT.",
  },
  {
    id: "result-1",
    kind: "tool_result",
    title: "Result (ok)",
    code: "...",
    insight: "Aggregated 1,240 rows across 6 brands.",
  },
];

describe("W19 · isRichStepInsightsEnabled gate", () => {
  it("is false unless RICH_STEP_INSIGHTS_ENABLED === 'true'", () => {
    const prev = process.env.RICH_STEP_INSIGHTS_ENABLED;
    delete process.env.RICH_STEP_INSIGHTS_ENABLED;
    assert.equal(isRichStepInsightsEnabled(), false);
    process.env.RICH_STEP_INSIGHTS_ENABLED = "1";
    assert.equal(isRichStepInsightsEnabled(), false);
    process.env.RICH_STEP_INSIGHTS_ENABLED = "true";
    assert.equal(isRichStepInsightsEnabled(), true);
    if (prev === undefined) delete process.env.RICH_STEP_INSIGHTS_ENABLED;
    else process.env.RICH_STEP_INSIGHTS_ENABLED = prev;
  });
});

describe("W19 · enrichStepInsights — env gating", () => {
  it("skips when env flag off; workbench unchanged", async () => {
    const prev = process.env.RICH_STEP_INSIGHTS_ENABLED;
    delete process.env.RICH_STEP_INSIGHTS_ENABLED;
    const workbench = buildWorkbench();
    const before = workbench.map((e) => e.insight);
    const result = await enrichStepInsights({
      workbench,
      finalAnswer: "Stub answer",
      sessionAnalysisContext: baseSAC,
      turnId: "t1",
    });
    assert.equal(result.ok, false);
    assert.equal(result.enrichedCount, 0);
    assert.deepEqual(workbench.map((e) => e.insight), before);
    if (prev !== undefined) process.env.RICH_STEP_INSIGHTS_ENABLED = prev;
  });
});

describe("W19 · enrichStepInsights — backfill", () => {
  it("overwrites entry.insight with LLM-enriched text for matching ids", async () => {
    process.env.RICH_STEP_INSIGHTS_ENABLED = "true";
    installLlmStub({
      [LLM_PURPOSE.INSIGHT_GEN]: () => ({
        insights: [
          { id: "plan-1", text: "ENRICHED: planner chose region-first pivot to localise the share loss." },
          { id: "result-1", text: "ENRICHED: the 1,240-row aggregation showed Saffola dominates South-MT." },
        ],
      }),
    });
    const workbench = buildWorkbench();
    const result = await enrichStepInsights({
      workbench,
      finalAnswer: "Final answer body talking about Saffola.",
      sessionAnalysisContext: baseSAC,
      turnId: "t2",
    });
    assert.equal(result.ok, true);
    assert.equal(result.enrichedCount, 2);
    assert.match(workbench[0].insight!, /^ENRICHED: planner chose/);
    // Unmatched entry keeps its deterministic insight.
    assert.match(workbench[1].insight!, /^Calling `execute_query_plan`/);
    assert.match(workbench[2].insight!, /^ENRICHED: the 1,240-row aggregation/);
    delete process.env.RICH_STEP_INSIGHTS_ENABLED;
  });

  it("clips enriched text to 200 chars with ellipsis", async () => {
    process.env.RICH_STEP_INSIGHTS_ENABLED = "true";
    installLlmStub({
      [LLM_PURPOSE.INSIGHT_GEN]: () => ({
        insights: [{ id: "plan-1", text: "x".repeat(400) }],
      }),
    });
    const workbench = buildWorkbench();
    await enrichStepInsights({
      workbench,
      finalAnswer: "answer",
      turnId: "t3",
    });
    assert.equal(workbench[0].insight!.length, 200);
    assert.match(workbench[0].insight!, /…$/);
    delete process.env.RICH_STEP_INSIGHTS_ENABLED;
  });

  it("returns ok:false (and leaves workbench untouched) when LLM call fails to parse", async () => {
    process.env.RICH_STEP_INSIGHTS_ENABLED = "true";
    installLlmStub({
      [LLM_PURPOSE.INSIGHT_GEN]: () => "not-valid-json{",
    });
    const workbench = buildWorkbench();
    const before = workbench.map((e) => e.insight);
    const result = await enrichStepInsights({
      workbench,
      finalAnswer: "answer",
      turnId: "t4",
    });
    assert.equal(result.ok, false);
    assert.deepEqual(workbench.map((e) => e.insight), before);
    delete process.env.RICH_STEP_INSIGHTS_ENABLED;
  });

  it("skips when finalAnswer is empty", async () => {
    process.env.RICH_STEP_INSIGHTS_ENABLED = "true";
    let calledStub = false;
    installLlmStub({
      [LLM_PURPOSE.INSIGHT_GEN]: () => {
        calledStub = true;
        return { insights: [] };
      },
    });
    const result = await enrichStepInsights({
      workbench: buildWorkbench(),
      finalAnswer: "   ",
      turnId: "t5",
    });
    assert.equal(result.ok, false);
    assert.equal(calledStub, false);
    delete process.env.RICH_STEP_INSIGHTS_ENABLED;
  });

  it("includes domainContext in the prompt when supplied", async () => {
    process.env.RICH_STEP_INSIGHTS_ENABLED = "true";
    let userMessageSeen = "";
    installLlmStub({
      [LLM_PURPOSE.INSIGHT_GEN]: (params) => {
        const userMsg = params.messages.find((m) => m.role === "user");
        userMessageSeen = (userMsg?.content as string) ?? "";
        return { insights: [{ id: "plan-1", text: "enriched" }] };
      },
    });
    await enrichStepInsights({
      workbench: buildWorkbench(),
      finalAnswer: "answer",
      sessionAnalysisContext: baseSAC,
      domainContext:
        "<<DOMAIN PACK: marico-haircare-portfolio>>\n# Marico Haircare\n…\n<</DOMAIN PACK>>",
      turnId: "t6",
    });
    assert.match(userMessageSeen, /DOMAIN \(FMCG\/Marico/);
    assert.match(userMessageSeen, /marico-haircare-portfolio/);
    assert.match(userMessageSeen, /DATASET:/);
    delete process.env.RICH_STEP_INSIGHTS_ENABLED;
  });
});
