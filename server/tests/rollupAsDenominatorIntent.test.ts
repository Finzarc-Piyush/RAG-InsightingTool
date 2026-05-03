import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyHierarchyIntent,
  injectRollupExcludeFilters,
  shouldSkipRollupExclude,
} from "../lib/agents/runtime/planArgRepairs.js";
import { formatDimensionHierarchiesBlock } from "../lib/agents/runtime/context.js";
import type { PlanStep, AgentExecutionContext } from "../lib/agents/runtime/types.js";
import type { DimensionHierarchy, DataSummary } from "../shared/schema.js";

const PRODUCTS_HIERARCHY: DimensionHierarchy = {
  column: "Products",
  rollupValue: "FEMALE SHOWER GEL",
  itemValues: ["MARICO", "PURITE", "OLIV", "LASHE"],
  source: "user",
};

describe("RD1 · shouldSkipRollupExclude — direct mention vs share-of-category", () => {
  it("direct rollup-value mention → skip with reason 'mention'", () => {
    const r = shouldSkipRollupExclude(
      "Show me FEMALE SHOWER GEL split by Markets",
      PRODUCTS_HIERARCHY,
    );
    assert.deepEqual(r, { skip: true, reason: "mention" });
  });

  it("'share of the category' → skip with reason 'share-of-category'", () => {
    const r = shouldSkipRollupExclude(
      "What is MARICO's share of the category?",
      PRODUCTS_HIERARCHY,
    );
    assert.deepEqual(r, { skip: true, reason: "share-of-category" });
  });

  it("'% of total' → skip with reason 'share-of-category'", () => {
    const r = shouldSkipRollupExclude(
      "What % of total sales does MARICO contribute?",
      PRODUCTS_HIERARCHY,
    );
    assert.deepEqual(r, { skip: true, reason: "share-of-category" });
  });

  it("'contribution to overall' → skip with reason 'share-of-category'", () => {
    const r = shouldSkipRollupExclude(
      "Each brand's contribution to the overall numbers",
      PRODUCTS_HIERARCHY,
    );
    assert.deepEqual(r, { skip: true, reason: "share-of-category" });
  });

  it("'share of Products' (column name + share) → skip with reason 'share-of-category'", () => {
    const r = shouldSkipRollupExclude(
      "MARICO's share of Products",
      PRODUCTS_HIERARCHY,
    );
    assert.deepEqual(r, { skip: true, reason: "share-of-category" });
  });

  it("plain 'rank products' → no skip (peer comparison)", () => {
    const r = shouldSkipRollupExclude(
      "Rank the products by sales",
      PRODUCTS_HIERARCHY,
    );
    assert.deepEqual(r, { skip: false, reason: null });
  });

  it("'share' alone with no category/column hint → no skip (ambiguous)", () => {
    const r = shouldSkipRollupExclude(
      "Show me the share of MARICO over time",
      PRODUCTS_HIERARCHY,
    );
    // 'share of' matched but no category/Products keyword → not a category-share question
    assert.deepEqual(r, { skip: false, reason: null });
  });

  it("empty/undefined question → no skip", () => {
    assert.deepEqual(shouldSkipRollupExclude("", PRODUCTS_HIERARCHY), {
      skip: false,
      reason: null,
    });
    assert.deepEqual(shouldSkipRollupExclude(undefined, PRODUCTS_HIERARCHY), {
      skip: false,
      reason: null,
    });
  });
});

describe("RD1 · injectRollupExcludeFilters honors share-of-category override", () => {
  it("does NOT inject not_in filter when user asks share-of-category", () => {
    const step: PlanStep = {
      id: "s1",
      tool: "execute_query_plan",
      args: {
        plan: {
          groupBy: ["Products"],
          aggregations: [{ column: "Total_Sales_Value", operation: "sum" }],
        },
      },
    };
    const injected = injectRollupExcludeFilters(
      step,
      [PRODUCTS_HIERARCHY],
      "What share of the category does each brand contribute?",
    );
    assert.deepEqual(injected, []);
    assert.equal((step.args as any).plan.dimensionFilters, undefined);
  });

  it("still injects not_in for plain peer-comparison questions (no regression)", () => {
    const step: PlanStep = {
      id: "s1",
      tool: "execute_query_plan",
      args: { plan: { groupBy: ["Products"] } },
    };
    const injected = injectRollupExcludeFilters(
      step,
      [PRODUCTS_HIERARCHY],
      "Rank brands by sales",
    );
    assert.deepEqual(injected, ["Products=FEMALE SHOWER GEL"]);
  });
});

describe("RD1 · classifyHierarchyIntent", () => {
  it("returns share-of-category for share questions", () => {
    const out = classifyHierarchyIntent(
      "What % of total sales does MARICO contribute?",
      [PRODUCTS_HIERARCHY],
    );
    assert.deepEqual(out, [
      {
        column: "Products",
        rollupValue: "FEMALE SHOWER GEL",
        intent: "share-of-category",
      },
    ]);
  });

  it("returns rollup-mention when user names the rollup value", () => {
    const out = classifyHierarchyIntent(
      "Show me FEMALE SHOWER GEL by Markets",
      [PRODUCTS_HIERARCHY],
    );
    assert.equal(out[0].intent, "rollup-mention");
  });

  it("returns peer-comparison for plain breakdowns", () => {
    const out = classifyHierarchyIntent("rank products by sales", [PRODUCTS_HIERARCHY]);
    assert.equal(out[0].intent, "peer-comparison");
  });

  it("returns empty for no hierarchies", () => {
    assert.deepEqual(classifyHierarchyIntent("anything", undefined), []);
    assert.deepEqual(classifyHierarchyIntent("anything", []), []);
  });
});

describe("RD1 · formatDimensionHierarchiesBlock surfaces detected intent", () => {
  function ctxFor(question: string): AgentExecutionContext {
    const summary: DataSummary = {
      rowCount: 100,
      columnCount: 2,
      columns: [
        { name: "Products", type: "string", sampleValues: [] },
        { name: "Total_Sales_Value", type: "number", sampleValues: [] },
      ],
      numericColumns: ["Total_Sales_Value"],
      dateColumns: [],
    };
    return {
      sessionId: "s1",
      question,
      data: [],
      summary,
      chatHistory: [],
      mode: "analysis",
      sessionAnalysisContext: {
        version: 1,
        dataset: {
          shortDescription: "",
          columnRoles: [],
          caveats: [],
          dimensionHierarchies: [PRODUCTS_HIERARCHY],
        },
        userIntent: { interpretedConstraints: [] },
        sessionKnowledge: { facts: [], analysesDone: [] },
        suggestedFollowUps: [],
        lastUpdated: { reason: "user_context", at: "2026-04-29T00:00:00.000Z" },
      },
    } as AgentExecutionContext;
  }

  it("appends the share-of-category intent block with denominator hint", () => {
    const out = formatDimensionHierarchiesBlock(
      ctxFor("MARICO's share of the category"),
    );
    assert.match(out, /DETECTED INTENT — share-of-category/);
    assert.match(out, /denominator: "FEMALE SHOWER GEL"/);
  });

  it("appends the rollup-mention block when user names the rollup value", () => {
    const out = formatDimensionHierarchiesBlock(
      ctxFor("Show me FEMALE SHOWER GEL by Markets"),
    );
    assert.match(out, /DETECTED INTENT — rollup-mention/);
  });

  it("omits the intent block for plain peer-comparison questions", () => {
    const out = formatDimensionHierarchiesBlock(ctxFor("rank products"));
    assert.match(out, /DIMENSION HIERARCHIES/);
    assert.doesNotMatch(out, /DETECTED INTENT/);
  });
});
