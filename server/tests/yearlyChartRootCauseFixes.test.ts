import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveDateBucketForGroupBy } from "../lib/dataTransform.js";
import {
  executeQueryPlan,
  validateCoarseDateAggregationOutput,
} from "../lib/queryPlanExecutor.js";
import type { DataSummary } from "../shared/schema.js";
import type { ParsedQuery } from "../shared/queryTypes.js";

describe("resolveDateBucketForGroupBy", () => {
  it("enables year bucketing when column is missing from dateColumns but values parse as dates", () => {
    const summary: DataSummary = {
      rowCount: 200,
      columnCount: 2,
      columns: [
        { name: "Order Date", type: "string", sampleValues: ["1/1/15"] },
        { name: "Sales", type: "number", sampleValues: [1] },
      ],
      numericColumns: ["Sales"],
      dateColumns: [],
    };
    const data: Record<string, unknown>[] = [];
    for (let i = 0; i < 120; i++) {
      data.push({
        "Order Date": `${(i % 28) + 1}/${(i % 12) + 1}/2015`,
        Sales: i + 1,
      });
    }
    const r = resolveDateBucketForGroupBy(
      "Order Date",
      summary,
      data as Record<string, any>[],
      "year"
    );
    assert.equal(r.mode, "schema");
    assert.equal(r.readColumn, "Order Date");
  });
});

describe("validateCoarseDateAggregationOutput", () => {
  it("flags year plan with thousands of output groups", () => {
    const parsed: ParsedQuery = {
      rawQuestion: "",
      groupBy: ["Order Date"],
      dateAggregationPeriod: "year",
      aggregations: [{ column: "Sales", operation: "sum" }],
    };
    const msg = validateCoarseDateAggregationOutput(parsed, 5000, 1230);
    assert.ok(msg);
    assert.match(msg!, /SYSTEM_VALIDATION/);
    assert.match(msg!, /year/);
  });

  it("allows year plan with a small group count", () => {
    const parsed: ParsedQuery = {
      rawQuestion: "",
      groupBy: ["Order Date"],
      dateAggregationPeriod: "year",
      aggregations: [{ column: "Sales", operation: "sum" }],
    };
    assert.equal(validateCoarseDateAggregationOutput(parsed, 5000, 4), null);
  });

  it("does not reject month plans when groupBy already uses __tf_month__ facet columns", () => {
    const parsed: ParsedQuery = {
      rawQuestion: "",
      groupBy: ["__tf_month__Order_Date"],
      dateAggregationPeriod: "month",
      aggregations: [{ column: "Sales", operation: "sum" }],
    };

    // Output group count above the current cap can be legitimate when using
    // precomputed month facets (e.g. datasets spanning long time ranges).
    assert.equal(validateCoarseDateAggregationOutput(parsed, 9800, 1230), null);
  });
});

describe("executeQueryPlan year bucketing with string dates and empty dateColumns", () => {
  it("returns few rows for multi-year daily ISO strings when dateColumns is empty", () => {
    const summary: DataSummary = {
      rowCount: 400,
      columnCount: 2,
      columns: [
        { name: "Order Date", type: "string", sampleValues: [] },
        { name: "Sales", type: "number", sampleValues: [1] },
      ],
      numericColumns: ["Sales"],
      dateColumns: [],
    };
    const data: Record<string, unknown>[] = [];
    for (let t = Date.UTC(2015, 0, 1); t < Date.UTC(2019, 0, 1); t += 86400000 * 2) {
      data.push({
        "Order Date": new Date(t).toISOString().slice(0, 10),
        Sales: 1,
      });
    }
    const out = executeQueryPlan(data as Record<string, any>[], summary, {
      groupBy: ["Order Date"],
      dateAggregationPeriod: "year",
      aggregations: [{ column: "Sales", operation: "sum" }],
    });
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.ok(
      out.data.length <= 8,
      `expected at most 8 year buckets, got ${out.data.length}`
    );
  });
});
