import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  injectRollupExcludeFilters,
  classifyHierarchyIntent,
} from "../lib/agents/runtime/planArgRepairs.js";
import { formatDimensionHierarchiesBlock } from "../lib/agents/runtime/context.js";
import type { PlanStep, AgentExecutionContext } from "../lib/agents/runtime/types.js";
import type { DimensionHierarchy, DataSummary } from "../shared/schema.js";

// 3-level Geography hierarchy in the same column.
const GEO_HIERARCHIES: DimensionHierarchy[] = [
  {
    column: "Geography",
    rollupValue: "World",
    itemValues: ["Asia", "Europe", "Americas"],
    source: "user",
  },
  {
    column: "Geography",
    rollupValue: "Asia",
    itemValues: ["India", "China", "Japan"],
    source: "user",
  },
  {
    column: "Geography",
    rollupValue: "India",
    itemValues: ["Mumbai", "Delhi", "Bengaluru"],
    source: "user",
  },
];

describe("ML1 · multi-level same-column hierarchies", () => {
  it("excludes ALL rollup values for a column when groupBy includes it", () => {
    const step: PlanStep = {
      id: "s1",
      tool: "execute_query_plan",
      args: {
        plan: {
          groupBy: ["Geography"],
          aggregations: [{ column: "Sales", operation: "sum" }],
        },
      },
    };
    const injected = injectRollupExcludeFilters(
      step,
      GEO_HIERARCHIES,
      "rank geographies by sales",
    );
    assert.deepEqual(
      injected.sort(),
      ["Geography=Asia", "Geography=India", "Geography=World"],
    );
    const filters = (step.args as any).plan.dimensionFilters;
    assert.equal(filters.length, 1);
    assert.equal(filters[0].column, "Geography");
    assert.equal(filters[0].op, "not_in");
    assert.deepEqual(
      filters[0].values.sort(),
      ["Asia", "India", "World"],
    );
  });

  it("override-by-mention: user names 'Asia' → keeps Asia, still excludes World + India", () => {
    const step: PlanStep = {
      id: "s1",
      tool: "execute_query_plan",
      args: { plan: { groupBy: ["Geography"] } },
    };
    const injected = injectRollupExcludeFilters(
      step,
      GEO_HIERARCHIES,
      "show me Asia by country",
    );
    // Asia mention skips Asia exclude; World and India still excluded.
    assert.deepEqual(
      injected.sort(),
      ["Geography=India", "Geography=World"],
    );
    const filters = (step.args as any).plan.dimensionFilters;
    assert.equal(filters.length, 1);
    assert.deepEqual(filters[0].values.sort(), ["India", "World"]);
  });

  it("share-of-category override applies to ALL rollups for that column", () => {
    const step: PlanStep = {
      id: "s1",
      tool: "execute_query_plan",
      args: { plan: { groupBy: ["Geography"] } },
    };
    const injected = injectRollupExcludeFilters(
      step,
      GEO_HIERARCHIES,
      "what % of total does each geography contribute?",
    );
    // share-of-category fires for each hierarchy independently → all skipped
    assert.deepEqual(injected, []);
    assert.equal((step.args as any).plan.dimensionFilters, undefined);
  });

  it("classifyHierarchyIntent reports per-rollup intent", () => {
    const out = classifyHierarchyIntent(
      "show me Asia broken down by country",
      GEO_HIERARCHIES,
    );
    const byRollup = Object.fromEntries(
      out.map((i) => [i.rollupValue, i.intent]),
    );
    assert.equal(byRollup.Asia, "rollup-mention");
    assert.equal(byRollup.World, "peer-comparison");
    assert.equal(byRollup.India, "peer-comparison");
  });

  it("doesn't double-add when one of the rollups already in existing not_in filter", () => {
    const step: PlanStep = {
      id: "s1",
      tool: "execute_query_plan",
      args: {
        plan: {
          groupBy: ["Geography"],
          dimensionFilters: [
            { column: "Geography", op: "not_in", values: ["World"] },
          ],
        },
      },
    };
    const injected = injectRollupExcludeFilters(
      step,
      GEO_HIERARCHIES,
      "rank geographies by sales",
    );
    // World already excluded; Asia and India still need adding
    assert.deepEqual(injected.sort(), ["Geography=Asia", "Geography=India"]);
    const filters = (step.args as any).plan.dimensionFilters;
    // Existing "World" filter preserved + new "Asia,India" filter appended.
    assert.equal(filters.length, 2);
    assert.deepEqual(filters[0].values, ["World"]);
    assert.deepEqual(filters[1].values.sort(), ["Asia", "India"]);
  });
});

describe("ML1 · prompt block lists every level", () => {
  function ctxFor(question: string): AgentExecutionContext {
    const summary: DataSummary = {
      rowCount: 100,
      columnCount: 2,
      columns: [
        { name: "Geography", type: "string", sampleValues: [] },
        { name: "Sales", type: "number", sampleValues: [] },
      ],
      numericColumns: ["Sales"],
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
          dimensionHierarchies: GEO_HIERARCHIES,
        },
        userIntent: { interpretedConstraints: [] },
        sessionKnowledge: { facts: [], analysesDone: [] },
        suggestedFollowUps: [],
        lastUpdated: { reason: "user_context", at: "2026-04-29T00:00:00.000Z" },
      },
    } as AgentExecutionContext;
  }

  it("renders one bullet per rollup level", () => {
    const out = formatDimensionHierarchiesBlock(ctxFor("rank geographies"));
    assert.match(out, /"World"/);
    assert.match(out, /"Asia"/);
    assert.match(out, /"India"/);
    // children listed for each level
    assert.match(out, /Asia, Europe, Americas/);
    assert.match(out, /India, China, Japan/);
    assert.match(out, /Mumbai, Delhi, Bengaluru/);
  });
});

describe("ML1 · cross-column hierarchies (independent per-column entries)", () => {
  it("two columns with independent rollups both get excluded", () => {
    const hierarchies: DimensionHierarchy[] = [
      { column: "Region", rollupValue: "All Regions", source: "user" },
      { column: "Channel", rollupValue: "All Channels", source: "user" },
    ];
    const step: PlanStep = {
      id: "s1",
      tool: "execute_query_plan",
      args: {
        plan: {
          groupBy: ["Region", "Channel"],
          aggregations: [{ column: "Sales", operation: "sum" }],
        },
      },
    };
    const injected = injectRollupExcludeFilters(
      step,
      hierarchies,
      "rank by region and channel",
    );
    assert.deepEqual(
      injected.sort(),
      ["Channel=All Channels", "Region=All Regions"],
    );
    const filters = (step.args as any).plan.dimensionFilters;
    assert.equal(filters.length, 2);
  });
});
