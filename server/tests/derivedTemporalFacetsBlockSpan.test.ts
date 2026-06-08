/**
 * Wave T4 · the planner's derived-temporal-facets block now shows each date
 * source column's span and the span-recommended trend grain, so the LLM stops
 * blindly grouping a single-month daily dataset by Month · Date.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatDerivedTemporalFacetsBlock } from "../lib/agents/runtime/context.js";
import type { DataSummary } from "../shared/schema.js";

function summary(dateRange?: {
  minIso: string;
  maxIso: string;
  distinctDayCount: number;
  spanDays: number;
}): DataSummary {
  return {
    rowCount: 30,
    columnCount: 2,
    columns: [
      { name: "Date", type: "date", sampleValues: [], ...(dateRange ? { dateRange } : {}) },
      { name: "Sales", type: "number", sampleValues: [] },
    ],
    numericColumns: ["Sales"],
    dateColumns: ["Date"],
  } as unknown as DataSummary;
}

describe("Wave T4 · formatDerivedTemporalFacetsBlock span hint", () => {
  it("emits the span + recommended Day grain for a single-month daily dataset", () => {
    const block = formatDerivedTemporalFacetsBlock(
      summary({ minIso: "2026-04-01", maxIso: "2026-04-30", distinctDayCount: 30, spanDays: 29 }),
    );
    assert.match(block, /2026-04-01 → 2026-04-30/);
    assert.match(block, /30 day\(s\)/);
    assert.match(block, /prefer `Day · Date`/);
    // The per-grain facet list is still present.
    assert.match(block, /Month · Date \(month of "Date"\)/);
  });

  it("recommends Month grain for a multi-year span", () => {
    const block = formatDerivedTemporalFacetsBlock(
      summary({ minIso: "2023-01-01", maxIso: "2025-12-31", distinctDayCount: 1000, spanDays: 365 * 3 }),
    );
    assert.match(block, /prefer `Month · Date`/);
  });

  it("omits the recommendation header when no dateRange exists", () => {
    const block = formatDerivedTemporalFacetsBlock(summary());
    assert.doesNotMatch(block, /prefer `/);
    assert.doesNotMatch(block, /day\(s\)/);
    // Facet list itself is still emitted.
    assert.match(block, /Day · Date \(date of "Date"\)/);
  });
});
