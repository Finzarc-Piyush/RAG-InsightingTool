import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";

// Stub Azure env BEFORE the dynamic import chain (insightGenerator → callLlm →
// openai) so module load doesn't crash. The LLM call is short-circuited by the
// stub resolver below — no network.
process.env.AZURE_OPENAI_API_KEY ??= "test";
process.env.AZURE_OPENAI_ENDPOINT ??= "https://test.openai.azure.com";
process.env.AZURE_OPENAI_DEPLOYMENT_NAME ??= "test-deployment";

const { generateChartInsights } = await import("../lib/insightGenerator.js");
const { __setLlmStubResolver } = await import(
  "../lib/agents/runtime/callLlm.js"
);

/**
 * Wave · channel-aware chart insights. The per-chart insight prompt must
 *   (a) carry a deterministic anti-pattern that bans cloning one channel's
 *       playbook onto a structurally different channel, and
 *   (b) inject the authored FMCG/Marico domain knowledge (previously plumbed
 *       but unused) so the model is grounded in channel semantics.
 * Both are prompt-level; we capture the prompt via the test-only stub resolver.
 */
describe("generateChartInsights · channel-aware guardrails", () => {
  afterEach(() => __setLlmStubResolver(null));

  it("bans cross-channel playbook cloning and injects the domain block", async () => {
    let capturedSystem = "";
    let capturedUser = "";
    __setLlmStubResolver((params: any) => {
      const msgs = params.messages ?? [];
      capturedSystem = String(msgs.find((m: any) => m.role === "system")?.content ?? "");
      capturedUser = String(msgs.find((m: any) => m.role === "user")?.content ?? "");
      return {
        choices: [
          { message: { content: JSON.stringify({ keyInsight: "**GT** leads total_NR at **655 Cr**." }) } },
        ],
      } as any;
    });

    const chartSpec: any = {
      type: "bar",
      title: "total_NR by Channel",
      x: "Channel",
      y: "total_NR",
    };
    const chartData = [
      { Channel: "GT", total_NR: 6_550_000_000 },
      { Channel: "MT", total_NR: 2_780_000_000 },
      { Channel: "CSD", total_NR: 1_160_000_000 },
    ];

    await generateChartInsights(chartSpec, chartData, {} as any, undefined, {
      domainContext:
        "<<DOMAIN PACK: fmcg-distribution-channels-india>> Channel is the single most important secondary dimension; GT/MT/CSD/e-commerce behave differently. <</DOMAIN PACK>>",
    });

    // (a) deterministic anti-pattern present in the system prompt
    assert.match(capturedSystem, /General Trade \(GT\), Modern Trade \(MT\)/);
    assert.match(capturedSystem, /do NOT transfer/);
    // (b) domain knowledge injected into the user prompt
    assert.match(capturedUser, /DOMAIN KNOWLEDGE \(FMCG \/ Marico/);
    assert.match(capturedUser, /fmcg-distribution-channels-india/);
  });

  it("the deterministic DO-lane safety net never emits cross-channel cloning advice", async () => {
    const { buildDeterministicDoLane } = await import("../lib/insightGenerator.js");
    const lane = buildDeterministicDoLane({ topLabel: "GT", bottomLabel: "MT" });
    assert.doesNotMatch(lane, /copy|replicate|clone|playbook/i);
  });
});
