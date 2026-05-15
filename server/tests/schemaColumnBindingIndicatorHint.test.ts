/**
 * Wave SU-IC3 · schema-binding indicator-hint tests.
 *
 * Pin the contract: the binding-LLM prompt rendered for an indicator-bearing
 * dataset surfaces each indicator column with `[INDICATOR <polarity>
 * — answers: "..."]` after the type tag, AND the prompt's column-matching
 * rules call out the indicator-preference rule. Stub the LLM via the W18
 * harness, capture the messages it was sent, and assert the rendered shape.
 */
import assert from "node:assert/strict";
import { describe, it, after } from "node:test";

process.env.AZURE_OPENAI_API_KEY ??= "test";
process.env.AZURE_OPENAI_ENDPOINT ??= "https://test.openai.azure.com";
process.env.AZURE_OPENAI_DEPLOYMENT_NAME ??= "test-deployment";

const { bindSchemaColumnsForAgentic } = await import(
  "../lib/schemaColumnBinding.js"
);
const { LLM_PURPOSE } = await import("../lib/agents/runtime/llmCallPurpose.js");
const { installLlmStub, clearLlmStub } = await import("./helpers/llmStub.js");
import type { DataSummary } from "../shared/schema.js";

after(() => clearLlmStub());

function indicatorSummary(): DataSummary {
  return {
    rowCount: 100,
    columnCount: 3,
    columns: [
      {
        name: "Clock-In <09:30",
        type: "text",
        sampleValues: [],
        indicator: {
          kind: "boolean",
          positiveValues: ["Yes"],
          negativeValues: ["No"],
          sentinelValues: ["Absent"],
          source: "auto",
        },
        answersQuestions: [
          "what % of staff clocked in before 9:30 am?",
          "attendance punctuality breakdown",
        ],
      },
      {
        name: "Region",
        type: "text",
        sampleValues: [],
      },
    ],
    numericColumns: [],
    dateColumns: [],
  };
}

describe("Wave SU-IC3 · schemaColumnBinding indicator hint", () => {
  it("decorates indicator columns inline with [INDICATOR ...] and surfaces answersQuestions", async () => {
    let captured: { user: string | null } = { user: null };
    installLlmStub({
      [LLM_PURPOSE.SCHEMA_BIND]: (params) => {
        const msgs = (params as { messages: Array<{ role: string; content: string }> }).messages;
        const userMsg = msgs.find((m) => m.role === "user");
        captured.user = userMsg?.content ?? null;
        return {
          identifiedColumns: ["Clock-In <09:30"],
          columnMapping: { "login before 9:30": "Clock-In <09:30" },
          reasoning: "stub",
        };
      },
    });

    const summary = indicatorSummary();
    await bindSchemaColumnsForAgentic(
      "what % of people login before 9:30 am?",
      summary,
      []
    );

    assert.ok(captured.user, "user message captured");
    // Indicator column annotated with [INDICATOR <polarity> — answers: ...]
    assert.match(
      captured.user!,
      /Clock-In <09:30 \[text\] \[INDICATOR Yes\|No — answers: "what % of staff clocked in before 9:30 am\?", "attendance punctuality breakdown"\]/
    );
    // Plain column has no INDICATOR tag.
    assert.match(captured.user!, /Region \[text\]/);
    assert.equal(/Region \[text\] \[INDICATOR/.test(captured.user!), false);
    // Matching-rule line is present so the LLM knows to prefer the indicator.
    assert.match(captured.user!, /INDICATOR-COLUMN PREFERENCE/);
  });

  it("emits no INDICATOR markers on a dataset without indicators", async () => {
    let captured: { user: string | null } = { user: null };
    installLlmStub({
      [LLM_PURPOSE.SCHEMA_BIND]: (params) => {
        const msgs = (params as { messages: Array<{ role: string; content: string }> }).messages;
        const userMsg = msgs.find((m) => m.role === "user");
        captured.user = userMsg?.content ?? null;
        return {
          identifiedColumns: [],
          columnMapping: {},
          reasoning: "stub",
        };
      },
    });

    const summary: DataSummary = {
      rowCount: 10,
      columnCount: 2,
      columns: [
        { name: "Region", type: "text", sampleValues: [] },
        { name: "Sales", type: "number", sampleValues: [] },
      ],
      numericColumns: ["Sales"],
      dateColumns: [],
    };
    await bindSchemaColumnsForAgentic("sales by region", summary, []);
    assert.ok(captured.user);
    // No per-column [INDICATOR ...] decoration on the dataset's actual columns.
    // (The COLUMN MATCHING RULES section still mentions the indicator-preference
    // rule with a worked example — that's the static guidance, not a column tag.)
    assert.equal(
      /Region \[text\] \[INDICATOR/.test(captured.user!),
      false
    );
    assert.equal(
      /Sales \[number\] \[INDICATOR/.test(captured.user!),
      false
    );
  });
});
