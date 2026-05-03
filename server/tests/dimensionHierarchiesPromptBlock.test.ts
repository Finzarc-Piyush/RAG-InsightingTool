import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatDimensionHierarchiesBlock,
  summarizeContextForPrompt,
} from "../lib/agents/runtime/context.js";
import type { AgentExecutionContext } from "../lib/agents/runtime/types.js";
import type { DataSummary } from "../shared/schema.js";

function ctxWithHierarchies(
  hierarchies?: AgentExecutionContext["sessionAnalysisContext"] extends infer S
    ? S extends { dataset: { dimensionHierarchies?: infer H } }
      ? H
      : never
    : never
): AgentExecutionContext {
  const summary: DataSummary = {
    rowCount: 100,
    columnCount: 3,
    columns: [
      { name: "Products", type: "string", sampleValues: [] },
      { name: "Markets", type: "string", sampleValues: [] },
      { name: "Total_Sales_Value", type: "number", sampleValues: [] },
    ],
    numericColumns: ["Total_Sales_Value"],
    dateColumns: [],
  };
  const sac = hierarchies
    ? {
        version: 1 as const,
        dataset: {
          shortDescription: "Marico-VN sales.",
          columnRoles: [],
          caveats: [],
          dimensionHierarchies: hierarchies as Array<{
            column: string;
            rollupValue: string;
            itemValues?: string[];
            source: "user" | "auto";
            description?: string;
          }>,
        },
        userIntent: { interpretedConstraints: [] },
        sessionKnowledge: { facts: [], analysesDone: [] },
        suggestedFollowUps: [],
        lastUpdated: { reason: "user_context" as const, at: "2026-04-29T00:00:00.000Z" },
      }
    : undefined;
  return {
    sessionId: "s1",
    question: "rank products by sales",
    data: [],
    summary,
    chatHistory: [],
    mode: "analysis",
    sessionAnalysisContext: sac,
  } as AgentExecutionContext;
}

describe("H4 · formatDimensionHierarchiesBlock", () => {
  it("renders an empty string when no hierarchies declared", () => {
    assert.equal(formatDimensionHierarchiesBlock(ctxWithHierarchies()), "");
  });

  it("renders a labelled block with column, rollupValue, and children", () => {
    const ctx = ctxWithHierarchies([
      {
        column: "Products",
        rollupValue: "FEMALE SHOWER GEL",
        itemValues: ["MARICO", "PURITE", "OLIV", "LASHE"],
        source: "user",
        description: "FEMALE SHOWER GEL is the category total.",
      },
    ]);
    const block = formatDimensionHierarchiesBlock(ctx);
    assert.match(block, /DIMENSION HIERARCHIES \(declared by the user/);
    assert.match(block, /"Products" column: "FEMALE SHOWER GEL"/);
    assert.match(block, /children: MARICO, PURITE, OLIV, LASHE/);
    assert.match(block, /FEMALE SHOWER GEL is the category total\./);
    assert.match(block, /auto-excludes the rollup row from peer comparisons/);
  });

  it("omits children parenthetical when itemValues is absent", () => {
    const ctx = ctxWithHierarchies([
      { column: "Region", rollupValue: "All Regions", source: "user" },
    ]);
    const block = formatDimensionHierarchiesBlock(ctx);
    assert.match(block, /"Region" column: "All Regions"/);
    assert.doesNotMatch(block, /children:/);
  });
});

describe("H4 · summarizeContextForPrompt includes hierarchy block", () => {
  it("appends the hierarchy block to the planner context", () => {
    const ctx = ctxWithHierarchies([
      {
        column: "Products",
        rollupValue: "FEMALE SHOWER GEL",
        source: "user",
      },
    ]);
    const out = summarizeContextForPrompt(ctx);
    assert.match(out, /DIMENSION HIERARCHIES/);
    assert.match(out, /FEMALE SHOWER GEL/);
  });

  it("does not include the block when no hierarchies declared", () => {
    const ctx = ctxWithHierarchies();
    const out = summarizeContextForPrompt(ctx);
    assert.doesNotMatch(out, /DIMENSION HIERARCHIES/);
  });
});
