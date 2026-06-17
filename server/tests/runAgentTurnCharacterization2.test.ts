/**
 * Findings ARCH-1 / CQ-1 · `runAgentTurn` characterization GATE — PART 2.
 *
 * Sibling to `runAgentTurnCharacterization.test.ts`. That file pins the SSE +
 * envelope contract for the two SIMPLEST full-turn shapes (a plain single-step
 * turn + a one-chart turn). This file WIDENS the safety net BEFORE the phase
 * extraction in `agentLoop.service.ts` by exercising the orchestrator's deeper
 * control-flow paths — the ones a phase split is most likely to disturb:
 *
 *   SHAPE C · MULTI-tool-step turn (2+ tool calls, no DuckDB needed). Pins that
 *     the per-step loop body fires once PER step, in plan order, emitting a
 *     matched tool_call → tool_result pair per step, and that artifacts from
 *     multiple steps still merge into one envelope + chart set. This is the
 *     direct gate for "extract the per-tool STEP EXECUTION body".
 *
 *   SHAPE D · SYNTHESIS completeness-REPAIR retry. The first narrator draft is
 *     missing required envelope sections (no implications / recommendations /
 *     domainLens) for an analytical questionShape, so the deterministic
 *     envelope-completeness gate (W17) MUST fire ≥1 repair round — observable as
 *     an `envelope-completeness` (or `envelope-multi-issue`) `flow_decision`
 *     SSE event — and the SECOND narrator draft (which is complete) MUST be the
 *     one that lands in the final envelope. This gates the SYNTHESIS phase.
 *
 *   SHAPE E · ABORTED turn (ctx.abortSignal already fired when the turn starts).
 *     The first `checkAbort("planner-loop")` boundary throws
 *     `AGENT_CLIENT_ABORTED`, which the orchestrator's outer catch maps to a
 *     clean abort envelope (answer "Request cancelled.", trace closed) instead
 *     of letting the throw escape. Pins: the turn still RETURNS (no throw
 *     escapes), it returns a non-empty answer, it does NOT emit a FINAL
 *     `critic_verdict` (synthesis + the post-synthesis verifier never ran), and
 *     it does NOT emit `dashboard_created`. This gates the abort early-return
 *     contract the extraction must preserve.
 *
 *     NOTE (characterized behaviour, not aspiration): the `checkAbort`
 *     boundary at `pre-visual-planner` is wrapped in the visual-planner
 *     try/catch, so an abort fired AFTER the narrator runs is swallowed as a
 *     `visual_planner_failed` and the turn proceeds. The boundary that actually
 *     PROPAGATES the abort to the early-return is the top-of-loop
 *     `checkAbort("planner-loop")` — which is what this shape exercises.
 *
 * Same harness as part 1: LLM stubbed (W18), tools run for real over the
 * in-memory fixture frame, the Cosmos double services the debounced checkpoint
 * so the gate stays in single-digit-second territory with no hang.
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

const SESSION_ID = "characterization2-session";
const USERNAME = "tester2@example.com";

// ── Fixture: Marico-shaped frame (same shape as part 1) ───────────
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
  id: "chat_characterization2",
  sessionId: SESSION_ID,
  dataSummary: summary,
  sessionAnalysisContext: sac,
};

/** Seed the Cosmos double so the post-turn checkpoint RMW resolves instantly. */
function seedCosmosDouble() {
  const handle = makeInMemoryContainer(
    [
      {
        id: "chat_characterization2",
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
  __resetSessionWriteChainForTesting();
  return handle;
}

/** Run a turn the way the chat-stream ROUTE does, then flush the checkpoint. */
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

/** A complete, decision-grade narrator envelope (passes the completeness gate). */
function richNarratorOutput() {
  return {
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
  };
}

const EXPECTED_ENVELOPE_KEYS = [
  "tldr",
  "findings",
  "methodology",
  "implications",
  "recommendations",
  "domainLens",
] as const;

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
  return ctx;
}

after(() => {
  clearLlmStub();
  __setContainerForTesting(null);
});

describe("runAgentTurn characterization · multi-step / synthesis-retry / abort", () => {
  before(() => {
    seedCosmosDouble();
  });

  it("SHAPE C · multi-tool-step turn fires the step body once per step, in order", async () => {
    // Three deterministic, DuckDB-free steps. The per-step loop must execute
    // each, emit a matched tool_call→tool_result pair PER step in plan order,
    // and still merge artifacts (the build_chart) into one envelope.
    installLlmStub({
      [LLM_PURPOSE.PLANNER]: () => ({
        rationale: "Inspect schema, correlate the metrics, then chart volume.",
        steps: [
          { id: "s1", tool: "get_schema_summary", args: {} },
          { id: "s2", tool: "run_correlation", args: { targetVariable: "Volume" } },
          {
            id: "s3",
            tool: "build_chart",
            args: { type: "bar", x: "Brand", y: "Volume", aggregate: "sum", title: "Volume by brand" },
          },
        ],
      }),
      [LLM_PURPOSE.NARRATOR]: () => richNarratorOutput(),
      [LLM_PURPOSE.VERIFIER_DEEP]: () => ({
        verdict: "pass",
        issues: [],
        course_correction: "pass",
        scores: { goal_alignment: 0.9, evidence_consistency: 0.9, completeness: 0.9 },
      }),
      [LLM_PURPOSE.VISUAL_PLANNER]: () => ({ addCharts: [] }),
      [LLM_PURPOSE.REFLECTOR]: () => ({ action: "continue", reasoning: "fixture" }),
    });
    seedCosmosDouble();
    const { events, emit } = makeEmitterCapture();
    const ctx = buildCtx(
      "Why does Saffola lead volume, and how do Volume and Value relate by brand?"
    );

    const result = await runTurnLikeRoute(ctx, emit);

    // ── Per-step loop fired once per step, in plan order ──
    const toolCalls = events.filter((e) => e.event === "tool_call");
    const toolResults = events.filter((e) => e.event === "tool_result");
    assert.ok(toolCalls.length >= 3, `≥3 tool_call events (got ${toolCalls.length})`);
    assert.equal(
      toolResults.length,
      toolCalls.length,
      "every tool_call has a matching tool_result"
    );
    const calledTools = toolCalls.map((e) => (e.data as { name: string }).name);
    // Plan order is preserved across the loop.
    assert.deepEqual(
      calledTools.slice(0, 3),
      ["get_schema_summary", "run_correlation", "build_chart"],
      "steps executed in plan order"
    );

    // Each tool_call id precedes its own tool_result id (matched pairing).
    for (const tc of toolCalls) {
      const id = (tc.data as { id: string }).id;
      const callIdx = events.indexOf(tc);
      const resIdx = events.findIndex(
        (e, i) => i > callIdx && e.event === "tool_result" && (e.data as { id: string }).id === id
      );
      assert.ok(resIdx > callIdx, `tool_result for ${id} follows its tool_call`);
    }

    // The trace recorded ≥3 tool calls.
    assert.ok(result.agentTrace, "agentTrace present");
    assert.ok(
      result.agentTrace!.toolCalls.length >= 3,
      `trace has ≥3 tool calls (got ${result.agentTrace!.toolCalls.length})`
    );

    // ── Artifacts from multiple steps merged into one envelope + chart set ──
    assert.ok(result.answer && result.answer.length > 50, "rich answer present");
    assert.match(result.answer!, /Saffola/);
    assert.ok(result.answerEnvelope, "answerEnvelope populated");
    for (const key of EXPECTED_ENVELOPE_KEYS) {
      assert.ok(key in result.answerEnvelope!, `envelope must carry '${key}'`);
    }
    // The build_chart step's output rode through the merge path.
    assert.ok(
      Array.isArray(result.charts) && result.charts!.length >= 1,
      `≥1 chart surfaced from the multi-step turn (got ${result.charts?.length ?? 0})`
    );
  });

  it("SHAPE D · an incomplete first draft triggers a synthesis completeness-repair round", async () => {
    // The narrator's FIRST draft omits implications/recommendations/domainLens —
    // mandatory for an analytical questionShape. The deterministic W17
    // completeness gate must fire ≥1 repair round (observable as an
    // `envelope-*` flow_decision) and the SECOND, complete draft must win.
    let narratorCall = 0;
    installLlmStub({
      [LLM_PURPOSE.PLANNER]: () => ({
        rationale: "Inspect schema, then synthesise.",
        steps: [{ id: "s1", tool: "get_schema_summary", args: {} }],
      }),
      [LLM_PURPOSE.NARRATOR]: () => {
        narratorCall++;
        if (narratorCall === 1) {
          // Deliberately incomplete: a body + tldr + findings but NO
          // implications, recommendations, or domainLens.
          return {
            body:
              "Saffola leads brand volume across the portfolio, with the South region carrying most of the lift.",
            keyInsight: "Saffola is the volume leader.",
            ctas: [],
            tldr: "Saffola leads volume.",
            findings: [
              { headline: "Saffola tops volume", evidence: "Brand aggregation" },
              { headline: "South leads regions", evidence: "Region aggregation" },
            ],
            methodology: "Aggregated brand × region for Volume.",
            caveats: ["Single-period snapshot"],
          };
        }
        // Repair draft: complete + decision-grade.
        return richNarratorOutput();
      },
      [LLM_PURPOSE.VERIFIER_DEEP]: () => ({
        verdict: "pass",
        issues: [],
        course_correction: "pass",
        scores: { goal_alignment: 0.9, evidence_consistency: 0.9, completeness: 0.9 },
      }),
      [LLM_PURPOSE.VISUAL_PLANNER]: () => ({ addCharts: [] }),
      [LLM_PURPOSE.REFLECTOR]: () => ({ action: "finish", reasoning: "fixture" }),
    });
    seedCosmosDouble();
    const { events, emit } = makeEmitterCapture();
    const ctx = buildCtx(
      "Why does Saffola lead volume, and what is driving the regional gap?"
    );

    const result = await runTurnLikeRoute(ctx, emit);

    // ── The completeness gate fired a repair round ──
    assert.ok(narratorCall >= 2, `narrator called ≥2× (repair round ran); got ${narratorCall}`);
    const repairDecision = events.find(
      (e) =>
        e.event === "flow_decision" &&
        typeof (e.data as { layer?: string }).layer === "string" &&
        (e.data as { layer: string }).layer.startsWith("envelope")
    );
    assert.ok(
      repairDecision,
      `expected an 'envelope-*' repair flow_decision (got layers: ${events
        .filter((e) => e.event === "flow_decision")
        .map((e) => (e.data as { layer?: string }).layer)
        .join(", ")})`
    );

    // ── The repaired (complete) draft is the one that landed ──
    assert.ok(result.answerEnvelope, "answerEnvelope populated after repair");
    for (const key of EXPECTED_ENVELOPE_KEYS) {
      assert.ok(key in result.answerEnvelope!, `repaired envelope must carry '${key}'`);
    }
    assert.ok(
      (result.answerEnvelope!.implications ?? []).length >= 2,
      "repaired envelope carries implications"
    );
    assert.ok(
      (result.answerEnvelope!.recommendations ?? []).length >= 1,
      "repaired envelope carries recommendations"
    );
    assert.match(result.answerEnvelope!.domainLens ?? "", /marico-foods-edible-oils-portfolio/);
  });

  it("SHAPE E · an aborted turn returns a clean abort envelope and skips synthesis + the final verifier", async () => {
    // The abort signal is ALREADY fired when the turn starts, so the first
    // `checkAbort("planner-loop")` boundary throws AGENT_CLIENT_ABORTED;
    // runAgentTurn's outer catch maps it to a clean abort early-return.
    const ctrl = new AbortController();
    ctrl.abort();
    installLlmStub({
      [LLM_PURPOSE.PLANNER]: () => ({
        rationale: "Inspect schema, then synthesise.",
        steps: [{ id: "s1", tool: "get_schema_summary", args: {} }],
      }),
      [LLM_PURPOSE.NARRATOR]: () => richNarratorOutput(),
      [LLM_PURPOSE.VERIFIER_DEEP]: () => ({
        verdict: "pass",
        issues: [],
        course_correction: "pass",
        scores: { goal_alignment: 0.9, evidence_consistency: 0.9, completeness: 0.9 },
      }),
      [LLM_PURPOSE.VISUAL_PLANNER]: () => ({ addCharts: [] }),
      [LLM_PURPOSE.REFLECTOR]: () => ({ action: "finish", reasoning: "fixture" }),
    });
    seedCosmosDouble();
    const { events, emit } = makeEmitterCapture();
    const ctx = buildCtx("Why does Saffola lead volume?");
    ctx.abortSignal = ctrl.signal;

    // The turn must RESOLVE (the abort is caught + mapped — it never escapes).
    const result = await runTurnLikeRoute(ctx, emit);

    // ── A non-empty answer comes back (the abort envelope) ──
    assert.ok(typeof result.answer === "string", "answer is a string");
    assert.ok(result.answer!.length > 0, "abort returns a non-empty answer");
    assert.equal(result.answer, "Request cancelled.", "clean abort message, no observations");
    assert.ok(result.agentTrace, "agentTrace present on abort");

    // ── The plan-loop never executed a tool (abort cut in at the first boundary) ──
    assert.equal(firstIdx(events, "tool_call"), -1, "no tool_call on an up-front abort");

    // ── No FINAL verifier verdict and no synthesis 'answer_chunk' (both skipped) ──
    const finalVerdict = events.find(
      (e) => e.event === "critic_verdict" && (e.data as { stepId?: string }).stepId === "final"
    );
    assert.equal(finalVerdict, undefined, "no FINAL critic_verdict on an aborted turn");

    // ── The turn does NOT emit a dashboard_created (synthesis never ran) ──
    assert.equal(
      firstIdx(events, "dashboard_created"),
      -1,
      "no dashboard_created on an aborted turn"
    );
  });
});
