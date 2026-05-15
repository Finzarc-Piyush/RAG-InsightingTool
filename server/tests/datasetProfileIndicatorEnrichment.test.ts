/**
 * Wave SU-IC2 · indicator enrichment tests.
 *
 * Pin the contract: the LLM pass adds `answersQuestions` to per-column
 * meta, fills polarity only when the heuristic guess was empty, never
 * overrides user-source indicators, and gracefully no-ops when the
 * summary has no indicators or when the LLM throws / times out.
 */
import assert from "node:assert/strict";
import { describe, it, after } from "node:test";

process.env.AZURE_OPENAI_API_KEY ??= "test";
process.env.AZURE_OPENAI_ENDPOINT ??= "https://test.openai.azure.com";
process.env.AZURE_OPENAI_DEPLOYMENT_NAME ??= "test-deployment";

const { enrichIndicatorColumns } = await import(
  "../lib/enrichIndicatorColumns.js"
);
const { LLM_PURPOSE } = await import("../lib/agents/runtime/llmCallPurpose.js");
const { installLlmStub, clearLlmStub } = await import(
  "./helpers/llmStub.js"
);
import type { DataSummary } from "../shared/schema.js";

after(() => clearLlmStub());

function makeSummary(): DataSummary {
  return {
    rowCount: 50,
    columnCount: 3,
    columns: [
      {
        name: "Clock-In <09:30",
        type: "text",
        sampleValues: [],
        topValues: [
          { value: "Yes", count: 20 },
          { value: "No", count: 25 },
          { value: "Absent", count: 5 },
        ],
        indicator: {
          kind: "boolean",
          positiveValues: ["Yes"],
          negativeValues: ["No"],
          sentinelValues: ["Absent"],
          source: "auto",
        },
      },
      {
        name: "Tier",
        type: "text",
        sampleValues: [],
        topValues: [
          { value: "On", count: 30 },
          { value: "Off", count: 20 },
        ],
        // SU-IC1 promoted via name-pattern but couldn't dictionary-match
        // the "On"/"Off" axis (in this fixture). Polarity is empty.
        indicator: {
          kind: "categorical",
          source: "auto",
        },
      },
      {
        name: "Region",
        type: "text",
        sampleValues: [],
        topValues: [
          { value: "North", count: 10 },
          { value: "South", count: 10 },
        ],
        // No indicator field — should be ignored entirely.
      },
    ],
    numericColumns: [],
    dateColumns: [],
  };
}

describe("Wave SU-IC2 · enrichIndicatorColumns", () => {
  it("populates answersQuestions and fills empty polarity", async () => {
    installLlmStub({
      [LLM_PURPOSE.INDICATOR_ENRICH]: () => ({
        enrichments: [
          {
            column: "Clock-In <09:30",
            answersQuestions: [
              "what % of staff clocked in before 9:30 am?",
              "attendance punctuality breakdown",
              "who clocked in late?",
            ],
            // Heuristic already had positiveValues=["Yes"], so this
            // should NOT override.
            positiveValues: ["Y"],
          },
          {
            column: "Tier",
            answersQuestions: ["which records are On vs Off?"],
            positiveValues: ["On"],
            negativeValues: ["Off"],
          },
        ],
      }),
    });

    const summary = makeSummary();
    const { enriched } = await enrichIndicatorColumns(summary, {
      shortDescription: "Marico attendance dataset.",
    });
    assert.equal(enriched, 2);

    const clockIn = summary.columns.find((c) => c.name === "Clock-In <09:30");
    assert.deepEqual(clockIn?.answersQuestions, [
      "what % of staff clocked in before 9:30 am?",
      "attendance punctuality breakdown",
      "who clocked in late?",
    ]);
    // Polarity preserved — heuristic source wins when guess was non-empty.
    assert.deepEqual(clockIn?.indicator?.positiveValues, ["Yes"]);
    assert.equal(clockIn?.indicator?.source, "auto");

    const tier = summary.columns.find((c) => c.name === "Tier");
    assert.deepEqual(tier?.answersQuestions, ["which records are On vs Off?"]);
    // LLM filled the empty polarity → source bumped to "llm".
    assert.deepEqual(tier?.indicator?.positiveValues, ["On"]);
    assert.deepEqual(tier?.indicator?.negativeValues, ["Off"]);
    assert.equal(tier?.indicator?.source, "llm");

    // Non-indicator column untouched.
    const region = summary.columns.find((c) => c.name === "Region");
    assert.equal(region?.answersQuestions, undefined);
    assert.equal(region?.indicator, undefined);
  });

  it("no-ops when the summary has no indicator columns (no LLM call)", async () => {
    let llmCalled = false;
    installLlmStub({
      [LLM_PURPOSE.INDICATOR_ENRICH]: () => {
        llmCalled = true;
        return { enrichments: [] };
      },
    });
    const summary: DataSummary = {
      rowCount: 10,
      columnCount: 1,
      columns: [{ name: "X", type: "text", sampleValues: [] }],
      numericColumns: [],
      dateColumns: [],
    };
    const { enriched } = await enrichIndicatorColumns(summary);
    assert.equal(enriched, 0);
    assert.equal(llmCalled, false);
  });

  it("preserves user-source indicators (never overwrites)", async () => {
    installLlmStub({
      [LLM_PURPOSE.INDICATOR_ENRICH]: () => ({
        enrichments: [
          {
            column: "X",
            answersQuestions: ["should not appear"],
            positiveValues: ["AlsoShouldNotAppear"],
          },
        ],
      }),
    });
    const summary: DataSummary = {
      rowCount: 10,
      columnCount: 1,
      columns: [
        {
          name: "X",
          type: "text",
          sampleValues: [],
          topValues: [{ value: "A", count: 1 }],
          indicator: {
            kind: "categorical",
            positiveValues: ["UserSet"],
            source: "user",
          },
        },
      ],
      numericColumns: [],
      dateColumns: [],
    };
    await enrichIndicatorColumns(summary);
    const col = summary.columns[0];
    assert.equal(col.answersQuestions, undefined);
    assert.deepEqual(col.indicator?.positiveValues, ["UserSet"]);
    assert.equal(col.indicator?.source, "user");
  });

  it("gracefully no-ops on malformed LLM output", async () => {
    installLlmStub({
      [LLM_PURPOSE.INDICATOR_ENRICH]: () => ({
        // missing required `enrichments` key — Zod fails parse.
        not_what_we_expected: true,
      }),
    });
    const summary = makeSummary();
    const { enriched } = await enrichIndicatorColumns(summary);
    assert.equal(enriched, 0);
    // Heuristic state intact.
    const clockIn = summary.columns.find((c) => c.name === "Clock-In <09:30");
    assert.deepEqual(clockIn?.indicator?.positiveValues, ["Yes"]);
    assert.equal(clockIn?.answersQuestions, undefined);
  });

  it("gracefully no-ops on stub throw", async () => {
    installLlmStub({
      [LLM_PURPOSE.INDICATOR_ENRICH]: () => {
        throw new Error("stub explosion");
      },
    });
    const summary = makeSummary();
    const { enriched } = await enrichIndicatorColumns(summary);
    assert.equal(enriched, 0);
  });
});
