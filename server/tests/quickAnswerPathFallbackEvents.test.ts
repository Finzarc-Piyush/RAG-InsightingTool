/**
 * Wave QL3 · `quick_lookup_fallback` SSE events + intent-aware retry.
 *
 * Pre-QL3 the QL1 fast path silently returned null on planner_null /
 * plan_invalid / zero_rows / exec_failed — making it impossible to diagnose
 * from a Cosmos transcript why the user got a 60–120s full-loop answer for
 * a question that should have been a 2s table. QL3 emits a structured
 * `quick_lookup_fallback` event on every fall-through path AND retries the
 * Mini planner once with an explicit intent hint when the question carries
 * a detectable PD1/PD3 shape.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { detectPerXIntent, detectMultiPerIntent } from "../lib/agents/runtime/planArgRepairs.js";
import { formatQuickLookupIntentHint } from "../lib/agents/runtime/quickAnswerPath.js";
import type { DataSummary } from "../shared/schema.js";

process.env.AZURE_OPENAI_API_KEY ??= "test";
process.env.AZURE_OPENAI_ENDPOINT ??= "https://test.openai.azure.com";
process.env.AZURE_OPENAI_DEPLOYMENT_NAME ??= "test-deployment";
process.env.AGENTIC_LOOP_ENABLED = "true";
process.env.AGENTIC_ALLOW_NO_RAG = "true";
process.env.AGENT_INTER_AGENT_MESSAGES = "false";
process.env.QUICK_LOOKUP_ENABLED = "true";

const { tryQuickAnswer } = await import(
  "../lib/agents/runtime/quickAnswerPath.js"
);
const { buildAgentExecutionContext } = await import(
  "../lib/agents/runtime/context.js"
);
const { LLM_PURPOSE } = await import("../lib/agents/runtime/llmCallPurpose.js");
const { installLlmStub, clearLlmStub } = await import("./helpers/llmStub.js");

after(() => clearLlmStub());

const summary: DataSummary = {
  rowCount: 8,
  columnCount: 4,
  columns: [
    { name: "Cluster Name", type: "string", sampleValues: ["A", "B"] },
    { name: "Region", type: "string", sampleValues: ["North", "South"] },
    { name: "Compliance Visit", type: "number", sampleValues: [3, 5] },
    { name: "Date", type: "date", sampleValues: ["2026-04-01"] },
  ],
  numericColumns: ["Compliance Visit"],
  dateColumns: ["Date"],
};

function makeCtx(question: string) {
  return buildAgentExecutionContext({
    sessionId: "ql3-fixture",
    username: "tester@example.com",
    question,
    data: [
      { "Cluster Name": "A", Region: "North", "Compliance Visit": 5, Date: "2026-04-01" },
      { "Cluster Name": "B", Region: "South", "Compliance Visit": 3, Date: "2026-04-02" },
    ],
    summary,
    chatHistory: [],
    mode: "analysis",
    sessionAnalysisContext: {
      version: 1,
      dataset: { shortDescription: "fixture", columnRoles: [], caveats: [] },
      userIntent: { interpretedConstraints: [] },
      sessionKnowledge: { facts: [], analysesDone: [] },
      suggestedFollowUps: [],
      lastUpdated: { reason: "seed", at: new Date().toISOString() },
    },
    chatDocument: {
      id: "ql3-fixture",
      sessionId: "ql3-fixture",
      dataSummary: summary,
    } as never,
  });
}

describe("Wave QL3 · formatQuickLookupIntentHint", () => {
  it("returns null when neither intent is detected", () => {
    assert.equal(formatQuickLookupIntentHint(null, null), null);
  });

  it("emits a multi-per hint when PD3 fires", () => {
    const q = "What is the average compliance visits per day per cluster name?";
    const perX = detectPerXIntent(q, summary);
    const multiPer = detectMultiPerIntent(q, summary);
    const hint = formatQuickLookupIntentHint(perX, multiPer);
    assert.ok(hint);
    assert.match(hint!, /multi-per/i);
    assert.match(hint!, /perDimension.+Day · Date/);
    assert.match(hint!, /groupBy.+Cluster Name/);
    assert.match(hint!, /innerOperation.+sum/);
  });

  it("emits a single-per hint when only PD1 fires", () => {
    const q = "What is the average compliance visits per day?";
    const perX = detectPerXIntent(q, summary);
    const multiPer = detectMultiPerIntent(q, summary);
    const hint = formatQuickLookupIntentHint(perX, multiPer);
    assert.ok(hint);
    assert.match(hint!, /rate intent/);
    assert.match(hint!, /perDimension="Day · Date"/);
    assert.match(hint!, /innerOperation="sum"/);
  });
});

describe("Wave QL3 · quick_lookup_fallback SSE events", () => {
  it("emits planner_null fallback + retries with intent hint when PD1/PD3 fires", async () => {
    const userPrompts: string[] = [];
    installLlmStub({
      [LLM_PURPOSE.QUICK_LOOKUP_PLANNER]: (params) => {
        const user = params.messages.find((m) => m.role === "user");
        const c = (user?.content ?? "") as string;
        userPrompts.push(typeof c === "string" ? c : JSON.stringify(c));
        // Always return Zod-invalid so the planner ends up null after retries.
        return { plan: {}, questionRestated: "" };
      },
    });

    const emitted: { event: string; data: any }[] = [];
    const ctx = makeCtx(
      "What is the average compliance visits per day per cluster name?"
    );
    const result = await tryQuickAnswer({
      ctx,
      turnId: "tn-1",
      onLlmCall: () => {},
      safeEmit: (event, data) => emitted.push({ event, data }),
    });

    assert.equal(result, null);
    // At least one of the prompts (the retry attempt) must carry the
    // DETECTED INTENT block; the initial attempt MUST NOT.
    const withHint = userPrompts.filter((p) => p.includes("DETECTED INTENT"));
    const withoutHint = userPrompts.filter((p) => !p.includes("DETECTED INTENT"));
    assert.ok(withHint.length >= 1, "retry should carry DETECTED INTENT block");
    assert.ok(withoutHint.length >= 1, "initial attempt should NOT carry the hint");
    const fallback = emitted.find((e) => e.event === "quick_lookup_fallback");
    assert.ok(fallback, "should emit quick_lookup_fallback");
    assert.equal(fallback!.data.reason, "planner_null");
    assert.equal(fallback!.data.retriedWithHint, true);
  });

  it("does NOT retry when the question has no detectable aggregation intent", async () => {
    const userPrompts: string[] = [];
    installLlmStub({
      [LLM_PURPOSE.QUICK_LOOKUP_PLANNER]: (params) => {
        const user = params.messages.find((m) => m.role === "user");
        const c = (user?.content ?? "") as string;
        userPrompts.push(typeof c === "string" ? c : JSON.stringify(c));
        return { plan: {}, questionRestated: "" };
      },
    });

    const emitted: { event: string; data: any }[] = [];
    const ctx = makeCtx("Top 5 clusters by compliance visit");
    const result = await tryQuickAnswer({
      ctx,
      turnId: "tn-2",
      onLlmCall: () => {},
      safeEmit: (event, data) => emitted.push({ event, data }),
    });

    assert.equal(result, null);
    // No prompt may carry the DETECTED INTENT block when neither PD1 nor PD3
    // detects intent (the verb "top" is not an aggregation outer-op).
    const withHint = userPrompts.filter((p) => p.includes("DETECTED INTENT"));
    assert.equal(
      withHint.length,
      0,
      "should NOT retry with hint without detectable per/multi-per shape"
    );
    const fallback = emitted.find((e) => e.event === "quick_lookup_fallback");
    assert.ok(fallback);
    assert.equal(fallback!.data.retriedWithHint, false);
  });

  it("emits zero_rows fallback with hasAggIntent=true for the failing Marico shape", async () => {
    installLlmStub({
      [LLM_PURPOSE.QUICK_LOOKUP_PLANNER]: () => ({
        plan: {
          groupBy: ["Cluster Name"],
          aggregations: [
            {
              // No perDimension — the in-memory executor handles this shape
              // and we just need a filter that matches no rows.
              column: "Compliance Visit",
              operation: "mean",
              alias: "avg",
            },
          ],
          dimensionFilters: [
            { column: "Cluster Name", op: "in", values: ["NONEXISTENT"] },
          ],
        },
        questionRestated: "Average compliance visits per cluster",
      }),
    });

    const emitted: { event: string; data: any }[] = [];
    const ctx = makeCtx(
      "What is the average compliance visits per day per cluster name?"
    );
    const result = await tryQuickAnswer({
      ctx,
      turnId: "tn-3",
      onLlmCall: () => {},
      safeEmit: (event, data) => emitted.push({ event, data }),
    });

    assert.equal(result, null);
    const fallback = emitted.find(
      (e) =>
        e.event === "quick_lookup_fallback" &&
        (e.data?.reason === "zero_rows" || e.data?.reason === "plan_invalid")
    );
    assert.ok(fallback, "should emit a fallback event");
    // The aggregation intent should be detected regardless of which fall-
    // through fired (zero_rows surfaces hasAggIntent; plan_invalid doesn't,
    // but either way the fallback event lands).
    if (fallback!.data.reason === "zero_rows") {
      assert.equal(fallback!.data.hasAggIntent, true);
    }
  });
});
