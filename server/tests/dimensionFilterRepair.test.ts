import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  findUniqueValueColumnMatch,
  repairMisassignedDimensionFilters,
} from "../lib/dimensionFilterRepair.js";
import type { DataSummary } from "../shared/schema.js";
import {
  normalizeAndValidateQueryPlanBody,
  type QueryPlanBody,
} from "../lib/queryPlanExecutor.js";

function sampleSummary(): DataSummary {
  return {
    rowCount: 100,
    columnCount: 4,
    columns: [
      { name: "Sales", type: "number", sampleValues: [] },
      { name: "Segment", type: "string", sampleValues: ["Consumer", "Corporate"] },
      {
        name: "Category",
        type: "string",
        sampleValues: [],
        topValues: [
          { value: "Technology", count: 40 },
          { value: "Furniture", count: 30 },
        ],
      },
      { name: "Region", type: "string", sampleValues: ["West", "East"] },
    ],
    numericColumns: ["Sales"],
    dateColumns: [],
  } as DataSummary;
}

describe("dimensionFilterRepair", () => {
  it("maps mistaken column name Technology to Category when value appears in top_values", () => {
    const summary = sampleSummary();
    const raw = [
      {
        column: "Technology",
        op: "in" as const,
        values: ["Technology"],
      },
    ];
    const repaired = repairMisassignedDimensionFilters(raw, summary);
    assert.equal(repaired?.[0]?.column, "Category");
    assert.deepEqual(repaired?.[0]?.values, ["Technology"]);
    assert.equal(repaired?.[0]?.match, "case_insensitive");
  });

  it("leaves filters unchanged when column is valid", () => {
    const summary = sampleSummary();
    const raw = [
      {
        column: "Category",
        op: "in" as const,
        values: ["Technology"],
      },
    ];
    const repaired = repairMisassignedDimensionFilters(raw, summary);
    assert.deepEqual(repaired?.[0], raw[0]);
  });

  it("findUniqueValueColumnMatch returns null when two columns contain the same token", () => {
    const summary: DataSummary = {
      ...sampleSummary(),
      columns: [
        { name: "Sales", type: "number", sampleValues: [] },
        {
          name: "A",
          type: "string",
          topValues: [{ value: "Dup", count: 1 }],
          sampleValues: [],
        },
        {
          name: "B",
          type: "string",
          topValues: [{ value: "Dup", count: 1 }],
          sampleValues: [],
        },
      ],
    } as DataSummary;
    assert.equal(findUniqueValueColumnMatch(summary, "Dup"), null);
  });

  it("normalizeAndValidateQueryPlanBody repairs bad dimension filter column before assert", () => {
    const summary = sampleSummary();
    const plan: QueryPlanBody = {
      groupBy: ["Segment"],
      aggregations: [{ column: "Sales", operation: "sum" }],
      dimensionFilters: [{ column: "Technology", op: "in", values: ["Technology"] }],
    };
    const v = normalizeAndValidateQueryPlanBody(summary, plan);
    assert.equal(v.ok, true);
    if (v.ok) {
      assert.equal(v.normalizedPlan.dimensionFilters?.[0]?.column, "Category");
    }
  });
});
