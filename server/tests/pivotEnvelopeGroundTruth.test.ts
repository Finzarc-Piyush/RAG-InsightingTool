import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

process.env.AZURE_OPENAI_API_KEY ??= "test";
process.env.AZURE_OPENAI_ENDPOINT ??= "https://test.openai.azure.com";
process.env.AZURE_OPENAI_DEPLOYMENT_NAME ??= "test-deployment";

const { generatePivotEnvelope } = await import(
  "../lib/insightGenerator/pivotEnvelope.js"
);
const { installLlmStub, clearLlmStub } = await import("./helpers/llmStub.js");
const { LLM_PURPOSE } = await import(
  "../lib/agents/runtime/llmCallPurpose.js"
);
import type { IntentEnvelope } from "../lib/agents/runtime/types.js";

const formatY = (n: number): string => {
  if (!isFinite(n)) return String(n);
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
};

const chartData = [
  { Region: "West", Sales: 600 },
  { Region: "East", Sales: 200 },
  { Region: "North", Sales: 100 },
];
const chartSpec = {
  type: "bar" as const,
  x: "Region",
  y: "Sales",
  title: "Sales by Region",
};

function captureUserPrompt(): {
  capture: { value: string };
  handler: (params: any) => unknown;
} {
  const capture = { value: "" };
  const handler = (params: any) => {
    const userMsg = params?.messages?.find((m: any) => m.role === "user");
    capture.value = typeof userMsg?.content === "string" ? userMsg.content : "";
    return {
      findings: [
        {
          headline: "stub finding",
          evidence: "stub evidence with West 600",
        },
      ],
      implications: [{ statement: "stub statement", soWhat: "stub soWhat" }],
      recommendations: [
        { action: "stub action", rationale: "stub rationale" },
      ],
    };
  };
  return { capture, handler };
}

describe("RD4 · generatePivotEnvelope — GROUND TRUTH block", () => {
  afterEach(() => clearLlmStub());

  it("appends GROUND TRUTH section when intentEnvelope has exclusions", async () => {
    const { capture, handler } = captureUserPrompt();
    installLlmStub({ [LLM_PURPOSE.INSIGHT_GEN]: handler });

    const intentEnvelope: IntentEnvelope = {
      exclusions: [
        {
          column: "Region",
          values: ["West"],
          source: "user-negative",
        },
      ],
    };
    await generatePivotEnvelope({
      chartSpec,
      chartData,
      formatY,
      intentEnvelope,
    });

    assert.match(capture.value, /GROUND TRUTH \(user intent\)/);
    assert.match(capture.value, /Region: "West"/);
    assert.match(capture.value, /MUST treat these as out of scope/);
  });

  it("multiple exclusions across columns all appear in the GROUND TRUTH block", async () => {
    const { capture, handler } = captureUserPrompt();
    installLlmStub({ [LLM_PURPOSE.INSIGHT_GEN]: handler });

    const intentEnvelope: IntentEnvelope = {
      exclusions: [
        {
          column: "Region",
          values: ["West", "South"],
          source: "user-negative",
        },
        {
          column: "Products",
          values: ["FEMALE SHOWER GEL"],
          source: "rollup-peer-mode",
        },
      ],
    };
    await generatePivotEnvelope({
      chartSpec,
      chartData,
      formatY,
      intentEnvelope,
    });

    assert.match(capture.value, /Region: "West", "South"/);
    assert.match(capture.value, /Products: "FEMALE SHOWER GEL"/);
  });

  it("omits GROUND TRUTH section when intentEnvelope is undefined (prompt cache safety)", async () => {
    const { capture, handler } = captureUserPrompt();
    installLlmStub({ [LLM_PURPOSE.INSIGHT_GEN]: handler });

    await generatePivotEnvelope({
      chartSpec,
      chartData,
      formatY,
    });

    assert.equal(
      /GROUND TRUTH \(user intent\)/.test(capture.value),
      false,
      "GROUND TRUTH section must not appear when no exclusions"
    );
  });

  it("omits GROUND TRUTH section when intentEnvelope has empty exclusions array", async () => {
    const { capture, handler } = captureUserPrompt();
    installLlmStub({ [LLM_PURPOSE.INSIGHT_GEN]: handler });

    await generatePivotEnvelope({
      chartSpec,
      chartData,
      formatY,
      intentEnvelope: { exclusions: [] },
    });

    assert.equal(
      /GROUND TRUTH \(user intent\)/.test(capture.value),
      false
    );
  });

  it("GROUND TRUTH block appears AFTER the PIVOT PATTERNS block (cache boundary preserved)", async () => {
    const { capture, handler } = captureUserPrompt();
    installLlmStub({ [LLM_PURPOSE.INSIGHT_GEN]: handler });

    const intentEnvelope: IntentEnvelope = {
      exclusions: [
        { column: "Region", values: ["West"], source: "user-negative" },
      ],
    };
    await generatePivotEnvelope({
      chartSpec,
      chartData,
      formatY,
      intentEnvelope,
    });

    const patternsIdx = capture.value.indexOf("PIVOT PATTERNS");
    const groundTruthIdx = capture.value.indexOf("GROUND TRUTH (user intent)");
    assert.ok(patternsIdx >= 0, "expected PIVOT PATTERNS section");
    assert.ok(groundTruthIdx >= 0, "expected GROUND TRUTH section");
    assert.ok(
      groundTruthIdx > patternsIdx,
      "GROUND TRUTH must come AFTER PIVOT PATTERNS to preserve cache prefix"
    );
  });
});
