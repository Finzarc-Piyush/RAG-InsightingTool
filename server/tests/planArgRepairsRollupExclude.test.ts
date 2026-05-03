import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { injectRollupExcludeFilters } from "../lib/agents/runtime/planArgRepairs.js";
import type { PlanStep } from "../lib/agents/runtime/types.js";
import type { DimensionHierarchy } from "../shared/schema.js";

const PRODUCTS_HIERARCHY: DimensionHierarchy = {
  column: "Products",
  rollupValue: "FEMALE SHOWER GEL",
  itemValues: ["MARICO", "PURITE", "OLIV", "LASHE"],
  source: "user",
};

describe("H3 · injectRollupExcludeFilters — execute_query_plan", () => {
  it("appends not_in filter when groupBy includes the hierarchy column", () => {
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
      "What are total sales by product?"
    );
    assert.deepEqual(injected, ["Products=FEMALE SHOWER GEL"]);
    const filters = (step.args as any).plan.dimensionFilters;
    assert.equal(filters.length, 1);
    assert.equal(filters[0].column, "Products");
    assert.equal(filters[0].op, "not_in");
    assert.deepEqual(filters[0].values, ["FEMALE SHOWER GEL"]);
    assert.equal(filters[0].match, "case_insensitive");
  });

  it("skips when user question mentions the rollup value (override-by-mention)", () => {
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
      "Show me FEMALE SHOWER GEL split by Markets"
    );
    assert.deepEqual(injected, []);
    assert.equal((step.args as any).plan.dimensionFilters, undefined);
  });

  it("case-insensitive override-by-mention", () => {
    const step: PlanStep = {
      id: "s1",
      tool: "execute_query_plan",
      args: {
        plan: { groupBy: ["Products"], aggregations: [] },
      },
    };
    const injected = injectRollupExcludeFilters(
      step,
      [PRODUCTS_HIERARCHY],
      "what is the female shower gel total compared to last year?"
    );
    assert.deepEqual(injected, []);
  });

  it("skips when an existing in-filter already includes the rollup value (explicit user-driven inclusion)", () => {
    const step: PlanStep = {
      id: "s1",
      tool: "execute_query_plan",
      args: {
        plan: {
          groupBy: ["Products"],
          dimensionFilters: [
            { column: "Products", op: "in", values: ["FEMALE SHOWER GEL", "MARICO"] },
          ],
        },
      },
    };
    const injected = injectRollupExcludeFilters(step, [PRODUCTS_HIERARCHY], "compare products");
    assert.deepEqual(injected, []);
    const filters = (step.args as any).plan.dimensionFilters;
    assert.equal(filters.length, 1);
    assert.equal(filters[0].op, "in");
  });

  it("skips when an existing not_in-filter already excludes the rollup value", () => {
    const step: PlanStep = {
      id: "s1",
      tool: "execute_query_plan",
      args: {
        plan: {
          groupBy: ["Products"],
          dimensionFilters: [
            { column: "Products", op: "not_in", values: ["FEMALE SHOWER GEL"] },
          ],
        },
      },
    };
    const injected = injectRollupExcludeFilters(step, [PRODUCTS_HIERARCHY], "compare products");
    assert.deepEqual(injected, []);
    const filters = (step.args as any).plan.dimensionFilters;
    assert.equal(filters.length, 1);
  });

  it("preserves unrelated existing dimensionFilters", () => {
    const step: PlanStep = {
      id: "s1",
      tool: "execute_query_plan",
      args: {
        plan: {
          groupBy: ["Products"],
          dimensionFilters: [
            { column: "Markets", op: "in", values: ["VN-North"] },
          ],
        },
      },
    };
    const injected = injectRollupExcludeFilters(step, [PRODUCTS_HIERARCHY], "rank products");
    assert.deepEqual(injected, ["Products=FEMALE SHOWER GEL"]);
    const filters = (step.args as any).plan.dimensionFilters;
    assert.equal(filters.length, 2);
    assert.equal(filters[0].column, "Markets");
    assert.equal(filters[1].column, "Products");
    assert.equal(filters[1].op, "not_in");
  });

  it("no-op when groupBy does not include the hierarchy column", () => {
    const step: PlanStep = {
      id: "s1",
      tool: "execute_query_plan",
      args: { plan: { groupBy: ["Markets"] } },
    };
    const injected = injectRollupExcludeFilters(step, [PRODUCTS_HIERARCHY], "sales by market");
    assert.deepEqual(injected, []);
    assert.equal((step.args as any).plan.dimensionFilters, undefined);
  });
});

describe("H3 · injectRollupExcludeFilters — breakdown_ranking", () => {
  it("appends not_in filter when breakdownColumn is the hierarchy column", () => {
    const step: PlanStep = {
      id: "s1",
      tool: "breakdown_ranking",
      args: {
        metricColumn: "Total_Sales_Value",
        breakdownColumn: "Products",
      },
    };
    const injected = injectRollupExcludeFilters(
      step,
      [PRODUCTS_HIERARCHY],
      "rank the products by sales"
    );
    assert.deepEqual(injected, ["Products=FEMALE SHOWER GEL"]);
    const filters = (step.args as any).dimensionFilters;
    assert.equal(filters.length, 1);
    assert.equal(filters[0].column, "Products");
    assert.equal(filters[0].op, "not_in");
    assert.deepEqual(filters[0].values, ["FEMALE SHOWER GEL"]);
  });

  it("no-op when breakdownColumn is not in the hierarchy", () => {
    const step: PlanStep = {
      id: "s1",
      tool: "breakdown_ranking",
      args: { metricColumn: "Total_Sales_Value", breakdownColumn: "Markets" },
    };
    const injected = injectRollupExcludeFilters(step, [PRODUCTS_HIERARCHY], "sales by market");
    assert.deepEqual(injected, []);
  });
});

describe("H3 · injectRollupExcludeFilters — guards", () => {
  it("no-op when no hierarchies declared", () => {
    const step: PlanStep = {
      id: "s1",
      tool: "execute_query_plan",
      args: { plan: { groupBy: ["Products"] } },
    };
    assert.deepEqual(injectRollupExcludeFilters(step, undefined, "any"), []);
    assert.deepEqual(injectRollupExcludeFilters(step, [], "any"), []);
  });

  it("no-op for tools that don't take dimensionFilters", () => {
    const step: PlanStep = {
      id: "s1",
      tool: "describe_columns",
      args: {},
    };
    assert.deepEqual(injectRollupExcludeFilters(step, [PRODUCTS_HIERARCHY], "q"), []);
  });
});
