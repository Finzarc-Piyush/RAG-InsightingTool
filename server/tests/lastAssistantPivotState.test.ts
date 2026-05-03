/**
 * W-PivotState · agent context surfaces the latest assistant message's
 * pivot/chart view so follow-up turns can reason against it.
 *
 * Pins three things:
 *   1. `buildAgentExecutionContext` walks `chatHistory` and lifts the most
 *      recent assistant message's `pivotState` onto the context object.
 *   2. `formatLastAssistantPivotStateBlock` produces a non-empty markdown
 *      block when state is present, "" when absent.
 *   3. `summarizeContextForPrompt` includes the block (planner consumes this).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.AZURE_OPENAI_API_KEY ??= "test";
process.env.AZURE_OPENAI_ENDPOINT ??= "https://test.openai.azure.com";
process.env.AZURE_OPENAI_DEPLOYMENT_NAME ??= "test-deployment";

const {
  buildAgentExecutionContext,
  formatLastAssistantPivotStateBlock,
  summarizeContextForPrompt,
} = await import("../lib/agents/runtime/context.js");

import type { Message, DataSummary, PivotState } from "../shared/schema.js";

const baseSummary: DataSummary = {
  rowCount: 100,
  columnCount: 3,
  columns: [
    { name: "Region", type: "string", topValues: [] },
    { name: "Total_Sales", type: "number", topValues: [] },
    { name: "Order Date", type: "date", topValues: [] },
  ],
  numericColumns: ["Total_Sales"],
  dateColumns: ["Order Date"],
};

const pivotState: PivotState = {
  schemaVersion: 1,
  config: {
    rows: ["Region"],
    columns: [],
    values: [{ id: "v1", field: "Total_Sales", agg: "sum" }],
    filters: ["Category"],
    unused: [],
  },
  filterSelections: { Category: ["Furniture", "Technology"] },
  analysisView: "chart",
  chart: {
    type: "bar",
    xCol: "Region",
    yCol: "Total_Sales",
    seriesCol: "",
    barLayout: "stacked",
  },
};

describe("W-PivotState · context wiring", () => {
  it("buildAgentExecutionContext lifts latest assistant pivotState onto context", () => {
    const history: Message[] = [
      { role: "user", content: "show sales by region", timestamp: 1 },
      {
        role: "assistant",
        content: "here is the breakdown",
        timestamp: 2,
        pivotState,
      },
      { role: "user", content: "now drill into Furniture", timestamp: 3 },
    ];
    const ctx = buildAgentExecutionContext({
      sessionId: "s1",
      question: "now drill into Furniture",
      data: [],
      summary: baseSummary,
      chatHistory: history,
      mode: "analysis",
    });
    assert.deepEqual(ctx.lastAssistantPivotState, pivotState);
  });

  it("walks past intermediate messages without state to find the prior finalised one", () => {
    const history: Message[] = [
      {
        role: "assistant",
        content: "earlier finalised answer",
        timestamp: 10,
        pivotState,
      },
      // intermediate streaming preview without saved state
      {
        role: "assistant",
        content: "drafting…",
        timestamp: 11,
        isIntermediate: true,
      },
      { role: "user", content: "follow-up", timestamp: 12 },
    ];
    const ctx = buildAgentExecutionContext({
      sessionId: "s1",
      question: "follow-up",
      data: [],
      summary: baseSummary,
      chatHistory: history,
      mode: "analysis",
    });
    assert.deepEqual(ctx.lastAssistantPivotState, pivotState);
  });

  it("returns undefined when no assistant message has pivotState", () => {
    const ctx = buildAgentExecutionContext({
      sessionId: "s1",
      question: "first ever question",
      data: [],
      summary: baseSummary,
      chatHistory: [{ role: "user", content: "first", timestamp: 1 }],
      mode: "analysis",
    });
    assert.equal(ctx.lastAssistantPivotState, undefined);
  });

  it("formatLastAssistantPivotStateBlock includes rows/values/chart on populated state", () => {
    const block = formatLastAssistantPivotStateBlock(pivotState);
    assert.match(block, /CURRENT_USER_VIEW/);
    assert.match(block, /rows: Region/);
    assert.match(block, /values: Total_Sales\(sum\)/);
    assert.match(block, /chart: bar/);
    assert.match(block, /filterSelections: Category=\[Furniture\|Technology\]/);
  });

  it("formatLastAssistantPivotStateBlock returns empty string when state is missing", () => {
    assert.equal(formatLastAssistantPivotStateBlock(undefined), "");
  });

  it("summarizeContextForPrompt includes the CURRENT_USER_VIEW block when state is set", () => {
    const ctx = buildAgentExecutionContext({
      sessionId: "s1",
      question: "follow-up",
      data: [],
      summary: baseSummary,
      chatHistory: [
        {
          role: "assistant",
          content: "prior",
          timestamp: 1,
          pivotState,
        },
      ],
      mode: "analysis",
    });
    const prompt = summarizeContextForPrompt(ctx);
    assert.match(prompt, /CURRENT_USER_VIEW/);
  });
});
