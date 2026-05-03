/**
 * Wave WHD1 · domain-aware hypothesis planning.
 *
 * Pins that both the legacy `generateHypotheses` and the merged W39
 * `runHypothesisAndBriefMerged` paths inject `ctx.domainContext` into the
 * user prompt when present, and skip the block cleanly when it's absent
 * (no empty-block leak). Mirrors the W12 chart-commentary convention in
 * `insightGenerator.ts` so future readers recognise the pattern.
 *
 * The LLM is stubbed; we capture the request `params` per call and read
 * the user message verbatim. Pack-id citation behavior of the LLM itself
 * is out of scope (covered by manual smoke testing).
 */
import assert from "node:assert/strict";
import { describe, it, after, beforeEach } from "node:test";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import type { DataSummary } from "../shared/schema.js";
import type { AgentExecutionContext } from "../lib/agents/runtime/types.js";

process.env.AZURE_OPENAI_API_KEY ??= "test";
process.env.AZURE_OPENAI_ENDPOINT ??= "https://test.openai.azure.com";
process.env.AZURE_OPENAI_DEPLOYMENT_NAME ??= "test-deployment";

const { generateHypotheses } = await import(
  "../lib/agents/runtime/hypothesisPlanner.js"
);
const { runHypothesisAndBriefMerged } = await import(
  "../lib/agents/runtime/runHypothesisAndBrief.js"
);
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

const SAMPLE_DOMAIN_CONTEXT = `<<DOMAIN PACK: marico-haircare-portfolio>>
# Marico Haircare Portfolio

Marico's haircare portfolio spans the full price-point ladder from mass-market
pure coconut oil to premium leave-in serums. Parachute (Rigid Pack) is the
bedrock — pure coconut oil, mass-market, deeply rural. Nihar and Advansed
sit mid-tier; Livon and Mediker are premium.

<<DOMAIN PACK: seasonality-and-festivals>>
Hair-oil consumption peaks in winter and dips during monsoon (July–September).`;

const ctx = (overrides: Partial<AgentExecutionContext> = {}): AgentExecutionContext =>
  ({
    sessionId: "s1",
    question: "Why did Parachute volumes fall in Q3?",
    data: [],
    summary,
    chatHistory: [],
    mode: "analysis",
    ...overrides,
  } as unknown as AgentExecutionContext);

function captureUserMessage(): {
  capture: () => string;
  handler: (p: ChatCompletionCreateParamsNonStreaming) => unknown;
} {
  let captured = "";
  return {
    capture: () => captured,
    handler: (params: ChatCompletionCreateParamsNonStreaming) => {
      const userMsg = params.messages.find((m) => m.role === "user");
      const content = userMsg?.content;
      captured = typeof content === "string" ? content : JSON.stringify(content);
      return {
        hypotheses: [{ text: "Stub hypothesis", targetColumn: undefined }],
      };
    },
  };
}

describe("WHD1 · generateHypotheses — domain context injection", () => {
  it("includes the FMCG / MARICO DOMAIN CONTEXT block in the user prompt when ctx.domainContext is set", async () => {
    const { capture, handler } = captureUserMessage();
    installLlmStub({ [LLM_PURPOSE.HYPOTHESIS]: handler });
    const bb = createBlackboard();
    await generateHypotheses(
      ctx({ domainContext: SAMPLE_DOMAIN_CONTEXT }),
      bb,
      "t-domain-on",
      () => {}
    );
    const userMsg = capture();
    assert.match(
      userMsg,
      /FMCG \/ MARICO DOMAIN CONTEXT \(background only — never numeric evidence; cite pack id when used\):/,
      "user prompt should contain the labelled domain context block"
    );
    assert.match(
      userMsg,
      /marico-haircare-portfolio/,
      "user prompt should preserve the pack id verbatim so the LLM can cite it"
    );
    assert.match(
      userMsg,
      /seasonality-and-festivals/,
      "user prompt should preserve secondary pack ids too"
    );
  });

  it("omits the domain block entirely when ctx.domainContext is undefined (no empty-block leak)", async () => {
    const { capture, handler } = captureUserMessage();
    installLlmStub({ [LLM_PURPOSE.HYPOTHESIS]: handler });
    const bb = createBlackboard();
    await generateHypotheses(ctx(), bb, "t-domain-off", () => {});
    const userMsg = capture();
    assert.doesNotMatch(
      userMsg,
      /FMCG \/ MARICO DOMAIN CONTEXT/,
      "no domain block when ctx.domainContext is undefined"
    );
  });

  it("omits the domain block when ctx.domainContext is empty/whitespace-only", async () => {
    const { capture, handler } = captureUserMessage();
    installLlmStub({ [LLM_PURPOSE.HYPOTHESIS]: handler });
    const bb = createBlackboard();
    await generateHypotheses(
      ctx({ domainContext: "   \n  \n " }),
      bb,
      "t-domain-blank",
      () => {}
    );
    assert.doesNotMatch(capture(), /FMCG \/ MARICO DOMAIN CONTEXT/);
  });

  it("caps the domain context at ~2.5k chars (cost guard)", async () => {
    const { capture, handler } = captureUserMessage();
    installLlmStub({ [LLM_PURPOSE.HYPOTHESIS]: handler });
    const huge = "X".repeat(10_000);
    const bb = createBlackboard();
    await generateHypotheses(
      ctx({ domainContext: huge }),
      bb,
      "t-domain-cap",
      () => {}
    );
    const userMsg = capture();
    const xRun = userMsg.match(/X+/g)?.find((s) => s.length > 100);
    assert.ok(xRun, "expected a long X run from the stubbed huge domain context");
    // WTL2 · cap bumped 2_500 → 4_000 to match the merged W39 path.
    assert.ok(
      xRun!.length <= 4000,
      `domain block should be capped at 4000 chars; got ${xRun!.length}`
    );
  });
});

describe("WHD1 · runHypothesisAndBriefMerged — domain context injection (W39 path)", () => {
  it("includes the FMCG / MARICO DOMAIN CONTEXT block in the user prompt when ctx.domainContext is set", async () => {
    process.env.MERGED_PRE_PLANNER = "true";
    const { capture, handler: capturingHandler } = captureUserMessage();
    installLlmStub({
      [LLM_PURPOSE.HYPOTHESIS]: (params) => {
        capturingHandler(params);
        return {
          hypotheses: [{ text: "Stub hypothesis", targetColumn: undefined }],
          brief: null,
        };
      },
    });
    const bb = createBlackboard();
    await runHypothesisAndBriefMerged(
      ctx({ domainContext: SAMPLE_DOMAIN_CONTEXT }),
      bb,
      "t-merged-domain-on",
      () => {},
      false
    );
    delete process.env.MERGED_PRE_PLANNER;
    const userMsg = capture();
    assert.match(userMsg, /FMCG \/ MARICO DOMAIN CONTEXT/);
    assert.match(userMsg, /marico-haircare-portfolio/);
  });

  it("omits the domain block entirely when ctx.domainContext is undefined", async () => {
    process.env.MERGED_PRE_PLANNER = "true";
    const { capture, handler: capturingHandler } = captureUserMessage();
    installLlmStub({
      [LLM_PURPOSE.HYPOTHESIS]: (params) => {
        capturingHandler(params);
        return {
          hypotheses: [{ text: "Stub hypothesis", targetColumn: undefined }],
          brief: null,
        };
      },
    });
    const bb = createBlackboard();
    await runHypothesisAndBriefMerged(ctx(), bb, "t-merged-domain-off", () => {}, false);
    delete process.env.MERGED_PRE_PLANNER;
    assert.doesNotMatch(capture(), /FMCG \/ MARICO DOMAIN CONTEXT/);
  });
});
