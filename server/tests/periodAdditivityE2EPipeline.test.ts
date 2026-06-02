/**
 * Layer B (e2e) · A "latest 12 months" ranking question on a melted pure_period
 * dataset must NOT silently SUM Value across the overlapping period rows
 * (L12M + quarters). Pins that injectPeriodAdditivityGuard runs inside the
 * fast-path orchestrator and the executed plan carries a PeriodIso=L12M filter,
 * so the per-product total is the latest-12-months value, not the all-periods sum.
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
const { buildAgentExecutionContext } = await import("../lib/agents/runtime/context.js");
const { loadAgentConfigFromEnv } = await import("../lib/agents/runtime/types.js");
const { LLM_PURPOSE } = await import("../lib/agents/runtime/llmCallPurpose.js");
const { installLlmStub, clearLlmStub } = await import("./helpers/llmStub.js");

after(() => clearLlmStub());

const top = (...vals: string[]) => vals.map((v, i) => ({ value: v, count: vals.length - i }));

const purePeriodSummary: DataSummary = {
  rowCount: 6,
  columnCount: 4,
  columns: [
    {
      name: "Products",
      type: "string",
      sampleValues: ["FEMALE SHOWER GEL", "PURITE"],
      topValues: top("FEMALE SHOWER GEL", "PURITE"),
    },
    { name: "Period", type: "string", sampleValues: ["Latest 12 Mths", "Q1 23"] },
    {
      name: "PeriodIso",
      type: "string",
      sampleValues: ["L12M", "2023-Q1"],
      topValues: top("L12M", "L12M-YA", "2023-Q1", "2024-Q1", "2025-Q4"),
    },
    {
      name: "PeriodKind",
      type: "string",
      sampleValues: ["latest_n", "quarter"],
      topValues: top("latest_n", "quarter"),
    },
    { name: "Value", type: "number", sampleValues: [2500, 600] },
  ],
  numericColumns: ["Value"],
  dateColumns: [],
  wideFormatTransform: {
    detected: true,
    shape: "pure_period",
    idColumns: ["Products"],
    meltedColumns: ["Latest 12 Mths", "Q1 23", "Q4 25"],
    periodCount: 18,
    periodColumn: "Period",
    periodIsoColumn: "PeriodIso",
    periodKindColumn: "PeriodKind",
    valueColumn: "Value",
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
  id: "pa-e2e-session",
  sessionId: "pa-e2e-session",
  dataSummary: purePeriodSummary,
  sessionAnalysisContext: sac,
};

// L12M is the pre-computed latest-12-months total; the quarters are the
// overlapping component rows that must NOT be added to it.
function fixtureData(): Record<string, any>[] {
  return [
    { Products: "FEMALE SHOWER GEL", Period: "Latest 12 Mths", PeriodIso: "L12M", PeriodKind: "latest_n", Value: 2500 },
    { Products: "FEMALE SHOWER GEL", Period: "Q1 23", PeriodIso: "2023-Q1", PeriodKind: "quarter", Value: 600 },
    { Products: "FEMALE SHOWER GEL", Period: "Q4 25", PeriodIso: "2025-Q4", PeriodKind: "quarter", Value: 660 },
    { Products: "PURITE", Period: "Latest 12 Mths", PeriodIso: "L12M", PeriodKind: "latest_n", Value: 1800 },
    { Products: "PURITE", Period: "Q1 23", PeriodIso: "2023-Q1", PeriodKind: "quarter", Value: 400 },
    { Products: "PURITE", Period: "Q4 25", PeriodIso: "2025-Q4", PeriodKind: "quarter", Value: 470 },
  ];
}

describe("Layer B e2e · latest-12-months ranking on pure_period", () => {
  it("injects PeriodIso=L12M so the per-product total is the L12M value, not the all-periods sum", async () => {
    installLlmStub({
      // Naïve plan: groupBy Products, SUM Value, NO period filter.
      [LLM_PURPOSE.QUICK_LOOKUP_PLANNER]: () => ({
        plan: {
          groupBy: ["Products"],
          aggregations: [{ column: "Value", operation: "sum", alias: "Total Value" }],
          sort: [{ column: "Total Value", direction: "desc" }],
          limit: 5,
        },
        questionRestated: "Highest product in the latest 12 months",
      }),
    });

    const ctx = buildAgentExecutionContext({
      sessionId: "pa-e2e-session",
      username: "tester@example.com",
      question: "highest product by Sales Value in the latest 12 months",
      data: fixtureData(),
      summary: purePeriodSummary,
      chatHistory: [],
      mode: "analysis",
      sessionAnalysisContext: sac,
      chatDocument: chatDocument as ChatDocument,
    });

    const result = await runAgentTurn(ctx, loadAgentConfigFromEnv());

    const step = result.agentTrace?.steps?.[0];
    assert.ok(step, "expected one execute_query_plan step on agentTrace");
    const plan = (step!.args as {
      plan: { dimensionFilters?: Array<{ column: string; values: string[] }> };
    }).plan;
    const periodFilter = plan.dimensionFilters?.find((f) => f.column === "PeriodIso");
    assert.ok(periodFilter, "expected a PeriodIso filter injected by the period-additivity guard");
    assert.deepStrictEqual(periodFilter!.values, ["L12M"]);

    // L12M-only totals: FEMALE SHOWER GEL = 2500 (NOT 2500+600+660 = 3760).
    const rows = result.table as Record<string, unknown>[];
    const fsg = rows.find((r) => r.Products === "FEMALE SHOWER GEL");
    assert.ok(fsg, "expected FEMALE SHOWER GEL row");
    assert.strictEqual(fsg!["Total Value"], 2500);
    const purite = rows.find((r) => r.Products === "PURITE");
    assert.strictEqual(purite!["Total Value"], 1800);
  });

  it("does NOT add a period filter when the plan already groups by PeriodIso (quarterly trend)", async () => {
    installLlmStub({
      [LLM_PURPOSE.QUICK_LOOKUP_PLANNER]: () => ({
        plan: {
          groupBy: ["PeriodIso"],
          aggregations: [{ column: "Value", operation: "sum", alias: "Total Value" }],
          sort: [{ column: "PeriodIso", direction: "asc" }],
        },
        questionRestated: "Sales value by period",
      }),
    });

    const ctx = buildAgentExecutionContext({
      sessionId: "pa-e2e-session",
      username: "tester@example.com",
      question: "list Sales Value by quarter",
      data: fixtureData(),
      summary: purePeriodSummary,
      chatHistory: [],
      mode: "analysis",
      sessionAnalysisContext: sac,
      chatDocument: chatDocument as ChatDocument,
    });

    const result = await runAgentTurn(ctx, loadAgentConfigFromEnv());
    const step = result.agentTrace?.steps?.[0];
    assert.ok(step);
    const plan = (step!.args as {
      plan: { dimensionFilters?: Array<{ column: string; values: string[] }> };
    }).plan;
    // The pre-existing PeriodKind=quarter filter stays; no second single-period
    // filter (PeriodIso=L12M) was injected over a period group-by.
    const isoFilters = (plan.dimensionFilters ?? []).filter((f) => f.column === "PeriodIso");
    assert.strictEqual(isoFilters.length, 0, "must not pin a single period when grouping by period");
  });
});
