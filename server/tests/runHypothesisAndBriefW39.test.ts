import assert from "node:assert/strict";
import { describe, it, after, beforeEach } from "node:test";
import type { DataSummary } from "../shared/schema.js";
import type { AgentExecutionContext } from "../lib/agents/runtime/types.js";

process.env.AZURE_OPENAI_API_KEY ??= "test";
process.env.AZURE_OPENAI_ENDPOINT ??= "https://test.openai.azure.com";
process.env.AZURE_OPENAI_DEPLOYMENT_NAME ??= "test-deployment";

const {
  isMergedPrePlannerEnabled,
  runHypothesisAndBriefMerged,
} = await import("../lib/agents/runtime/runHypothesisAndBrief.js");
const { createBlackboard } = await import(
  "../lib/agents/runtime/analyticalBlackboard.js"
);
const { LLM_PURPOSE } = await import(
  "../lib/agents/runtime/llmCallPurpose.js"
);
const { installLlmStub, clearLlmStub } = await import("./helpers/llmStub.js");

after(() => clearLlmStub());
beforeEach(() => clearLlmStub());

const summary: DataSummary = {
  rowCount: 60,
  columnCount: 4,
  columns: [
    { name: "Brand", type: "string", sampleValues: [] },
    { name: "Region", type: "string", sampleValues: [] },
    { name: "Volume_MT", type: "number", sampleValues: [] },
    { name: "Month", type: "date", sampleValues: [] },
  ],
  numericColumns: ["Volume_MT"],
  dateColumns: ["Month"],
};

const ctx = (): AgentExecutionContext =>
  ({
    sessionId: "s1",
    question: "Why did Saffola lose share in Q3?",
    data: [],
    summary,
    chatHistory: [],
    mode: "analysis",
  } as unknown as AgentExecutionContext);

describe("W39 · isMergedPrePlannerEnabled gate", () => {
  it("default off; only `true` enables", () => {
    const prev = process.env.MERGED_PRE_PLANNER;
    delete process.env.MERGED_PRE_PLANNER;
    assert.equal(isMergedPrePlannerEnabled(), false);
    process.env.MERGED_PRE_PLANNER = "1";
    assert.equal(isMergedPrePlannerEnabled(), false);
    process.env.MERGED_PRE_PLANNER = "true";
    assert.equal(isMergedPrePlannerEnabled(), true);
    if (prev === undefined) delete process.env.MERGED_PRE_PLANNER;
    else process.env.MERGED_PRE_PLANNER = prev;
  });
});

describe("W39 · runHypothesisAndBriefMerged — env gating", () => {
  it("returns ok:false when env flag is off (caller falls back to per-task path)", async () => {
    const prev = process.env.MERGED_PRE_PLANNER;
    delete process.env.MERGED_PRE_PLANNER;
    const bb = createBlackboard();
    const r = await runHypothesisAndBriefMerged(ctx(), bb, "t1", () => {}, false);
    assert.equal(r.ok, false);
    assert.equal(bb.hypotheses.length, 0);
    if (prev !== undefined) process.env.MERGED_PRE_PLANNER = prev;
  });
});

describe("W39 · runHypothesisAndBriefMerged — happy path", () => {
  it("populates blackboard hypotheses + sets ctx.analysisBrief in one call", async () => {
    process.env.MERGED_PRE_PLANNER = "true";
    let llmCallCount = 0;
    installLlmStub({
      [LLM_PURPOSE.HYPOTHESIS]: () => {
        llmCallCount++;
        return {
          hypotheses: [
            { text: "Saffola lost MT-channel volume", targetColumn: "Volume_MT" },
            { text: "South-region distribution gap", targetColumn: "Region" },
          ],
          brief: {
            version: 1,
            questionShape: "driver_discovery",
            outcomeMetricColumn: "Volume_MT",
            segmentationDimensions: ["Brand", "Region"],
            candidateDriverDimensions: ["Brand", "Region"],
            epistemicNotes: ["Observational; avoid causal claims."],
            filters: [],
            requestsDashboard: false,
            clarifyingQuestions: [],
          },
        };
      },
    });
    const c = ctx();
    const bb = createBlackboard();
    const r = await runHypothesisAndBriefMerged(c, bb, "t2", () => {}, true);
    assert.equal(r.ok, true);
    assert.equal(r.hypothesesCount, 2);
    assert.equal(r.briefSet, true);
    assert.equal(bb.hypotheses.length, 2);
    assert.match(bb.hypotheses[0].text, /Saffola lost MT-channel/);
    assert.equal(c.analysisBrief?.questionShape, "driver_discovery");
    assert.equal(llmCallCount, 1, "single merged call only");
    delete process.env.MERGED_PRE_PLANNER;
  });

  it("when shouldBuildBrief=false, hypotheses are written and ctx.analysisBrief stays unset", async () => {
    process.env.MERGED_PRE_PLANNER = "true";
    installLlmStub({
      [LLM_PURPOSE.HYPOTHESIS]: () => ({
        hypotheses: [{ text: "Stub hypothesis", targetColumn: undefined }],
        brief: null,
      }),
    });
    const c = ctx();
    const bb = createBlackboard();
    const r = await runHypothesisAndBriefMerged(c, bb, "t3", () => {}, false);
    assert.equal(r.ok, true);
    assert.equal(r.hypothesesCount, 1);
    assert.equal(r.briefSet, false);
    assert.equal(c.analysisBrief, undefined);
    delete process.env.MERGED_PRE_PLANNER;
  });

  it("returns ok:false when LLM call returns invalid JSON (caller falls back)", async () => {
    process.env.MERGED_PRE_PLANNER = "true";
    installLlmStub({
      [LLM_PURPOSE.HYPOTHESIS]: () => "not-valid-json",
    });
    const c = ctx();
    const bb = createBlackboard();
    const r = await runHypothesisAndBriefMerged(c, bb, "t4", () => {}, true);
    assert.equal(r.ok, false);
    assert.equal(bb.hypotheses.length, 0);
    assert.equal(c.analysisBrief, undefined);
    delete process.env.MERGED_PRE_PLANNER;
  });
});
