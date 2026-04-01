import { test } from "node:test";
import assert from "node:assert/strict";
import { applyVagueTrendDefaultAggregation } from "../lib/queryParserTemporalDefault.js";
import type { DataSummary } from "../shared/schema.js";

test("applyVagueTrendDefaultAggregation sets monthly period for vague trend + aggregation + empty groupBy", () => {
  const summary = { dateColumns: ["Order Date"] } as DataSummary;
  const parsed: Record<string, unknown> = {
    rawQuestion: "What is total sales revenue over time?",
    aggregations: [{ column: "Sales", operation: "sum" as const }],
    groupBy: [],
    confidence: 1,
  };
  applyVagueTrendDefaultAggregation(parsed as any, String(parsed.rawQuestion), summary);
  assert.equal(parsed.dateAggregationPeriod, "month");
  assert.deepEqual(parsed.groupBy, ["Order Date"]);
});

test("applyVagueTrendDefaultAggregation does not override explicit daily intent", () => {
  const summary = { dateColumns: ["Order Date"] } as DataSummary;
  const parsed: Record<string, unknown> = {
    rawQuestion: "daily sales trend over time",
    aggregations: [{ column: "Sales", operation: "sum" as const }],
    groupBy: [],
    confidence: 1,
  };
  applyVagueTrendDefaultAggregation(parsed as any, String(parsed.rawQuestion), summary);
  assert.equal(parsed.dateAggregationPeriod, undefined);
});
