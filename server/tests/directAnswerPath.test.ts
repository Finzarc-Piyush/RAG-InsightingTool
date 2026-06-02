/**
 * Wave R1 · directAnswerPath — the LLM-driven front-door router.
 *
 * Verifies the triage fast path: "direct" returns a text-only AgentLoopResult
 * (no tools), "escalate"/empty/invalid returns null so the caller falls through
 * to the full pipeline, the gates short-circuit before any LLM call, and the
 * prompt carries the dataset metadata a direct answer needs.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import type { DataSummary } from "../shared/schema.js";

process.env.AZURE_OPENAI_API_KEY ??= "test";
process.env.AZURE_OPENAI_ENDPOINT ??= "https://test.openai.azure.com";
process.env.AZURE_OPENAI_DEPLOYMENT_NAME ??= "test-deployment";
process.env.AGENTIC_LOOP_ENABLED = "true";
process.env.AGENTIC_ALLOW_NO_RAG = "true";
process.env.AGENT_INTER_AGENT_MESSAGES = "false";
process.env.DIRECT_ANSWER_ENABLED = "true";
process.env.QUICK_LOOKUP_ENABLED = "true";

const { tryDirectAnswer } = await import(
  "../lib/agents/runtime/directAnswerPath.js"
);
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
  rowCount: 1200,
  columnCount: 3,
  columns: [
    {
      name: "Product",
      type: "string",
      sampleValues: ["Parachute", "Saffola"],
      topValues: [
        { value: "Parachute", count: 600 },
        { value: "Saffola", count: 600 },
      ],
    },
    { name: "Sales", type: "number", sampleValues: [10, 20] },
    {
      name: "Order Date",
      type: "date",
      sampleValues: ["2024-01-01"],
      dateRange: {
        minIso: "2024-01-01",
        maxIso: "2024-12-31",
        distinctDayCount: 360,
        spanDays: 365,
      },
    },
  ],
  numericColumns: ["Sales"],
  dateColumns: ["Order Date"],
};

function makeCtx(
  question: string,
  mode: "analysis" | "dataOps" | "modeling" = "analysis",
  overrideSummary?: DataSummary
) {
  return buildAgentExecutionContext({
    sessionId: "r1-fixture",
    username: "tester@example.com",
    question,
    data: [
      { Product: "Parachute", Sales: 10, "Order Date": "2024-01-01" },
      { Product: "Saffola", Sales: 20, "Order Date": "2024-06-01" },
    ],
    summary: overrideSummary ?? summary,
    chatHistory: [],
    mode,
    chatDocument: {
      id: "r1-fixture",
      sessionId: "r1-fixture",
      dataSummary: overrideSummary ?? summary,
    } as never,
  });
}

describe("Wave R1 · tryDirectAnswer", () => {
  it("returns a text-only result on strategy=direct and emits mode:direct_answer", async () => {
    installLlmStub({
      [LLM_PURPOSE.CONVERSATIONAL]: () => ({
        strategy: "direct",
        answer: "I can analyse your uploaded dataset — try asking about sales trends.",
        followUps: ["Show sales by product", "What's the date range?"],
      }),
    });
    const emitted: { event: string; data: any }[] = [];
    let llmCalls = 0;
    const result = await tryDirectAnswer({
      ctx: makeCtx("what can you do?"),
      turnId: "tn-direct",
      onLlmCall: () => {
        llmCalls += 1;
      },
      safeEmit: (event, data) => emitted.push({ event, data }),
    });

    assert.ok(result, "should return a result");
    assert.ok(result!.answer.includes("analyse"), "carries the LLM answer text");
    assert.equal(result!.table, undefined, "no table on a direct answer");
    assert.equal(result!.charts, undefined, "no charts on a direct answer");
    assert.equal(result!.agentTrace?.turnId, "tn-direct");
    assert.equal(result!.agentTrace?.planRationale, "direct_answer");
    assert.deepEqual(result!.followUpPrompts, [
      "Show sales by product",
      "What's the date range?",
    ]);
    assert.ok(llmCalls >= 1, "made the triage LLM call");
    const mode = emitted.find((e) => e.event === "mode");
    assert.ok(mode && mode.data.mode === "direct_answer");
  });

  it("returns null on strategy=escalate and emits direct_answer_fallback", async () => {
    installLlmStub({
      [LLM_PURPOSE.CONVERSATIONAL]: () => ({ strategy: "escalate" }),
    });
    const emitted: { event: string; data: any }[] = [];
    const result = await tryDirectAnswer({
      ctx: makeCtx("what is driving the sales decline?"),
      turnId: "tn-esc",
      onLlmCall: () => {},
      safeEmit: (event, data) => emitted.push({ event, data }),
    });
    assert.equal(result, null);
    const fb = emitted.find((e) => e.event === "direct_answer_fallback");
    assert.ok(fb, "should emit a fallback event");
    assert.equal(fb!.data.reason, "escalate");
  });

  it("returns null when strategy=direct but answer is empty", async () => {
    installLlmStub({
      [LLM_PURPOSE.CONVERSATIONAL]: () => ({ strategy: "direct", answer: "   " }),
    });
    const emitted: { event: string; data: any }[] = [];
    const result = await tryDirectAnswer({
      ctx: makeCtx("hi"),
      turnId: "tn-empty",
      onLlmCall: () => {},
      safeEmit: (event, data) => emitted.push({ event, data }),
    });
    assert.equal(result, null);
    const fb = emitted.find((e) => e.event === "direct_answer_fallback");
    assert.equal(fb!.data.reason, "empty_answer");
  });

  it("returns null with ZERO LLM calls when the flag is off", async () => {
    installLlmStub({
      [LLM_PURPOSE.CONVERSATIONAL]: () => ({ strategy: "direct", answer: "x" }),
    });
    const prev = process.env.DIRECT_ANSWER_ENABLED;
    process.env.DIRECT_ANSWER_ENABLED = "false";
    let llmCalls = 0;
    try {
      const result = await tryDirectAnswer({
        ctx: makeCtx("hi"),
        turnId: "tn-off",
        onLlmCall: () => {
          llmCalls += 1;
        },
        safeEmit: () => {},
      });
      assert.equal(result, null);
      assert.equal(llmCalls, 0, "flag gate must short-circuit before any LLM call");
    } finally {
      process.env.DIRECT_ANSWER_ENABLED = prev;
    }
  });

  it("returns null with ZERO LLM calls for non-analysis mode", async () => {
    installLlmStub({
      [LLM_PURPOSE.CONVERSATIONAL]: () => ({ strategy: "direct", answer: "x" }),
    });
    let llmCalls = 0;
    const result = await tryDirectAnswer({
      ctx: makeCtx("add a margin column", "dataOps"),
      turnId: "tn-mode",
      onLlmCall: () => {
        llmCalls += 1;
      },
      safeEmit: () => {},
    });
    assert.equal(result, null);
    assert.equal(llmCalls, 0);
  });

  it("returns null with ZERO LLM calls when the summary has no columns", async () => {
    installLlmStub({
      [LLM_PURPOSE.CONVERSATIONAL]: () => ({ strategy: "direct", answer: "x" }),
    });
    const emptySummary: DataSummary = {
      rowCount: 0,
      columnCount: 0,
      columns: [],
      numericColumns: [],
      dateColumns: [],
    };
    let llmCalls = 0;
    const result = await tryDirectAnswer({
      ctx: makeCtx("hi", "analysis", emptySummary),
      turnId: "tn-nocols",
      onLlmCall: () => {
        llmCalls += 1;
      },
      safeEmit: () => {},
    });
    assert.equal(result, null);
    assert.equal(llmCalls, 0);
  });

  it("includes row count, column names, and the date range in the prompt", async () => {
    let captured = "";
    installLlmStub({
      [LLM_PURPOSE.CONVERSATIONAL]: (params) => {
        const user = params.messages.find((m) => m.role === "user");
        captured = typeof user?.content === "string" ? user.content : "";
        return { strategy: "direct", answer: "ok" };
      },
    });
    await tryDirectAnswer({
      ctx: makeCtx("what columns are in this data and what period does it cover?"),
      turnId: "tn-prompt",
      onLlmCall: () => {},
      safeEmit: () => {},
    });
    assert.match(captured, /rows: 1200/);
    assert.match(captured, /Product/);
    assert.match(captured, /Sales/);
    assert.match(captured, /range: 2024-01-01\.\.2024-12-31/);
  });
});

describe("Wave R2 · lookup routing", () => {
  it("on strategy=lookup sets ctx.routeToLookup, returns null, no fallback event", async () => {
    installLlmStub({
      [LLM_PURPOSE.CONVERSATIONAL]: () => ({ strategy: "lookup" }),
    });
    const emitted: { event: string; data: any }[] = [];
    const ctx = makeCtx("give me a list of all products");
    const result = await tryDirectAnswer({
      ctx,
      turnId: "tn-lookup",
      onLlmCall: () => {},
      safeEmit: (event, data) => emitted.push({ event, data }),
    });
    assert.equal(result, null);
    assert.equal((ctx as any).routeToLookup, true, "flags the lookup route");
    // It must NOT emit a fallback (we are routing to quick-lookup, not the loop).
    assert.equal(
      emitted.find((e) => e.event === "direct_answer_fallback"),
      undefined
    );
    const thinking = emitted.filter((e) => e.event === "thinking");
    assert.ok(
      thinking.some((e) => /quick data lookup/i.test(e.data?.details ?? "")),
      "completes the triage row with a lookup-route note"
    );
  });

  it("ctx.routeToLookup lets the quick path fire on a phrasing the regex rejects", async () => {
    // "give me a list of all products" is NOT matched by detectQuickLookup
    // (it doesn't start with a lookup keyword). With routeToLookup set, gate 3
    // must be bypassed so the quick-lookup planner is reached.
    let plannerCalled = false;
    installLlmStub({
      [LLM_PURPOSE.QUICK_LOOKUP_PLANNER]: () => {
        plannerCalled = true;
        return { plan: {}, questionRestated: "" }; // invalid → falls through
      },
    });
    const ctx = makeCtx("give me a list of all products");
    (ctx as any).routeToLookup = true;
    const result = await tryQuickAnswer({
      ctx,
      turnId: "tn-force",
      onLlmCall: () => {},
      safeEmit: () => {},
    });
    assert.equal(result, null, "invalid plan still falls through safely");
    assert.equal(plannerCalled, true, "gate 3 bypassed → planner reached");
  });

  it("without routeToLookup the same phrasing is rejected by the regex gate (no planner call)", async () => {
    let plannerCalled = false;
    installLlmStub({
      [LLM_PURPOSE.QUICK_LOOKUP_PLANNER]: () => {
        plannerCalled = true;
        return { plan: {}, questionRestated: "" };
      },
    });
    const ctx = makeCtx("give me a list of all products");
    const result = await tryQuickAnswer({
      ctx,
      turnId: "tn-noforce",
      onLlmCall: () => {},
      safeEmit: () => {},
    });
    assert.equal(result, null);
    assert.equal(plannerCalled, false, "regex gate rejects before any planner call");
  });
});
