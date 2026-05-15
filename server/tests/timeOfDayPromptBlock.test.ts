import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatTimeOfDayBlock } from "../lib/agents/runtime/context.ts";
import type { DataSummary } from "../shared/schema.js";

const baseSummary: DataSummary = {
  columns: [
    { name: "Cluster Name", type: "string", uniqueValues: 5 },
    { name: "Sales", type: "number", uniqueValues: 50 },
  ],
  numericColumns: ["Sales"],
  dateColumns: [],
  totalRows: 0,
  sampleRows: [],
};

describe("Wave TOD1 · formatTimeOfDayBlock", () => {
  it("returns empty string when no time-of-day columns exist", () => {
    assert.equal(formatTimeOfDayBlock(baseSummary), "");
  });

  it("emits a TIME-OF-DAY block when at least one TOD column exists", () => {
    const summary: DataSummary = {
      ...baseSummary,
      columns: [
        ...baseSummary.columns,
        {
          name: "Clock-In Time",
          type: "string",
          uniqueValues: 100,
          timeOfDay: { sentinelValues: ["Absent"] },
        },
      ],
    };
    const block = formatTimeOfDayBlock(summary);
    assert.match(block, /TIME-OF-DAY columns/);
    assert.match(block, /Clock-In Time/);
    assert.match(block, /Absent/);
    // Surfaces the comparison guidance.
    assert.match(block, /lt|HH:MM:SS/);
  });

  it("lists multiple TOD columns when present", () => {
    const summary: DataSummary = {
      ...baseSummary,
      columns: [
        ...baseSummary.columns,
        {
          name: "Clock-In Time",
          type: "string",
          uniqueValues: 100,
          timeOfDay: { sentinelValues: ["Absent"] },
        },
        {
          name: "Clock-Out Time",
          type: "string",
          uniqueValues: 100,
          timeOfDay: {},
        },
      ],
    };
    const block = formatTimeOfDayBlock(summary);
    assert.match(block, /Clock-In Time/);
    assert.match(block, /Clock-Out Time/);
  });

  it("does not emit a block on TOD-free summaries (no leak)", () => {
    const summary: DataSummary = {
      ...baseSummary,
      columns: [
        { name: "Order Date", type: "date", uniqueValues: 365 },
        { name: "Sales", type: "number", uniqueValues: 50 },
      ],
      dateColumns: ["Order Date"],
    };
    assert.equal(formatTimeOfDayBlock(summary), "");
  });
});
