import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  pickRowLevelDataForQueryPlan,
  promoteQueryPlanDateAggregationToFacetGroupBy,
  temporalFacetGrainFromDateAggregationPeriod,
} from "../lib/queryPlanFacetPromotion.js";
import { canExecuteQueryPlanOnDuckDb } from "../lib/queryPlanDuckdbExecutor.js";
import type { DataSummary } from "../shared/schema.js";
import type { QueryPlanBody } from "../lib/queryPlanExecutor.js";

function minimalSummary(overrides?: Partial<DataSummary>): DataSummary {
  return {
    columns: [
      { name: "Order Date", type: "date" },
      { name: "Sales", type: "number" },
      { name: "Month · Order Date", type: "string" },
    ],
    dateColumns: ["Order Date"],
    numericColumns: ["Sales"],
    ...overrides,
  } as DataSummary;
}

describe("promoteQueryPlanDateAggregationToFacetGroupBy", () => {
  it("rewrites raw date + month period to Month facet and clears period", () => {
    const summary = minimalSummary();
    const plan: QueryPlanBody = {
      groupBy: ["Order Date"],
      dateAggregationPeriod: "month",
      aggregations: [{ column: "Sales", operation: "sum" }],
    };
    const out = promoteQueryPlanDateAggregationToFacetGroupBy(plan, summary);
    assert.deepEqual(out.groupBy, ["Month · Order Date"]);
    assert.equal(out.dateAggregationPeriod, undefined);
    assert.equal(out.aggregations?.[0]?.column, "Sales");
  });

  it("leaves plan unchanged when groupBy date is not the summary date dimension (no facet binding)", () => {
    const summary = minimalSummary({
      columns: [
        { name: "Order Date", type: "date" },
        { name: "Sales", type: "number" },
      ],
      dateColumns: ["Ship Date"],
    });
    const plan: QueryPlanBody = {
      groupBy: ["Order Date"],
      dateAggregationPeriod: "month",
      aggregations: [{ column: "Sales", operation: "sum" }],
    };
    const out = promoteQueryPlanDateAggregationToFacetGroupBy(plan, summary);
    assert.deepEqual(out.groupBy, ["Order Date"]);
    assert.equal(out.dateAggregationPeriod, "month");
  });

  it("maps monthOnly to month grain", () => {
    assert.equal(temporalFacetGrainFromDateAggregationPeriod("monthOnly"), "month");
  });
});

describe("canExecuteQueryPlanOnDuckDb after promotion", () => {
  it("returns true for promoted trend-shaped plan", () => {
    const summary = minimalSummary();
    const raw: QueryPlanBody = {
      groupBy: ["Order Date"],
      dateAggregationPeriod: "month",
      aggregations: [{ column: "Sales", operation: "sum" }],
    };
    const promoted = promoteQueryPlanDateAggregationToFacetGroupBy(raw, summary);
    assert.equal(canExecuteQueryPlanOnDuckDb(promoted), true);
  });

  it("returns false before promotion when period is set", () => {
    const raw: QueryPlanBody = {
      groupBy: ["Order Date"],
      dateAggregationPeriod: "month",
      aggregations: [{ column: "Sales", operation: "sum" }],
    };
    assert.equal(canExecuteQueryPlanOnDuckDb(raw), false);
  });
});

describe("pickRowLevelDataForQueryPlan", () => {
  it("uses turnStartDataRef when groupBy column missing on current frame", () => {
    const plan: QueryPlanBody = {
      groupBy: ["Month · Order Date"],
      aggregations: [{ column: "Sales", operation: "sum" }],
    };
    const current = [{ Sales_sum: 1.2e6 }];
    const turnStart = [{ "Month · Order Date": "2019-01", Sales: 100 }];
    const picked = pickRowLevelDataForQueryPlan(plan, current, turnStart);
    assert.strictEqual(picked, turnStart);
  });

  it("keeps current data when columns present", () => {
    const plan: QueryPlanBody = {
      groupBy: ["Month · Order Date"],
      aggregations: [{ column: "Sales", operation: "sum" }],
    };
    const current = [{ "Month · Order Date": "2019-01", Sales: 50 }];
    const turnStart = [{ "Month · Order Date": "2019-02", Sales: 100 }];
    const picked = pickRowLevelDataForQueryPlan(plan, current, turnStart);
    assert.strictEqual(picked, current);
  });
});
