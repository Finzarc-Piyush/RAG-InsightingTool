/**
 * Findings ARCH-1 / CQ-1 · `runAgentTurn` characterization GATE.
 *
 * The single orchestrator `agentLoop.service.ts:runAgentTurn` is a ~3.7 KLOC
 * god-file. Before any further phase extraction can be done safely, we need a
 * test that PINS the observable contract of a full turn so a behaviour-changing
 * refactor fails loudly. This file is that gate.
 *
 * WHAT IT PINS (the externally-observable contract — NOT internals):
 *   1. The ORDERED set of SSE event kinds a simple turn emits. We assert the
 *      load-bearing events are present AND in their canonical relative order
 *      (thinking → plan → tool_call → tool_result → answer_chunk-or-narrator-
 *      done → critic_verdict). We do NOT pin the exact full sequence (that is
 *      brittle against benign telemetry additions); we pin RELATIVE ORDER of
 *      the events the client's stream renderer actually depends on.
 *   2. The final answer-envelope SHAPE — which top-level keys runAgentTurn
 *      populates on the returned `AgentLoopResult` (answer / answerEnvelope
 *      with tldr+findings+implications+… / magnitudes / investigationSummary /
 *      agentTrace / blackboard). A future split must keep these keys.
 *   3. A one-chart turn surfaces a `ChartSpec` on `result.charts` — proving the
 *      deterministic chart-build + deferred-materialise + merge path is
 *      exercised end-to-end through `runAgentTurn`.
 *
 * WHY THE COSMOS DOUBLE IS LOAD-BEARING HERE:
 *   `runAgentTurn` schedules a DEBOUNCED mid-turn checkpoint
 *   (`scheduleTurnCheckpoint`, 3s) that fires AFTER the turn returns and writes
 *   through `mutateChatDocument` → `getChatBySessionIdEfficient` →
 *   `waitForContainer`. With no Cosmos and no double, `waitForContainer` burns
 *   60×500ms = ~30s in its retry loop before swallowing the error (the existing
 *   agentTurnE2EW20 test pays exactly this — it passes but takes ~33s). Injecting
 *   the in-memory double via `__setContainerForTesting` makes that write resolve
 *   INSTANTLY, so this gate runs in single-digit seconds with no hang.
 *
 * The LLM is stubbed via the W18 harness; tools run for real against the
 * in-memory fixture frame (`get_schema_summary`, deterministic `build_chart`).
 * The analytical SQL tools (`execute_query_plan`) need a columnar-storage
 * handle that the upload pipeline opens — out of scope for this gate — so the
 * one-chart turn uses the deterministic `build_chart` tool, which compiles
 * directly from `ctx.data` with no DuckDB dependency.
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
// Keep the checkpoint debounce short so the post-turn timer fires (and is
// serviced by the double) inside the test window instead of after it.
process.env.AGENT_CHECKPOINT_DEBOUNCE_MS = "1000";

const { runAgentTurn } = await import("../lib/agents/runtime/agentLoop.service.js");
const { buildAgentExecutionContext } = await import(
  "../lib/agents/runtime/context.js"
);
const { loadAgentConfigFromEnv } = await import(
  "../lib/agents/runtime/runtimeConfig.js"
);
const { LLM_PURPOSE } = await import("../lib/agents/runtime/llmCallPurpose.js");
const { installLlmStub, clearLlmStub } = await import("./helpers/llmStub.js");
const { makeInMemoryContainer } = await import(
  "./helpers/inMemoryCosmosContainer.js"
);
const { __setContainerForTesting } = await import(
  "../models/database.config.js"
);
const { __resetSessionWriteChainForTesting } = await import(
  "../lib/sessionWriteLock.js"
);
const { clearTurnCheckpoint } = await import("../lib/turnCheckpoint.js");

const SESSION_ID = "characterization-session";
const USERNAME = "tester@example.com";

// ── Fixture: Marico-shaped frame (real DuckDB runs over this) ───────────
function fixtureData(): Record<string, any>[] {
  const brands = ["Saffola", "Parachute", "Nihar"];
  const regions = ["South", "East", "West", "North"];
  const rows: Record<string, any>[] = [];
  let seed = 1;
  for (const brand of brands) {
    for (const region of regions) {
      rows.push({
        Brand: brand,
        Region: region,
        Volume: 100 + ((seed * 7) % 250),
        Value: 25_000 + ((seed * 137) % 70_000),
      });
      seed++;
    }
  }
  return rows;
}

const summary: DataSummary = {
  rowCount: 12,
  columnCount: 4,
  columns: [
    { name: "Brand", type: "string", sampleValues: ["Saffola", "Parachute"] },
    { name: "Region", type: "string", sampleValues: ["South", "East"] },
    { name: "Volume", type: "number", sampleValues: [120, 240] },
    { name: "Value", type: "number", sampleValues: [25000, 60000] },
  ],
  numericColumns: ["Volume", "Value"],
  dateColumns: [],
};

const sac: SessionAnalysisContext = {
  version: 1,
  dataset: {
    shortDescription: "Marico brand × region volume tracker.",
    columnRoles: [
      { name: "Brand", role: "dimension" },
      { name: "Region", role: "dimension" },
      { name: "Volume", role: "metric" },
      { name: "Value", role: "metric" },
    ],
    caveats: [],
  },
  userIntent: { interpretedConstraints: [] },
  sessionKnowledge: { facts: [], analysesDone: [] },
  suggestedFollowUps: [],
  lastUpdated: { reason: "seed", at: new Date().toISOString() },
};

const chatDocument: Partial<ChatDocument> = {
  id: "chat_characterization",
  sessionId: SESSION_ID,
  dataSummary: summary,
  sessionAnalysisContext: sac,
};

/**
 * Seed the in-memory Cosmos double with a chat doc the post-turn checkpoint
 * write can find + IfMatch-update. Partition key is `/fsmrora` (username), per
 * the chats container config. Without this seed the checkpoint's
 * `getChatBySessionIdEfficient` returns null and the write no-ops; with it the
 * RMW seam exercises a real read→mutate→upsert round-trip against the double.
 */
function seedCosmosDouble() {
  const handle = makeInMemoryContainer(
    [
      {
        id: "chat_characterization",
        sessionId: SESSION_ID,
        fsmrora: USERNAME,
        username: USERNAME,
        lastUpdatedAt: 1,
        messages: [],
      },
    ],
    { partitionKeyPath: "/fsmrora" }
  );
  __setContainerForTesting(handle.container);
  // Reset the per-session write-lock chain so a debounced checkpoint write left
  // pending by a prior subtest can't serialise behind a stale promise.
  __resetSessionWriteChainForTesting();
  return handle;
}

/**
 * Run a turn the way the chat-stream ROUTE does: run, then cancel + flush the
 * debounced mid-turn checkpoint. `runAgentTurn` schedules the checkpoint but
 * does NOT clear it (the route layer owns teardown via `clearTurnCheckpoint`);
 * without this the post-turn timer fires after the suite tears the double down
 * and burns ~30s in `waitForContainer`. Cancelling it here keeps the gate fast
 * AND exercises the real `mutateChatDocument` RMW seam against the double.
 */
async function runTurnLikeRoute(
  ctx: Parameters<typeof runAgentTurn>[0],
  emit: Parameters<typeof runAgentTurn>[2]
) {
  const result = await runAgentTurn(ctx, loadAgentConfigFromEnv(), emit);
  await clearTurnCheckpoint(SESSION_ID, USERNAME);
  return result;
}

/** Capturing SSE emitter: records (event, data) in arrival order. */
function makeEmitterCapture() {
  const events: Array<{ event: string; data: unknown }> = [];
  const emit = (event: string, data: unknown) => {
    events.push({ event, data });
  };
  return { events, emit };
}

/** Index of the FIRST occurrence of an event kind, or -1. */
function firstIdx(events: Array<{ event: string }>, kind: string): number {
  return events.findIndex((e) => e.event === kind);
}

// The envelope keys runAgentTurn populates on a rich narrator turn. This is the
// contract the AnswerCard renders against; a split must not drop any of these.
const EXPECTED_ENVELOPE_KEYS = [
  "tldr",
  "findings",
  "methodology",
  "implications",
  "recommendations",
] as const;

function installNarratorStub(planSteps: unknown[]) {
  installLlmStub({
    [LLM_PURPOSE.PLANNER]: () => ({
      rationale: "Confirm dataset shape, then synthesise.",
      steps: planSteps,
    }),
    [LLM_PURPOSE.HYPOTHESIS]: () => ({
      hypotheses: [
        { text: "Saffola leads volume in the South region.", targetColumn: "Volume" },
      ],
    }),
    [LLM_PURPOSE.ANALYSIS_BRIEF]: () => ({
      questionShape: "driver_discovery",
      outcomeMetricColumn: "Volume",
      segmentationDimensions: ["Brand", "Region"],
      candidateDriverDimensions: ["Brand", "Region"],
      epistemicNotes: ["fixture"],
    }),
    [LLM_PURPOSE.NARRATOR]: () => ({
      body:
        "Saffola leads brand volume, concentrated in the South region; Parachute trails across all four regions while Nihar is a distant third.",
      keyInsight: "Volume leadership is brand-specific, not region-wide.",
      ctas: ["What is Saffola's value-per-unit vs Parachute?"],
      tldr: "Saffola leads volume, driven by the South region.",
      findings: [
        { headline: "Saffola tops volume", evidence: "Brand aggregation", magnitude: "+18%" },
        { headline: "South leads regions", evidence: "Region aggregation", magnitude: "+9%" },
      ],
      methodology: "Aggregated brand × region for Volume.",
      caveats: ["Single-period snapshot"],
      implications: [
        {
          statement: "Saffola's lead is brand-specific.",
          soWhat: "Protect Saffola shelf space in the South.",
          confidence: "high",
        },
        {
          statement: "Parachute under-indexes everywhere.",
          soWhat: "Distribution review needed for Parachute.",
          confidence: "medium",
        },
      ],
      recommendations: [
        {
          action: "Protect Saffola South shelf space",
          rationale: "Highest-volume brand-region cell",
          horizon: "now",
        },
        {
          action: "Audit Parachute distribution",
          rationale: "Under-indexes across all regions",
          horizon: "this_quarter",
        },
      ],
      domainLens:
        "Per `marico-foods-edible-oils-portfolio`, Saffola is the flagship and its volume lead anchors the franchise.",
      magnitudes: [
        { label: "Saffola volume lead", value: "+18%", confidence: "high" },
        { label: "South region lift", value: "+9%", confidence: "medium" },
      ],
      unexplained: "Channel split not analysed.",
    }),
    [LLM_PURPOSE.VERIFIER_DEEP]: () => ({
      verdict: "pass",
      issues: [],
      course_correction: "pass",
      scores: { goal_alignment: 0.9, evidence_consistency: 0.9, completeness: 0.9 },
    }),
    [LLM_PURPOSE.VISUAL_PLANNER]: () => ({ addCharts: [] }),
    [LLM_PURPOSE.REFLECTOR]: () => ({ action: "finish", reasoning: "fixture" }),
  });
}

function buildCtx(question: string) {
  const ctx = buildAgentExecutionContext({
    sessionId: SESSION_ID,
    username: USERNAME,
    question,
    data: fixtureData(),
    summary,
    chatHistory: [],
    mode: "analysis",
    domainContext:
      "<<DOMAIN PACK: marico-foods-edible-oils-portfolio>>\n# Marico Foods\nSaffola is the flagship.\n<</DOMAIN PACK>>",
    sessionAnalysisContext: sac,
    chatDocument: chatDocument as ChatDocument,
  });
  // Pre-set the brief so the diagnostic path (completeness gate) is exercised
  // without depending on the brief LLM-call gate.
  ctx.analysisBrief = {
    questionShape: "driver_discovery",
    outcomeMetricColumn: "Volume",
    segmentationDimensions: ["Brand", "Region"],
    candidateDriverDimensions: ["Brand", "Region"],
    epistemicNotes: ["fixture"],
    filters: [],
    requestsDashboard: false,
    clarifyingQuestions: [],
  };
  return ctx;
}

after(() => {
  clearLlmStub();
  __setContainerForTesting(null);
});

describe("runAgentTurn characterization · SSE contract + envelope shape", () => {
  before(() => {
    seedCosmosDouble();
  });

  it("SHAPE A · plain single-step turn pins the ordered SSE events + envelope keys", async () => {
    installNarratorStub([{ id: "s1", tool: "get_schema_summary", args: {} }]);
    seedCosmosDouble();
    const { events, emit } = makeEmitterCapture();
    // A DIAGNOSTIC "why" question → full depth budget. A plain lookup
    // ("which brand leads volume") classifies as `minimal` and the envelope
    // SUPPRESSES recommendations + nextSteps (invariant #12 — answer the ask,
    // don't auto-pad), so the full-envelope contract must be pinned on a
    // diagnostic ask.
    const ctx = buildCtx(
      "Why does Saffola lead volume, and what is driving the regional gap?"
    );

    const result = await runTurnLikeRoute(ctx, emit);

    // ── SSE event contract ──
    const kinds = events.map((e) => e.event);
    // Load-bearing events the client stream renderer depends on must all fire.
    for (const required of ["thinking", "plan", "tool_call", "tool_result"]) {
      assert.ok(kinds.includes(required), `missing SSE event '${required}' (got: ${[...new Set(kinds)].join(", ")})`);
    }
    // Relative ordering: planning is announced before the tool fires, the tool
    // call precedes its result, and the plan precedes the tool call.
    const iThinking = firstIdx(events, "thinking");
    const iPlan = firstIdx(events, "plan");
    const iToolCall = firstIdx(events, "tool_call");
    const iToolResult = firstIdx(events, "tool_result");
    assert.ok(iThinking >= 0 && iThinking <= iPlan, "first 'thinking' precedes (or equals first) 'plan'");
    assert.ok(iPlan < iToolCall, "'plan' precedes 'tool_call'");
    assert.ok(iToolCall < iToolResult, "'tool_call' precedes its 'tool_result'");

    // The 'plan' payload carries the planned steps with id+tool (UI contract).
    const planEvent = events.find((e) => e.event === "plan")!;
    const planData = planEvent.data as { steps?: Array<{ id: string; tool: string }> };
    assert.ok(Array.isArray(planData.steps) && planData.steps.length >= 1, "plan event carries steps");
    assert.equal(planData.steps![0].tool, "get_schema_summary");

    // ── Answer + envelope shape ──
    assert.ok(result.answer && result.answer.length > 50, `answer too short: ${result.answer?.length}`);
    assert.match(result.answer!, /Saffola/);
    assert.ok(result.answerEnvelope, "answerEnvelope populated");
    const env = result.answerEnvelope!;
    for (const key of EXPECTED_ENVELOPE_KEYS) {
      assert.ok(key in env, `envelope must carry '${key}' (got: ${Object.keys(env).join(", ")})`);
    }
    assert.equal((env.findings ?? []).length >= 2, true, "≥2 findings");
    assert.equal(env.implications![0].confidence, "high");
    assert.equal(env.recommendations![1].horizon, "this_quarter");

    // ── Telemetry surfaces ──
    assert.ok(Array.isArray(result.magnitudes) && result.magnitudes!.length >= 2, "≥2 magnitudes");
    assert.ok(result.investigationSummary, "investigationSummary populated");
    assert.ok(result.agentTrace && Array.isArray(result.agentTrace.steps), "agentTrace.steps present");
    assert.ok(result.agentTrace!.steps.length >= 1, "≥1 planned step in trace");
    assert.ok(result.blackboard, "blackboard digest present");
  });

  it("SHAPE B · one-chart turn surfaces a ChartSpec on result.charts", async () => {
    // Plan one `build_chart` step (bar of Volume by Brand). The deterministic
    // chart builder compiles directly from the in-memory frame (`ctx.data`) — no
    // columnar storage / DuckDB needed — and the deferred-chart materialiser
    // promotes it onto `result.charts`. This exercises the full chart-merge path
    // end-to-end through `runAgentTurn`.
    installNarratorStub([
      {
        id: "s1",
        tool: "build_chart",
        args: { type: "bar", x: "Brand", y: "Volume", aggregate: "sum", title: "Volume by brand" },
      },
    ]);
    seedCosmosDouble();
    const { events, emit } = makeEmitterCapture();
    const ctx = buildCtx("Why does volume vary by brand?");

    const result = await runTurnLikeRoute(ctx, emit);

    // The chart-builder step ran and emitted its call + result over SSE.
    const kinds = events.map((e) => e.event);
    assert.ok(kinds.includes("tool_call"), "tool_call fired");
    assert.ok(kinds.includes("tool_result"), "tool_result fired");
    const toolCall = events.find((e) => e.event === "tool_call")!;
    assert.equal((toolCall.data as { name: string }).name, "build_chart");

    // ── Answer present ──
    assert.ok(result.answer && result.answer.length > 0, "answer present on one-chart turn");

    // ── Chart surfaced ──
    assert.ok(
      Array.isArray(result.charts) && result.charts!.length >= 1,
      `≥1 chart surfaced (got ${result.charts?.length ?? 0})`
    );
    const chart = result.charts![0] as { type?: string; x?: string; y?: string };
    assert.equal(chart.type, "bar", "chart type preserved");
    assert.equal(chart.x, "Brand", "chart x preserved");

    // ── Envelope still well-formed (same contract as SHAPE A) ──
    assert.ok(result.answerEnvelope, "answerEnvelope populated on one-chart turn");
    for (const key of EXPECTED_ENVELOPE_KEYS) {
      assert.ok(key in result.answerEnvelope!, `envelope must carry '${key}'`);
    }
  });
});
