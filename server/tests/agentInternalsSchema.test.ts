/**
 * Wave A1 · `agentInternals` round-trip contract on `messageSchema`.
 *
 * Pins the byte-cap shapes so a single rich turn can't blow the Cosmos 2 MB
 * doc limit, and confirms back-compat (legacy messages without the field).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.AZURE_OPENAI_API_KEY ??= "test";
process.env.AZURE_OPENAI_ENDPOINT ??= "https://test.openai.azure.com";
process.env.AZURE_OPENAI_DEPLOYMENT_NAME ??= "test-deployment";

const { agentInternalsSchema, messageSchema } = await import(
  "../shared/schema.js"
);

describe("agentInternalsSchema · contract", () => {
  it("accepts a fully populated internals payload", () => {
    const parsed = agentInternalsSchema.safeParse({
      schemaVersion: 1,
      workingMemory: [
        {
          callId: "c1",
          tool: "execute_query_plan",
          ok: true,
          summaryPreview: "ran groupby region → 4 rows",
          suggestedColumns: ["Region", "Total_Sales"],
          slots: { lastFilter: "Region in [South]" },
        },
      ],
      reflectorVerdicts: [
        {
          stepIndex: 0,
          action: "continue",
          rationale: "more breakdown needed",
        },
      ],
      verifierVerdicts: [
        {
          stepIndex: 0,
          verdict: "pass",
          rationale: "magnitudes consistent with observation",
        },
      ],
      blackboardSnapshot: {
        hypotheses: [
          {
            id: "h1",
            text: "Saffola fell because of MT volume drop",
            status: "partial",
            evidenceFindingIds: ["f1"],
          },
        ],
        findings: [
          {
            id: "f1",
            sourceRef: "step-1",
            label: "execute_query_plan: groupby region",
            detail: "South-MT volume −8% MoM",
            significance: "anomalous",
            relatedColumns: ["Region", "Channel", "Volume"],
            hypothesisId: "h1",
            confidence: "high",
          },
        ],
        openQuestions: [
          { id: "q1", text: "What about North?", priority: "medium" },
        ],
        domainContext: [
          {
            id: "rc1",
            text: "Marico haircare brand glossary excerpt",
            sourceRound: "rag_round1",
          },
        ],
      },
      toolIO: [
        {
          stepId: "s-1",
          tool: "execute_query_plan",
          ok: true,
          argsJson: '{"groupBy":["Region"],"aggregations":[{"col":"Sales","op":"sum"}]}',
          resultSummary: "4 rows · sum_Sales by Region",
          resultPayload: '[{"Region":"South","sum_Sales":10}]',
          analyticalMeta: { inputRowCount: 1000, outputRowCount: 4, appliedAggregation: true },
          durationMs: 42,
        },
      ],
      budgetBytes: 6000,
    });
    assert.equal(parsed.success, true);
  });

  it("rejects schemaVersion ≠ 1", () => {
    const bad = agentInternalsSchema.safeParse({ schemaVersion: 2 });
    assert.equal(bad.success, false);
  });

  it("rejects oversized fields", () => {
    const bad = agentInternalsSchema.safeParse({
      schemaVersion: 1,
      workingMemory: [
        {
          callId: "c1",
          tool: "x",
          ok: true,
          summaryPreview: "x".repeat(801), // cap is 800
        },
      ],
    });
    assert.equal(bad.success, false);
  });

  it("messageSchema accepts assistant message carrying agentInternals", () => {
    const parsed = messageSchema.safeParse({
      role: "assistant",
      content: "ok",
      timestamp: 1,
      agentInternals: {
        schemaVersion: 1,
        workingMemory: [
          { callId: "c1", tool: "t", ok: true, summaryPreview: "ok" },
        ],
      },
    });
    assert.equal(parsed.success, true);
  });

  it("messageSchema accepts assistant message WITHOUT agentInternals (back-compat)", () => {
    const parsed = messageSchema.safeParse({
      role: "assistant",
      content: "ok",
      timestamp: 1,
    });
    assert.equal(parsed.success, true);
  });
});
