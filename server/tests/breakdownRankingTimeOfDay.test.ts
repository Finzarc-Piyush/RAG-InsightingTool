import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { aggregate } from "../lib/agents/runtime/tools/breakdownRankingTool.js";
import { formatSecondsAsClock } from "../lib/durationColumns.js";

/**
 * DUR1 · run_breakdown_ranking must compute a real AVERAGE for a time-of-day
 * metric ("Clock-In Time"). Pre-fix, the HH:MM:SS strings failed numericValue
 * and every group averaged to 0; the tool now coerces them to
 * seconds-since-midnight (metricIsTimeOfDay) so the mean is meaningful and
 * renders back as a clock.
 */
describe("breakdown ranking · time-of-day metric averaging", () => {
  const rows = [
    { HQ: "North", "Clock-In Time": "09:00:00" },
    { HQ: "North", "Clock-In Time": "10:00:00" }, // North avg 09:30
    { HQ: "South", "Clock-In Time": "08:30:00" },
    { HQ: "South", "Clock-In Time": "08:30:00" }, // South avg 08:30
    { HQ: "South", "Clock-In Time": "Absent" }, // sentinel → excluded
  ];

  it("averages HH:MM:SS as seconds-since-midnight (not 0)", () => {
    const m = aggregate(rows, "HQ", "Clock-In Time", "mean", true);
    const north = m.get("North")!;
    const south = m.get("South")!;
    assert.equal(north.sum / north.count, 9.5 * 3600); // 09:30 in seconds
    assert.equal(south.count, 2); // "Absent" excluded
    assert.equal(south.sum / south.count, 8.5 * 3600); // 08:30
    // …which renders back as a clock for the narrator/table.
    assert.equal(formatSecondsAsClock(north.sum / north.count), "09:30");
    assert.equal(formatSecondsAsClock(south.sum / south.count), "08:30");
  });

  it("without the time-of-day flag the same strings average to 0 (the bug)", () => {
    const m = aggregate(rows, "HQ", "Clock-In Time", "mean", false);
    const north = m.get("North")!;
    assert.equal(north.count, 0); // strings fail numericValue
    assert.equal(north.count > 0 ? north.sum / north.count : 0, 0);
  });
});
