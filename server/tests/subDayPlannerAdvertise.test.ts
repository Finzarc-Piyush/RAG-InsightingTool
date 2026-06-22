// Wave H6 · the planner's derived-time-bucket block must advertise sub-day
// bucketing for intraday columns (temporalResolution === 'sub_day') and stay
// silent for pure-daily columns, plus capabilities must list the sub-day periods.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatDerivedTemporalFacetsBlock } from "../lib/agents/runtime/context.js";
import {
  SUPPORTED_DATE_AGGREGATION_PERIODS,
  TEMPORAL_CAPABILITY_GAPS,
} from "../lib/agentTemporalCapabilities.js";
import type { DataSummary } from "../shared/schema.js";

function summaryWith(resolution: "day" | "sub_day"): DataSummary {
  return {
    rowCount: 100,
    columnCount: 2,
    columns: [
      {
        name: "Stamp",
        type: "date",
        sampleValues: [],
        dateRange: {
          minIso: "2026-06-20",
          maxIso: "2026-06-22",
          distinctDayCount: 3,
          spanDays: 2,
          temporalResolution: resolution,
          distinctHourCount: resolution === "sub_day" ? 8 : 1,
        },
      },
      { name: "Logins", type: "number", sampleValues: [] },
    ],
    numericColumns: ["Logins"],
    dateColumns: ["Stamp"],
    categoricalColumns: [],
  } as unknown as DataSummary;
}

describe("Wave H6 · planner sub-day advertisement", () => {
  it("advertises sub-day bucketing for an intraday column", () => {
    const block = formatDerivedTemporalFacetsBlock(summaryWith("sub_day"));
    assert.match(block, /Intraday columns/);
    assert.match(block, /Hour of day · /);
    assert.match(block, /hour_of_day/);
  });

  it("stays silent for a pure-daily column", () => {
    const block = formatDerivedTemporalFacetsBlock(summaryWith("day"));
    assert.doesNotMatch(block, /Intraday columns/);
    assert.doesNotMatch(block, /hour_of_day/);
  });

  it("capabilities list the sub-day periods and no longer gap them", () => {
    for (const p of ["hour", "hour_of_day", "minute"]) {
      assert.ok((SUPPORTED_DATE_AGGREGATION_PERIODS as readonly string[]).includes(p), p);
    }
    assert.ok(!(TEMPORAL_CAPABILITY_GAPS as readonly string[]).includes("sub_day_grain"));
  });
});
