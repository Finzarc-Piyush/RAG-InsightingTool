/**
 * Wave W24 · multi-turn E2E — proves W21 cross-turn carry-over
 *
 * W20 covers a single turn end-to-end. This test runs TWO consecutive
 * `runAgentTurn` calls and asserts that turn 2's planner prompt actually
 * receives the labelled `PRIOR_INVESTIGATIONS` block built from turn 1.
 *
 * No Cosmos: between turns we apply the W21 helpers in-process
 * (`buildPriorInvestigationDigest` + `appendPriorInvestigation`) — exactly
 * what `persistMergeAssistantSessionContext` does, sans I/O. This keeps the
 * test deterministic and CI-friendly.
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
  "../lib/agents/runtime/types.js"
);
const { LLM_PURPOSE } = await import(
  "../lib/agents/runtime/llmCallPurpose.js"
);
const { installLlmStub, clearLlmStub } = await import(
  "./helpers/llmStub.js"
);
const {
  buildPriorInvestigationDigest,
  appendPriorInvestigation,
} = await import("../lib/agents/runtime/priorInvestigations.js");

after(() => clearLlmStub());

// ── Tiny fixture (just enough for the two-turn flow) ──────────────────
const summary: DataSummary = {
  rowCount: 24,
  columnCount: 5,
  columns: [
    { name: "Brand", type: "string", sampleValues: ["Saffola", "Parachute"] },
    { name: "Region", type: "string", sampleValues: ["South", "East"] },
    { name: "Channel", type: "string", sampleValues: ["MT", "GT"] },
    { name: "Month", type: "date", sampleValues: ["2024-07"] },
    { name: "Volume_MT", type: "number", sampleValues: [120, 240] },
  ],
  numericColumns: ["Volume_MT"],
  dateColumns: ["Month"],
};

const fixtureData: Record<string, any>[] = (() => {
  const out: Record<string, any>[] = [];
  let s = 1;
  for (const b of ["Saffola", "Parachute"]) {
    for (const r of ["South", "East"]) {
      for (const c of ["MT", "GT"]) {
        for (const m of ["2024-07", "2024-08", "2024-09"]) {
          out.push({ Brand: b, Region: r, Channel: c, Month: m, Volume_MT: 100 + (s * 5) % 200 });
          s++;
        }
      }
    }
  }
  return out;
})();

const baseSac = (): SessionAnalysisContext => ({
  version: 1,
  dataset: {
    shortDescription: "Marico monthly brand-region-channel volume tracker.",
    columnRoles: [],
    caveats: [],
  },
  userIntent: { interpretedConstraints: [] },
  sessionKnowledge: { facts: [], analysesDone: [] },
  suggestedFollowUps: [],
  lastUpdated: { reason: "seed", at: new Date().toISOString() },
});

const chatDocument: Partial<ChatDocument> = {
  id: "fixture-mt",
  sessionId: "fixture-mt",
  dataSummary: summary,
};

const T1_QUESTION = "Why did Saffola lose share in MT in Q3?";
const T2_QUESTION = "How does that compare with Parachute's MT trajectory?";

// Capture turn 2's planner user prompt by installing a planner stub that
// records `params.messages[user].content` before returning a valid plan.
let plannerPromptT2 = "";

before(() => {
  installLlmStub({
    [LLM_PURPOSE.PLANNER]: (params) => {
      const userMsg = params.messages.find((m) => m.role === "user");
      if (userMsg && typeof userMsg.content === "string") {
        // Always overwrite so we get the LATEST turn's prompt; turn 1 will be
        // captured first then overwritten by turn 2 (which is what we assert).
        plannerPromptT2 = userMsg.content;
      }
      return {
        rationale: "Use get_schema_summary to confirm shape, then synthesise.",
        steps: [{ id: "s1", tool: "get_schema_summary", args: {} }],
      };
    },
    [LLM_PURPOSE.HYPOTHESIS]: () => ({
      hypotheses: [
        { text: "Saffola lost MT-channel volume due to pack-mix shift", targetColumn: "Volume_MT" },
        { text: "South-region distribution gap explains the dip", targetColumn: "Volume_MT" },
        { text: "Festive timing shift caused the drop", targetColumn: "Month" },
      ],
    }),
    [LLM_PURPOSE.NARRATOR]: () => ({
      body: "Saffola lost MT share in Q3, concentrated in the South region, driven by pack-mix shift toward 1L SKUs.",
      keyInsight: "South-MT share loss is brand-specific, not category-wide.",
      ctas: [],
      tldr: "Saffola lost MT share — concentrated in South 1L SKUs.",
      findings: [
        { headline: "South-MT volume −8% MoM", evidence: "Q3 aggregation", magnitude: "-8%" },
      ],
      methodology: "Aggregated by Brand × Region × Channel for Q3.",
      caveats: ["MT-only"],
      implications: [
        { statement: "Drop is brand-specific.", soWhat: "Likely a price/pack response, not category softness.", confidence: "high" },
        { statement: "1L SKU mix loss compounds it.", soWhat: "Margin-per-unit is slipping.", confidence: "medium" },
      ],
      recommendations: [
        { action: "Review MT pack-size mix vs private label", rationale: "1L SKUs overlap top private-label price points", horizon: "this_quarter" },
        { action: "Tighten promo-depth rules in MT", rationale: "Promo elasticity slipped 12%", horizon: "now" },
      ],
      domainLens: "Per `marico-foods-edible-oils-portfolio`, Saffola is the flagship.",
      magnitudes: [
        { label: "South-MT volume drop", value: "-8% MoM", confidence: "high" },
      ],
    }),
    [LLM_PURPOSE.VERIFIER_DEEP]: () => ({
      verdict: "pass",
      issues: [],
      course_correction: "pass",
    }),
    [LLM_PURPOSE.VISUAL_PLANNER]: () => ({ addCharts: [] }),
  });
});

describe("W24 · multi-turn carry-over: turn 2's planner sees turn 1's investigation", () => {
  it("turn 1 produces an investigation summary, turn 2's planner prompt cites it verbatim", async () => {
    const config = loadAgentConfigFromEnv();

    // ── Turn 1 ──
    const ctx1 = buildAgentExecutionContext({
      sessionId: "fixture-mt",
      username: "tester@example.com",
      question: T1_QUESTION,
      data: fixtureData,
      summary,
      chatHistory: [],
      mode: "analysis",
      domainContext:
        "<<DOMAIN PACK: marico-foods-edible-oils-portfolio>>\n# Marico Foods\nSaffola is the flagship.\n<</DOMAIN PACK>>",
      sessionAnalysisContext: baseSac(),
      chatDocument: chatDocument as ChatDocument,
    });
    ctx1.analysisBrief = {
      questionShape: "driver_discovery",
      outcomeMetricColumn: "Volume_MT",
      segmentationDimensions: ["Brand", "Region", "Channel"],
      candidateDriverDimensions: ["Brand", "Region", "Channel"],
      epistemicNotes: "Observational; avoid causal claims.",
      filters: [],
      requestsDashboard: false,
      clarifyingQuestions: [],
    };

    const r1 = await runAgentTurn(ctx1, config);
    assert.ok(r1.investigationSummary, "turn 1 must produce investigation summary");
    assert.ok((r1.investigationSummary?.hypotheses?.length ?? 0) >= 1);

    // ── Cross-turn digest (in-process equivalent of persistMergeAssistantSessionContext) ──
    const digest = buildPriorInvestigationDigest(T1_QUESTION, r1.investigationSummary);
    assert.ok(digest, "digest must be built from turn-1 summary");
    assert.match(digest!.question, /Saffola lose share in MT/);
    const sac2 = appendPriorInvestigation(ctx1.sessionAnalysisContext!, digest!);
    assert.equal(sac2.sessionKnowledge.priorInvestigations?.length, 1);

    // ── Turn 2 ──
    plannerPromptT2 = ""; // reset capture
    const ctx2 = buildAgentExecutionContext({
      sessionId: "fixture-mt",
      username: "tester@example.com",
      question: T2_QUESTION,
      data: fixtureData,
      summary,
      chatHistory: [],
      mode: "analysis",
      domainContext: ctx1.domainContext,
      sessionAnalysisContext: sac2,
      chatDocument: chatDocument as ChatDocument,
    });
    ctx2.analysisBrief = ctx1.analysisBrief;

    const r2 = await runAgentTurn(ctx2, config);
    assert.ok(r2.answer && r2.answer.length > 0);

    // ── The contract under test ──
    // Turn 2's planner prompt must include the labelled block AND the
    // turn-1 question + at least one hypothesis text. This is what makes
    // the agent feel like it remembers across turns.
    assert.match(plannerPromptT2, /PRIOR_INVESTIGATIONS/, "block label must be present");
    assert.match(plannerPromptT2, /Why did Saffola lose share in MT in Q3\?/, "turn-1 question echoed");
    assert.match(plannerPromptT2, /Saffola lost MT-channel volume|pack-mix shift|distribution gap|festive timing/i, "at least one turn-1 hypothesis text echoed");
  });
});
