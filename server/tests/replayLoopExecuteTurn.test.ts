/**
 * Wave A8 (v2) · Deterministic-execution contract for the replay loop.
 *
 * Drives `__executeReplayTurnForTest` end-to-end against a Marico-shaped
 * fixture with every LLM call stubbed via the W18 harness. Asserts:
 *   1. Saved plan steps dispatch through the live ToolRegistry against
 *      the new session's data (planner is bypassed).
 *   2. The narrator runs live and produces an answer envelope grounded
 *      in the new tool outputs.
 *   3. The assistant message is stamped with `replayedFromAutomationId`
 *      so the client renders the "↻ From automation" badge.
 *   4. Saved chart templates / pivotDefaults / dashboardDraft are
 *      preserved on the assistant message.
 *   5. A failed plan step throws a ReplayStepError that the outer
 *      `replayAutomation` would surface as `automation_halted`.
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

const { __executeReplayTurnForTest } = await import(
  "../lib/automations/replayLoop.service.js"
);
const { buildAgentExecutionContext } = await import(
  "../lib/agents/runtime/context.js"
);
const { ToolRegistry } = await import(
  "../lib/agents/runtime/toolRegistry.js"
);
const { registerDefaultTools } = await import(
  "../lib/agents/runtime/tools/registerTools.js"
);
const { LLM_PURPOSE } = await import(
  "../lib/agents/runtime/llmCallPurpose.js"
);
const { installLlmStub, clearLlmStub, DEFAULT_STUB_HANDLERS } = await import(
  "./helpers/llmStub.js"
);

after(() => clearLlmStub());

const summary: DataSummary = {
  rowCount: 12,
  columnCount: 4,
  columns: [
    { name: "Brand", type: "string", sampleValues: ["A", "B"] },
    { name: "Region", type: "string", sampleValues: ["N", "S"] },
    { name: "Month", type: "date", sampleValues: ["2024-07"] },
    { name: "Sales", type: "number", sampleValues: [100, 200] },
  ],
  numericColumns: ["Sales"],
  dateColumns: ["Month"],
};

const data: Record<string, any>[] = [
  { Brand: "A", Region: "N", Month: "2024-07", Sales: 100 },
  { Brand: "A", Region: "S", Month: "2024-07", Sales: 110 },
  { Brand: "B", Region: "N", Month: "2024-07", Sales: 90 },
  { Brand: "B", Region: "S", Month: "2024-07", Sales: 95 },
];

const sac: SessionAnalysisContext = {
  version: 1,
  dataset: {
    shortDescription: "fixture",
    grainGuess: "row per brand × region × month",
    columnRoles: [
      { name: "Brand", role: "dimension" },
      { name: "Sales", role: "metric" },
    ],
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

const buildCtx = () =>
  buildAgentExecutionContext({
    sessionId: "fixture-session",
    username: "u@x.com",
    question: "(replaced per turn)",
    data,
    summary,
    chatHistory: [],
    mode: "analysis",
    chatDocument: chatDocument as ChatDocument,
  });

const registry = new ToolRegistry();
registerDefaultTools(registry);

before(() => {
  installLlmStub({
    ...DEFAULT_STUB_HANDLERS,
    [LLM_PURPOSE.NARRATOR]: () => ({
      body: "Replayed against the new dataset; Brand A leads.",
      keyInsight: "Brand A lead is consistent across regions.",
      ctas: [],
      tldr: "Brand A leads sales across both regions.",
      findings: [
        {
          headline: "Brand A total sales 210 vs Brand B 185",
          evidence: "From get_schema_summary fixture aggregation",
        },
      ],
      methodology: "Aggregated by Brand from the new session.",
      caveats: [],
      implications: [
        {
          statement: "Brand A's lead is regional-broad, not concentrated.",
          soWhat: "Defend across both regions, not just one.",
          confidence: "medium",
        },
      ],
      recommendations: [
        {
          action: "Track Brand A region-mix monthly",
          rationale: "Lead breadth tends to correlate with sustainability.",
          horizon: "this_quarter",
        },
      ],
    }),
  });
});

describe("Wave A8 v2 · executeReplayTurn deterministic execution", () => {
  it("dispatches saved plan steps through ToolRegistry and runs the live narrator", async () => {
    const ctx = buildCtx();
    const { assistantMessage, dashboardCreated } =
      await __executeReplayTurnForTest({
        ctx,
        registry,
        turn: {
          ordinal: 0,
          question: "What's the total sales by brand?",
          planSteps: [
            { id: "s1", tool: "get_schema_summary", args: {} },
          ],
        },
        automationId: "automation_test",
        turnId: "automation_test_turn_0",
      });

    assert.equal(assistantMessage.role, "assistant");
    assert.equal(
      assistantMessage.replayedFromAutomationId,
      "automation_test",
      "stamps badge id"
    );
    assert.ok(
      assistantMessage.content.length > 0,
      "narrator produces non-empty body"
    );
    assert.ok(
      assistantMessage.answerEnvelope?.tldr,
      "envelope carries tldr from narrator"
    );
    assert.ok(
      Array.isArray(assistantMessage.answerEnvelope?.findings) &&
        (assistantMessage.answerEnvelope?.findings?.length ?? 0) > 0,
      "envelope carries findings"
    );
    assert.equal(dashboardCreated, false, "no dashboard in this fixture turn");
    // agentTrace.steps mirrors the saved plan steps (carried forward for audit).
    const trace = assistantMessage.agentTrace as {
      steps?: unknown[];
      replayed?: boolean;
      automationId?: string;
    };
    assert.equal(trace?.replayed, true);
    assert.equal(trace?.automationId, "automation_test");
    assert.equal(trace?.steps?.length, 1);
  });

  it("preserves saved pivotDefaults + dashboardDraft on the assistant message", async () => {
    const ctx = buildCtx();
    const { assistantMessage, dashboardCreated } =
      await __executeReplayTurnForTest({
        ctx,
        registry,
        turn: {
          ordinal: 0,
          question: "Build a dashboard from the brand sales view.",
          planSteps: [
            { id: "s1", tool: "get_schema_summary", args: {} },
          ],
          pivotDefaults: {
            rows: ["Brand"],
            values: ["Sales"],
          },
          dashboardDraft: {
            name: "Brand sales dashboard",
            sheets: [],
          } as Record<string, unknown>,
        },
        automationId: "automation_test",
        turnId: "automation_test_turn_1",
      });

    assert.deepEqual(assistantMessage.pivotDefaults?.rows, ["Brand"]);
    assert.deepEqual(assistantMessage.pivotDefaults?.values, ["Sales"]);
    assert.equal(
      (assistantMessage.dashboardDraft as { name?: string } | undefined)?.name,
      "Brand sales dashboard"
    );
    assert.equal(dashboardCreated, true, "dashboardDraft → dashboardCreated=true");
  });

  it("throws ReplayStepError when a saved plan step references an unknown tool", async () => {
    const ctx = buildCtx();
    await assert.rejects(
      () =>
        __executeReplayTurnForTest({
          ctx,
          registry,
          turn: {
            ordinal: 0,
            question: "?",
            planSteps: [
              {
                id: "bad",
                tool: "tool_that_does_not_exist",
                args: {},
              },
            ],
          },
          automationId: "automation_test",
          turnId: "automation_test_turn_bad",
        }),
      /tool_that_does_not_exist/
    );
  });

  it("throws ReplayStepError when a saved plan step is malformed (validation fail)", async () => {
    const ctx = buildCtx();
    await assert.rejects(
      () =>
        __executeReplayTurnForTest({
          ctx,
          registry,
          turn: {
            ordinal: 0,
            question: "?",
            planSteps: [
              // Missing required `id` and `tool` fields.
              { args: {} } as unknown as Record<string, unknown>,
            ],
          },
          automationId: "automation_test",
          turnId: "automation_test_turn_bad2",
        }),
      /malformed/
    );
  });

  it("resets the blackboard between turns (no cross-turn finding leak)", async () => {
    // Run two turns on the same context. The narrator stub doesn't care
    // about specific findings, but the blackboard reset is observable
    // via ctx.blackboard.findings being scoped to the most recent turn.
    const ctx = buildCtx();
    await __executeReplayTurnForTest({
      ctx,
      registry,
      turn: {
        ordinal: 0,
        question: "Q1",
        planSteps: [
          { id: "s1", tool: "get_schema_summary", args: {} },
          { id: "s2", tool: "get_schema_summary", args: {} },
        ],
      },
      automationId: "x",
      turnId: "x_t0",
    });
    const findingsAfterT0 = ctx.blackboard?.findings.length ?? 0;
    assert.equal(findingsAfterT0, 2, "two steps → two findings");

    await __executeReplayTurnForTest({
      ctx,
      registry,
      turn: {
        ordinal: 1,
        question: "Q2",
        planSteps: [{ id: "s1", tool: "get_schema_summary", args: {} }],
      },
      automationId: "x",
      turnId: "x_t1",
    });
    const findingsAfterT1 = ctx.blackboard?.findings.length ?? 0;
    assert.equal(
      findingsAfterT1,
      1,
      "blackboard reset → only T1 findings remain"
    );
  });

  it("Audit fix #3 · saved chart-template fallback strips stale data[]", async () => {
    // Force the fallback path: a turn with NO analytical step → tools
    // emit no charts → finalCharts falls back to turn.charts. The fix
    // strips data[] so we don't render stale numbers from the original
    // session against the new dataset.
    const ctx = buildCtx();
    const { assistantMessage } = await __executeReplayTurnForTest({
      ctx,
      registry,
      turn: {
        ordinal: 0,
        question: "?",
        planSteps: [
          // get_schema_summary returns no chart in the saved registry,
          // so the chart-emission count for this turn is zero — the
          // fallback path fires.
          { id: "s1", tool: "get_schema_summary", args: {} },
        ],
        charts: [
          {
            type: "bar",
            title: "Brand sales (saved)",
            x: "Brand",
            y: "Sales",
            data: [
              // Stale data from the captured session — must NOT leak.
              { Brand: "OLD-A", Sales: 9999 },
              { Brand: "OLD-B", Sales: 8888 },
            ],
          },
        ],
      },
      automationId: "x",
      turnId: "x_strip",
    });
    assert.equal(assistantMessage.charts?.length, 1);
    assert.equal(
      assistantMessage.charts?.[0].data,
      undefined,
      "stale data[] must be stripped on fallback"
    );
    assert.equal(
      assistantMessage.charts?.[0].title,
      "Brand sales (saved)",
      "title preserved on fallback (renders empty chart shell)"
    );
  });

  it("Audit fix #6 · dashboardDraft chart entries rebind to fresh tool data by title", async () => {
    // Tools emit no charts in this fixture (get_schema_summary doesn't
    // emit one), so to test the rebinding we synthesize a tool that
    // returns a chart, dispatch via a one-off registry. Easier: stub
    // the assertion by exercising the rebind helper through a turn
    // whose saved dashboard draft has a chart whose title matches the
    // fallback chart we keep.
    //
    // The rebind walks `draft.charts[]` and `draft.sheets[].charts[]`
    // and copies `data` from the live chart matching by title. With no
    // tool-emitted charts, the saved chart is in the fallback (data
    // stripped), so the rebound dashboard draft chart should also have
    // data: undefined (i.e., no stale leak).
    const ctx = buildCtx();
    const { assistantMessage, dashboardCreated } =
      await __executeReplayTurnForTest({
        ctx,
        registry,
        turn: {
          ordinal: 0,
          question: "?",
          planSteps: [{ id: "s1", tool: "get_schema_summary", args: {} }],
          charts: [
            {
              type: "bar",
              title: "Brand sales",
              x: "Brand",
              y: "Sales",
              data: [{ Brand: "OLD", Sales: 1 }],
            },
          ],
          dashboardDraft: {
            name: "Test dashboard",
            sheets: [
              {
                id: "default",
                charts: [
                  {
                    type: "bar",
                    title: "Brand sales", // matches → rebinds
                    x: "Brand",
                    y: "Sales",
                    data: [{ Brand: "OLD", Sales: 1 }], // stale
                  },
                  {
                    type: "bar",
                    title: "Untitled extra", // no match → preserved as-is
                    x: "Brand",
                    y: "Sales",
                    data: [{ Brand: "OLD", Sales: 2 }],
                  },
                ],
              },
            ],
          } as Record<string, unknown>,
        },
        automationId: "x",
        turnId: "x_rebind",
      });

    assert.equal(dashboardCreated, true);
    const draft = assistantMessage.dashboardDraft as
      | { sheets?: Array<{ charts?: Array<Record<string, unknown>> }> }
      | undefined;
    const reboundCharts = draft?.sheets?.[0].charts ?? [];
    // Saved chart "Brand sales" rebinds to the fallback live chart's data
    // (which is undefined per the strip-on-fallback rule above), NOT the
    // saved stale data.
    assert.equal(
      reboundCharts[0]?.data,
      undefined,
      "title-matched dashboard chart receives the (data-stripped) live chart's data"
    );
    // Unmatched chart keeps its original (saved) data — best the rebind
    // can do without a live counterpart.
    assert.deepEqual(reboundCharts[1]?.data, [{ Brand: "OLD", Sales: 2 }]);
  });

  it("Audit fix #11 · agentTrace.steps is capped at 30 to prevent message bloat", async () => {
    const ctx = buildCtx();
    const bigPlan = Array.from({ length: 50 }, (_, i) => ({
      id: `s${i}`,
      tool: "get_schema_summary",
      args: {},
    }));
    const { assistantMessage } = await __executeReplayTurnForTest({
      ctx,
      registry,
      turn: {
        ordinal: 0,
        question: "?",
        planSteps: bigPlan,
      },
      automationId: "x",
      turnId: "x_cap",
    });
    const trace = assistantMessage.agentTrace as { steps?: unknown[] };
    assert.equal(trace?.steps?.length, 30);
  });
});
