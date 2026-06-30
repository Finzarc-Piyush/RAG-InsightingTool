import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { computePerformanceStanding } = await import(
  "../lib/agents/runtime/performanceStanding.js"
);

const channelTable = {
  columns: ["Channel", "Value"],
  rows: [
    { Channel: "GT", Value: 412 },
    { Channel: "MT", Value: 60 },
    { Channel: "E-com", Value: 25 },
    { Channel: "Q-com", Value: 38 },
  ],
};

describe("B1 · computePerformanceStanding", () => {
  it("ranks a clean channel breakdown leader→laggard with shares", () => {
    const s = computePerformanceStanding(channelTable)!;
    assert.ok(s);
    assert.equal(s.dimension, "Channel");
    assert.equal(s.metric, "Value");
    assert.equal(s.leader.unit, "GT");
    assert.equal(s.laggard.unit, "E-com"); // lowest value (25)
    assert.equal(s.units[0].rank, 1);
    // GT share = 412 / 535 ≈ 77%
    assert.ok(s.leaderSharePct > 75 && s.leaderSharePct < 78);
    assert.equal(s.lowerIsBetter, false);
  });

  it("inverts ranking for lower-is-better metrics (cost)", () => {
    const s = computePerformanceStanding({
      columns: ["Region", "Cost"],
      rows: [
        { Region: "North", Cost: 100 },
        { Region: "South", Cost: 40 },
        { Region: "East", Cost: 70 },
      ],
    })!;
    assert.ok(s);
    assert.equal(s.lowerIsBetter, true);
    assert.equal(s.leader.unit, "South"); // lowest cost wins
    assert.equal(s.laggard.unit, "North");
  });

  it("returns null for a trend frame (date dimension excluded)", () => {
    const s = computePerformanceStanding(
      {
        columns: ["Month", "Value"],
        rows: [
          { Month: "2026-01", Value: 10 },
          { Month: "2026-02", Value: 20 },
          { Month: "2026-03", Value: 30 },
        ],
      },
      { dateColumns: ["Month"] }
    );
    assert.equal(s, null);
  });

  it("returns null when two categorical dimensions make ranking ambiguous", () => {
    const s = computePerformanceStanding({
      columns: ["Channel", "Region", "Value"],
      rows: [
        { Channel: "GT", Region: "North", Value: 10 },
        { Channel: "MT", Region: "South", Value: 20 },
        { Channel: "E-com", Region: "East", Value: 30 },
      ],
    });
    assert.equal(s, null);
  });

  it("returns null with fewer than 3 units", () => {
    assert.equal(
      computePerformanceStanding({
        columns: ["Channel", "Value"],
        rows: [
          { Channel: "GT", Value: 10 },
          { Channel: "Q-com", Value: 5 },
        ],
      }),
      null
    );
  });

  it("ignores rollup/total rows", () => {
    const s = computePerformanceStanding({
      columns: ["Channel", "Value"],
      rows: [
        { Channel: "Total", Value: 535 },
        { Channel: "GT", Value: 412 },
        { Channel: "MT", Value: 60 },
        { Channel: "Q-com", Value: 63 },
      ],
    })!;
    assert.ok(s);
    assert.equal(s.units.length, 3); // Total excluded
    assert.equal(s.leader.unit, "GT");
  });

  it("does not rank by a year/id-looking numeric column", () => {
    // Only numeric column is 'Year' → no valid measure → null.
    const s = computePerformanceStanding({
      columns: ["Brand", "Year"],
      rows: [
        { Brand: "Saffola", Year: 2024 },
        { Brand: "Parachute", Year: 2025 },
        { Brand: "Nihar", Year: 2023 },
      ],
    });
    assert.equal(s, null);
  });
});
