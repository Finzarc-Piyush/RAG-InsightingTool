/**
 * Wave QL1 · The compound-shape Marico-VN dataset must NOT silently SUM
 * across mixed metrics (value_sales + volume) when the fast-path planner
 * forgets a Metric filter. Pins that `injectCompoundShapeMetricGuard` (WPF2)
 * runs deterministically inside the fast-path orchestrator, mirroring the
 * full-loop planner's contract.
 */
import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
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
process.env.QUICK_LOOKUP_ENABLED = "true";

const { runAgentTurn } = await import("../lib/agents/runtime/agentLoop.service.js");
const { buildAgentExecutionContext } = await import(
  "../lib/agents/runtime/context.js"
);
const { loadAgentConfigFromEnv } = await import(
  "../lib/agents/runtime/runtimeConfig.js"
);
const { LLM_PURPOSE } = await import("../lib/agents/runtime/llmCallPurpose.js");
const { installLlmStub, clearLlmStub } = await import("./helpers/llmStub.js");

after(() => clearLlmStub());

const compoundSummary: DataSummary = {
  rowCount: 16,
  columnCount: 5,
  columns: [
    {
      name: "Brand",
      type: "string",
      sampleValues: ["MARICO", "PURITE"],
      topValues: [
        { value: "MARICO", count: 8 },
        { value: "PURITE", count: 8 },
      ],
    },
    {
      name: "Period",
      type: "string",
      sampleValues: ["Q1 23", "Q2 23"],
    },
    {
      name: "PeriodIso",
      type: "string",
      sampleValues: ["2023-Q1", "2023-Q2"],
    },
    { name: "Value", type: "number", sampleValues: [100, 200] },
    {
      name: "Metric",
      type: "string",
      sampleValues: ["value_sales", "volume"],
      topValues: [
        { value: "value_sales", count: 8 },
        { value: "volume", count: 8 },
      ],
    },
  ],
  numericColumns: ["Value"],
  dateColumns: [],
  wideFormatTransform: {
    detected: true,
    shape: "compound",
    idColumns: ["Brand"],
    meltedColumns: ["Q1 23 Sales", "Q2 23 Sales", "Q1 23 Volume", "Q2 23 Volume"],
    periodCount: 2,
    periodColumn: "Period",
    periodIsoColumn: "PeriodIso",
    periodKindColumn: "PeriodKind",
    valueColumn: "Value",
    metricColumn: "Metric",
  } as DataSummary["wideFormatTransform"],
};

const sac: SessionAnalysisContext = {
  version: 1,
  dataset: { shortDescription: "fixture", columnRoles: [], caveats: [] },
  userIntent: { interpretedConstraints: [] },
  sessionKnowledge: { facts: [], analysesDone: [] },
  suggestedFollowUps: [],
  lastUpdated: { reason: "seed", at: new Date().toISOString() },
};

const chatDocument: Partial<ChatDocument> = {
  id: "ql-wf-session",
  sessionId: "ql-wf-session",
  dataSummary: compoundSummary,
  sessionAnalysisContext: sac,
};

function fixtureData(): Record<string, any>[] {
  return [
    { Brand: "MARICO", Period: "Q1 23", PeriodIso: "2023-Q1", Metric: "value_sales", Value: 1000 },
    { Brand: "MARICO", Period: "Q1 23", PeriodIso: "2023-Q1", Metric: "volume", Value: 50 },
    { Brand: "MARICO", Period: "Q2 23", PeriodIso: "2023-Q2", Metric: "value_sales", Value: 1200 },
    { Brand: "MARICO", Period: "Q2 23", PeriodIso: "2023-Q2", Metric: "volume", Value: 60 },
    { Brand: "PURITE", Period: "Q1 23", PeriodIso: "2023-Q1", Metric: "value_sales", Value: 800 },
    { Brand: "PURITE", Period: "Q1 23", PeriodIso: "2023-Q1", Metric: "volume", Value: 40 },
    { Brand: "PURITE", Period: "Q2 23", PeriodIso: "2023-Q2", Metric: "value_sales", Value: 900 },
    { Brand: "PURITE", Period: "Q2 23", PeriodIso: "2023-Q2", Metric: "volume", Value: 45 },
  ];
}

describe("Wave QL1 · compound-shape wide-format guard", () => {
  it("injects a Metric filter when the planner forgets one for a sales-intent question", async () => {
    installLlmStub({
      // Planner emits a "naïve" plan with NO Metric filter — the dataset is
      // compound, so summing Value would mix value_sales + volume.
      [LLM_PURPOSE.QUICK_LOOKUP_PLANNER]: () => ({
        plan: {
          groupBy: ["Brand"],
          aggregations: [
            { column: "Value", operation: "sum", alias: "Total Value" },
          ],
          sort: [{ column: "Total Value", direction: "desc" }],
          limit: 5,
        },
        questionRestated: "Top 5 brands by sales",
      }),
    });

    const ctx = buildAgentExecutionContext({
      sessionId: "ql-wf-session",
      username: "tester@example.com",
      question: "top 5 brands by sales",
      data: fixtureData(),
      summary: compoundSummary,
      chatHistory: [],
      mode: "analysis",
      sessionAnalysisContext: sac,
      chatDocument: chatDocument as ChatDocument,
    });

    const result = await runAgentTurn(ctx, loadAgentConfigFromEnv());

    // The injected guard should have surfaced as a dimensionFilter on
    // Metric matching the value_sales family — verified via the executed
    // plan stored on agentTrace.steps[0].args.plan.
    const step = result.agentTrace?.steps?.[0];
    assert.ok(step, "expected one execute_query_plan step on agentTrace");
    const plan = (step!.args as { plan: { dimensionFilters?: Array<{ column: string; values: string[] }> } }).plan;
    const metricFilter = plan.dimensionFilters?.find((f) => f.column === "Metric");
    assert.ok(
      metricFilter,
      "expected a Metric dimensionFilter to be injected by WPF2 guard"
    );
    assert.deepStrictEqual(metricFilter!.values, ["value_sales"]);

    // And the executed rows should be MARICO + PURITE summed across the
    // value_sales metric ONLY — 1000+1200 = 2200 for MARICO,
    // 800+900 = 1700 for PURITE — not the silent mix.
    const rows = result.table as Record<string, unknown>[];
    assert.ok(rows.length === 2, `expected 2 rows, got ${rows.length}`);
    const marico = rows.find((r) => r.Brand === "MARICO");
    assert.ok(marico, "expected MARICO row");
    assert.strictEqual(marico!["Total Value"], 2200);
    const purite = rows.find((r) => r.Brand === "PURITE");
    assert.ok(purite, "expected PURITE row");
    assert.strictEqual(purite!["Total Value"], 1700);
  });

  it("respects an existing Metric filter from the planner (no double-injection)", async () => {
    installLlmStub({
      [LLM_PURPOSE.QUICK_LOOKUP_PLANNER]: () => ({
        plan: {
          groupBy: ["Brand"],
          aggregations: [
            { column: "Value", operation: "sum", alias: "Total Volume" },
          ],
          dimensionFilters: [
            { column: "Metric", op: "in", values: ["volume"] },
          ],
          sort: [{ column: "Total Volume", direction: "desc" }],
          limit: 5,
        },
        questionRestated: "Top 5 brands by volume",
      }),
    });

    const ctx = buildAgentExecutionContext({
      sessionId: "ql-wf-session",
      username: "tester@example.com",
      question: "top 5 brands by volume",
      data: fixtureData(),
      summary: compoundSummary,
      chatHistory: [],
      mode: "analysis",
      sessionAnalysisContext: sac,
      chatDocument: chatDocument as ChatDocument,
    });

    const result = await runAgentTurn(ctx, loadAgentConfigFromEnv());

    const step = result.agentTrace?.steps?.[0];
    assert.ok(step);
    const plan = (step!.args as { plan: { dimensionFilters?: Array<{ column: string; values: string[] }> } }).plan;
    const metricFilters = (plan.dimensionFilters ?? []).filter(
      (f) => f.column === "Metric"
    );
    assert.strictEqual(
      metricFilters.length,
      1,
      "expected exactly one Metric filter (no double-injection)"
    );
    assert.deepStrictEqual(metricFilters[0].values, ["volume"]);

    // Sanity: rows reflect volume sums.
    const rows = result.table as Record<string, unknown>[];
    const marico = rows.find((r) => r.Brand === "MARICO");
    assert.strictEqual(marico!["Total Volume"], 110); // 50 + 60
  });
});
