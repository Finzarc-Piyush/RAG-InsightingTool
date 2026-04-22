import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildAgentExecutionContext,
  summarizeContextForPrompt,
} from "../lib/agents/runtime/context.js";
import { mergeInferredFiltersIntoBrief } from "../lib/agents/runtime/analysisBrief.js";
import type { DataSummary, AnalysisBrief } from "../shared/schema.js";

function superstoreSummary(): DataSummary {
  return {
    rowCount: 1000,
    columnCount: 4,
    columns: [
      { name: "Sales", type: "number", sampleValues: [] },
      { name: "Order Date", type: "string", sampleValues: [] },
      {
        name: "Category",
        type: "string",
        sampleValues: [],
        topValues: [
          { value: "Furniture", count: 300 },
          { value: "Office Supplies", count: 500 },
          { value: "Technology", count: 200 },
        ],
      },
      {
        name: "Region",
        type: "string",
        sampleValues: [],
        topValues: [
          { value: "Central", count: 250 },
          { value: "East", count: 250 },
          { value: "South", count: 250 },
          { value: "West", count: 250 },
        ],
      },
    ],
    numericColumns: ["Sales"],
    dateColumns: ["Order Date"],
  } as DataSummary;
}

describe("buildAgentExecutionContext — inferredFilters seeding", () => {
  it("populates ctx.inferredFilters from the bug question against Superstore", () => {
    const ctx = buildAgentExecutionContext({
      sessionId: "s1",
      question: "which region is growing the most in terms of furniture sales?",
      data: [],
      summary: superstoreSummary(),
      chatHistory: [],
      mode: "analysis",
    });
    assert.ok(ctx.inferredFilters, "expected inferredFilters on ctx");
    assert.equal(ctx.inferredFilters!.length, 1);
    assert.equal(ctx.inferredFilters![0]!.column, "Category");
    assert.deepEqual(ctx.inferredFilters![0]!.values, ["Furniture"]);
  });

  it("leaves ctx.inferredFilters undefined when question matches no categorical value", () => {
    const ctx = buildAgentExecutionContext({
      sessionId: "s1",
      question: "show me total sales over time",
      data: [],
      summary: superstoreSummary(),
      chatHistory: [],
      mode: "analysis",
    });
    assert.equal(ctx.inferredFilters, undefined);
  });
});

describe("summarizeContextForPrompt — INFERRED_FILTERS_JSON block", () => {
  it("emits the block when inferredFilters is populated", () => {
    const ctx = buildAgentExecutionContext({
      sessionId: "s1",
      question: "which region is growing the most in terms of furniture sales?",
      data: [],
      summary: superstoreSummary(),
      chatHistory: [],
      mode: "analysis",
    });
    const text = summarizeContextForPrompt(ctx);
    assert.match(text, /INFERRED_FILTERS_JSON/);
    assert.match(text, /"column":"Category"/);
    assert.match(text, /"values":\["Furniture"\]/);
    assert.match(text, /treat as authoritative/i);
  });

  it("omits the block when there are no inferred filters", () => {
    const ctx = buildAgentExecutionContext({
      sessionId: "s1",
      question: "show me total sales over time",
      data: [],
      summary: superstoreSummary(),
      chatHistory: [],
      mode: "analysis",
    });
    const text = summarizeContextForPrompt(ctx);
    assert.doesNotMatch(text, /INFERRED_FILTERS_JSON/);
  });
});

describe("mergeInferredFiltersIntoBrief", () => {
  it("adds inferred filters when brief.filters is empty", () => {
    const brief: AnalysisBrief = {
      version: 1,
      clarifyingQuestions: [],
      epistemicNotes: [],
    };
    const merged = mergeInferredFiltersIntoBrief(brief, [
      {
        column: "Category",
        op: "in",
        values: ["Furniture"],
        match: "case_insensitive",
        matchedTokens: ["furniture"],
      },
    ]);
    assert.equal(merged.filters?.length, 1);
    assert.equal(merged.filters?.[0]?.column, "Category");
    assert.deepEqual(merged.filters?.[0]?.values, ["Furniture"]);
  });

  it("does not duplicate when brief already has a filter for the same (column, op)", () => {
    const brief: AnalysisBrief = {
      version: 1,
      clarifyingQuestions: [],
      epistemicNotes: [],
      filters: [
        { column: "Category", op: "in", values: ["Furniture", "Technology"] },
      ],
    };
    const merged = mergeInferredFiltersIntoBrief(brief, [
      {
        column: "Category",
        op: "in",
        values: ["Furniture"],
        match: "case_insensitive",
        matchedTokens: ["furniture"],
      },
    ]);
    assert.equal(merged.filters?.length, 1);
    assert.deepEqual(merged.filters?.[0]?.values, ["Furniture", "Technology"]);
  });

  it("merges distinct (column, op) pairs", () => {
    const brief: AnalysisBrief = {
      version: 1,
      clarifyingQuestions: [],
      epistemicNotes: [],
      filters: [{ column: "Region", op: "in", values: ["East"] }],
    };
    const merged = mergeInferredFiltersIntoBrief(brief, [
      {
        column: "Category",
        op: "in",
        values: ["Furniture"],
        match: "case_insensitive",
        matchedTokens: ["furniture"],
      },
    ]);
    assert.equal(merged.filters?.length, 2);
    const cols = merged.filters?.map((f) => f.column).sort();
    assert.deepEqual(cols, ["Category", "Region"]);
  });

  it("is a no-op when there are no inferred filters", () => {
    const brief: AnalysisBrief = {
      version: 1,
      clarifyingQuestions: [],
      epistemicNotes: [],
    };
    const merged = mergeInferredFiltersIntoBrief(brief, []);
    assert.strictEqual(merged, brief);
  });
});
