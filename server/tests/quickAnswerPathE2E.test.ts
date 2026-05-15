/**
 * Wave QL1 · Quick-lookup fast-path end-to-end through `runAgentTurn`.
 *
 * Drives the full agent loop entry with stubbed LLMs against a small
 * in-memory fixture. Asserts:
 *   1. A lookup-shape question fires the fast path: only the QUICK_LOOKUP_PLANNER
 *      LLM purpose runs (no hypothesis / brief / planner / narrator / verifier).
 *   2. An analytical-shape question rejects the fast path and runs the full
 *      loop (hypothesis/narrator/verifier all fire).
 *   3. QUICK_LOOKUP_ENABLED=false force-routes every question to the full loop.
 *   4. Zero rows from the executor falls through to the full loop.
 *
 * No DuckDB / no RAG — `AGENTIC_ALLOW_NO_RAG=true` and we drive the in-memory
 * executor by leaving `columnarStoragePath` unset.
 */
import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
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
  "../lib/agents/runtime/types.js"
);
const { LLM_PURPOSE } = await import("../lib/agents/runtime/llmCallPurpose.js");
const { installLlmStub, clearLlmStub } = await import("./helpers/llmStub.js");

after(() => clearLlmStub());

const summary: DataSummary = {
  rowCount: 8,
  columnCount: 2,
  columns: [
    {
      name: "State",
      type: "string",
      sampleValues: ["CA", "TX"],
      topValues: [
        { value: "CA", count: 2 },
        { value: "TX", count: 2 },
        { value: "NY", count: 2 },
        { value: "WA", count: 2 },
      ],
    },
    { name: "Sales", type: "number", sampleValues: [100, 200] },
  ],
  numericColumns: ["Sales"],
  dateColumns: [],
};

const sac: SessionAnalysisContext = {
  version: 1,
  dataset: { shortDescription: "fixture", columnRoles: [], caveats: [] },
  userIntent: { interpretedConstraints: [] },
  sessionKnowledge: { facts: [], analysesDone: [] },
  suggestedFollowUps: [],
  lastUpdated: { reason: "seed", at: new Date().toISOString() },
};

const chatDocument: Partial<ChatDocument> = {
  id: "ql-fixture-session",
  sessionId: "ql-fixture-session",
  dataSummary: summary,
  sessionAnalysisContext: sac,
};

function fixtureData(): Record<string, any>[] {
  return [
    { State: "CA", Sales: 500 },
    { State: "TX", Sales: 400 },
    { State: "NY", Sales: 300 },
    { State: "WA", Sales: 250 },
    { State: "CA", Sales: 200 },
    { State: "TX", Sales: 150 },
    { State: "NY", Sales: 120 },
    { State: "WA", Sales: 100 },
  ];
}

function makeCtx(question: string) {
  return buildAgentExecutionContext({
    sessionId: "ql-fixture-session",
    username: "tester@example.com",
    question,
    data: fixtureData(),
    summary,
    chatHistory: [],
    mode: "analysis",
    sessionAnalysisContext: sac,
    chatDocument: chatDocument as ChatDocument,
  });
}

describe("Wave QL1 · quick-lookup fast path · end-to-end", () => {
  it("fires the fast path for a lookup question and skips hypothesis/narrator/verifier", async () => {
    process.env.QUICK_LOOKUP_ENABLED = "true";
    const callCounts: Record<string, number> = {};
    installLlmStub({
      [LLM_PURPOSE.QUICK_LOOKUP_PLANNER]: () => {
        callCounts.quick = (callCounts.quick ?? 0) + 1;
        return {
          plan: {
            groupBy: ["State"],
            aggregations: [
              { column: "Sales", operation: "sum", alias: "Total Sales" },
            ],
            sort: [{ column: "Total Sales", direction: "desc" }],
            limit: 3,
          },
          questionRestated: "Top 3 states by Sales",
        };
      },
      [LLM_PURPOSE.HYPOTHESIS]: () => {
        callCounts.hypothesis = (callCounts.hypothesis ?? 0) + 1;
        return { hypotheses: [{ text: "should not fire" }] };
      },
      [LLM_PURPOSE.PLANNER]: () => {
        callCounts.planner = (callCounts.planner ?? 0) + 1;
        return {
          rationale: "should not fire",
          steps: [{ id: "x", tool: "get_schema_summary", args: {} }],
        };
      },
      [LLM_PURPOSE.NARRATOR]: () => {
        callCounts.narrator = (callCounts.narrator ?? 0) + 1;
        return { body: "should not fire", tldr: "should not fire" };
      },
      [LLM_PURPOSE.VERIFIER_DEEP]: () => {
        callCounts.verifier = (callCounts.verifier ?? 0) + 1;
        return { verdict: "pass", issues: [], course_correction: "pass" };
      },
    });

    const ctx = makeCtx("top 3 states by sales");
    const result = await runAgentTurn(ctx, loadAgentConfigFromEnv());

    assert.strictEqual(
      callCounts.quick,
      1,
      "quick-lookup planner should have fired exactly once"
    );
    assert.strictEqual(
      callCounts.hypothesis,
      undefined,
      "hypothesis must NOT fire on the fast path"
    );
    assert.strictEqual(
      callCounts.planner,
      undefined,
      "full planner must NOT fire on the fast path"
    );
    assert.strictEqual(
      callCounts.narrator,
      undefined,
      "narrator must NOT fire on the fast path"
    );
    assert.strictEqual(
      callCounts.verifier,
      undefined,
      "verifier must NOT fire on the fast path"
    );
    // Result shape: empty answer, table with 3 rows, deterministic
    // suggestedQuestions-style follow-ups.
    assert.strictEqual(result.answer, "");
    assert.ok(Array.isArray(result.table) && result.table.length === 3);
    assert.ok(
      Array.isArray(result.followUpPrompts) && result.followUpPrompts.length === 3
    );
    // No narrator-generated envelope on the fast path.
    assert.strictEqual(result.answerEnvelope, undefined);
    // The agentTrace step shape is what `derivePivotDefaultsFromExecution`
    // reads to render the pivot. Verify exactly one execute_query_plan step.
    assert.strictEqual(result.agentTrace?.steps.length, 1);
    assert.strictEqual(result.agentTrace?.steps[0].tool, "execute_query_plan");
  });

  it("an analytical question rejects the fast path and runs the full loop", async () => {
    process.env.QUICK_LOOKUP_ENABLED = "true";
    const callCounts: Record<string, number> = {};
    installLlmStub({
      [LLM_PURPOSE.QUICK_LOOKUP_PLANNER]: () => {
        callCounts.quick = (callCounts.quick ?? 0) + 1;
        return {
          plan: { groupBy: ["State"], limit: 5 },
          questionRestated: "should not fire",
        };
      },
      [LLM_PURPOSE.HYPOTHESIS]: () => {
        callCounts.hypothesis = (callCounts.hypothesis ?? 0) + 1;
        return {
          hypotheses: [{ text: "Sales fell because of mix shift" }],
        };
      },
      // Force the loop to terminate cheaply: planner returns a finish-able
      // single-step plan; reflector finishes; narrator emits a minimal
      // envelope; verifier passes.
      [LLM_PURPOSE.PLANNER]: () => {
        callCounts.planner = (callCounts.planner ?? 0) + 1;
        return {
          rationale: "minimal",
          steps: [{ id: "s1", tool: "get_schema_summary", args: {} }],
        };
      },
      [LLM_PURPOSE.REFLECTOR]: () => ({ action: "finish", reasoning: "done" }),
      [LLM_PURPOSE.NARRATOR]: () => {
        callCounts.narrator = (callCounts.narrator ?? 0) + 1;
        return {
          body: "Full-loop narrator body.",
          tldr: "Stub.",
          findings: [],
          implications: [],
          recommendations: [],
          methodology: "stub",
          caveats: [],
        };
      },
      [LLM_PURPOSE.VERIFIER_DEEP]: () => {
        callCounts.verifier = (callCounts.verifier ?? 0) + 1;
        return { verdict: "pass", issues: [], course_correction: "pass" };
      },
    });

    const ctx = makeCtx("why are sales falling in California");
    await runAgentTurn(ctx, loadAgentConfigFromEnv());

    assert.strictEqual(
      callCounts.quick,
      undefined,
      "quick-lookup planner must NOT fire on an analytical question"
    );
    assert.ok(
      (callCounts.hypothesis ?? 0) >= 1,
      "hypothesis must fire on the full loop"
    );
    assert.ok(
      (callCounts.planner ?? 0) >= 1,
      "full planner must fire on the full loop"
    );
  });

  it("QUICK_LOOKUP_ENABLED=false force-routes a lookup question through the full loop", async () => {
    process.env.QUICK_LOOKUP_ENABLED = "false";
    const callCounts: Record<string, number> = {};
    installLlmStub({
      [LLM_PURPOSE.QUICK_LOOKUP_PLANNER]: () => {
        callCounts.quick = (callCounts.quick ?? 0) + 1;
        return {
          plan: { groupBy: ["State"], limit: 5 },
          questionRestated: "should not fire",
        };
      },
      [LLM_PURPOSE.HYPOTHESIS]: () => {
        callCounts.hypothesis = (callCounts.hypothesis ?? 0) + 1;
        return { hypotheses: [{ text: "stub" }] };
      },
      [LLM_PURPOSE.PLANNER]: () => ({
        rationale: "minimal",
        steps: [{ id: "s1", tool: "get_schema_summary", args: {} }],
      }),
      [LLM_PURPOSE.REFLECTOR]: () => ({ action: "finish", reasoning: "done" }),
      [LLM_PURPOSE.NARRATOR]: () => ({
        body: "Full-loop body.",
        tldr: "stub",
      }),
      [LLM_PURPOSE.VERIFIER_DEEP]: () => ({
        verdict: "pass",
        issues: [],
        course_correction: "pass",
      }),
    });

    const ctx = makeCtx("top 5 states by sales");
    await runAgentTurn(ctx, loadAgentConfigFromEnv());

    assert.strictEqual(
      callCounts.quick,
      undefined,
      "fast path must NOT fire when QUICK_LOOKUP_ENABLED=false"
    );
    assert.ok(
      (callCounts.hypothesis ?? 0) >= 1,
      "full loop must run when fast path is disabled"
    );

    // Reset for subsequent tests.
    process.env.QUICK_LOOKUP_ENABLED = "true";
  });

  it("zero-row executor result falls through to the full loop", async () => {
    process.env.QUICK_LOOKUP_ENABLED = "true";
    const callCounts: Record<string, number> = {};
    installLlmStub({
      [LLM_PURPOSE.QUICK_LOOKUP_PLANNER]: () => {
        callCounts.quick = (callCounts.quick ?? 0) + 1;
        // Filter that produces zero rows from the fixture (no row has
        // State === "NOPE").
        return {
          plan: {
            groupBy: ["State"],
            aggregations: [
              { column: "Sales", operation: "sum", alias: "Total Sales" },
            ],
            dimensionFilters: [
              { column: "State", op: "in", values: ["NOPE"] },
            ],
            limit: 10,
          },
          questionRestated: "Top 10 NOPE states",
        };
      },
      [LLM_PURPOSE.HYPOTHESIS]: () => {
        callCounts.hypothesis = (callCounts.hypothesis ?? 0) + 1;
        return { hypotheses: [{ text: "stub" }] };
      },
      [LLM_PURPOSE.PLANNER]: () => ({
        rationale: "minimal",
        steps: [{ id: "s1", tool: "get_schema_summary", args: {} }],
      }),
      [LLM_PURPOSE.REFLECTOR]: () => ({ action: "finish", reasoning: "done" }),
      [LLM_PURPOSE.NARRATOR]: () => ({
        body: "Full-loop body.",
        tldr: "stub",
      }),
      [LLM_PURPOSE.VERIFIER_DEEP]: () => ({
        verdict: "pass",
        issues: [],
        course_correction: "pass",
      }),
    });

    const ctx = makeCtx("top 10 states by sales");
    await runAgentTurn(ctx, loadAgentConfigFromEnv());

    assert.strictEqual(
      callCounts.quick,
      1,
      "fast path should have attempted and produced zero rows"
    );
    assert.ok(
      (callCounts.hypothesis ?? 0) >= 1,
      "zero-row fast-path attempt must fall through to the full loop"
    );
  });
});
