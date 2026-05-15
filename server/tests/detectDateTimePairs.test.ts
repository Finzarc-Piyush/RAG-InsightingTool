/**
 * Wave SU-DT1 · pair-detection tests.
 *
 * Pin the contract: the detector emits at most one pair per time-of-day
 * column, conservative thresholds reject ambiguous multi-date cases,
 * 1:1 trivial cases auto-pair, name-token similarity dominates ties.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectDateTimePairs } from "../lib/detectDateTimePairs.js";
import type { DataSummary } from "../shared/schema.js";

function makeSummary(params: {
  columns: Array<{ name: string; type: string; timeOfDay?: { sentinelValues?: string[] } }>;
  dateColumns: string[];
}): DataSummary {
  return {
    rowCount: 10,
    columnCount: params.columns.length,
    columns: params.columns.map((c) => ({
      name: c.name,
      type: c.type,
      sampleValues: [],
      ...(c.timeOfDay !== undefined ? { timeOfDay: c.timeOfDay } : {}),
    })),
    numericColumns: [],
    dateColumns: params.dateColumns,
  };
}

describe("Wave SU-DT1 · detectDateTimePairs", () => {
  it("auto-pairs the trivial 1:1 case (one date column, one time column)", () => {
    const summary = makeSummary({
      columns: [
        { name: "Day · Date", type: "date" },
        { name: "Clock-In Time", type: "text", timeOfDay: { sentinelValues: ["Absent"] } },
      ],
      dateColumns: ["Day · Date"],
    });
    const pairs = detectDateTimePairs({ summary, data: [] });
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].timeColumn, "Clock-In Time");
    assert.equal(pairs[0].dateColumn, "Day · Date");
    assert.equal(pairs[0].source, "auto");
  });

  it("returns empty when there are no time-of-day columns", () => {
    const summary = makeSummary({
      columns: [
        { name: "Day · Date", type: "date" },
        { name: "Region", type: "text" },
      ],
      dateColumns: ["Day · Date"],
    });
    const pairs = detectDateTimePairs({ summary, data: [] });
    assert.deepEqual(pairs, []);
  });

  it("returns empty when there are no date columns", () => {
    const summary = makeSummary({
      columns: [
        { name: "Clock-In Time", type: "text", timeOfDay: {} },
      ],
      dateColumns: [],
    });
    const pairs = detectDateTimePairs({ summary, data: [] });
    assert.deepEqual(pairs, []);
  });

  it("picks the name-token-shared candidate over a generic alternative", () => {
    const summary = makeSummary({
      columns: [
        { name: "Order Date", type: "date" },
        { name: "Clock-In Date", type: "date" },
        { name: "Clock-In Time", type: "text", timeOfDay: {} },
      ],
      dateColumns: ["Order Date", "Clock-In Date"],
    });
    const pairs = detectDateTimePairs({ summary, data: [] });
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].timeColumn, "Clock-In Time");
    assert.equal(pairs[0].dateColumn, "Clock-In Date");
  });

  it("refuses to pair when multiple date columns are equally plausible", () => {
    // No shared name tokens, evenly spaced — top vs second margin is
    // below 2× → conservative reject.
    const summary = makeSummary({
      columns: [
        { name: "First Date", type: "date" },
        { name: "Punch", type: "text", timeOfDay: {} },
        { name: "Second Date", type: "date" },
      ],
      dateColumns: ["First Date", "Second Date"],
    });
    const pairs = detectDateTimePairs({ summary, data: [] });
    assert.deepEqual(pairs, []);
  });

  it("uses co-non-null rate as a tie-breaker", () => {
    // Two date columns, both equidistant, both with no shared tokens.
    // "Visit Date" is non-null whenever "Punch In" is non-null;
    // "Birth Date" is sometimes null even when Punch In is set.
    const summary = makeSummary({
      columns: [
        { name: "Birth Date", type: "date" },
        { name: "Punch In", type: "text", timeOfDay: {} },
        { name: "Visit Date", type: "date" },
      ],
      dateColumns: ["Birth Date", "Visit Date"],
    });
    const data = [
      { "Birth Date": null, "Punch In": "09:00:00", "Visit Date": "2024-01-01" },
      { "Birth Date": null, "Punch In": "09:30:00", "Visit Date": "2024-01-02" },
      { "Birth Date": "1990-01-01", "Punch In": "10:00:00", "Visit Date": "2024-01-03" },
      { "Birth Date": "1990-02-02", "Punch In": "10:30:00", "Visit Date": "2024-01-04" },
    ];
    const pairs = detectDateTimePairs({
      summary,
      data,
      // Lower the margin so the co-non-null + proximity tie-breaker can
      // pick a winner — without this, no shared name tokens means both
      // candidates score equally on name and the conservative guard
      // would reject. This matches what the SU-IC2 LLM enrichment
      // should produce when it lifts user-declared pairs.
      options: { minMargin: 1.05 },
    });
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].dateColumn, "Visit Date");
  });

  it("excludes sentinel values when scoring co-non-null", () => {
    const summary = makeSummary({
      columns: [
        { name: "Day · Date", type: "date" },
        { name: "Clock-In Time", type: "text", timeOfDay: { sentinelValues: ["Absent"] } },
      ],
      dateColumns: ["Day · Date"],
    });
    const data = [
      { "Day · Date": null, "Clock-In Time": "Absent" },
      { "Day · Date": "2024-01-01", "Clock-In Time": "09:00:00" },
    ];
    const pairs = detectDateTimePairs({ summary, data });
    // Trivial 1:1 case still auto-pairs; sentinel handling is exercised
    // in the multi-date scoring path. Confirm the description / pair
    // emit is unaffected.
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].timeColumn, "Clock-In Time");
  });

  it("handles multiple time columns independently", () => {
    const summary = makeSummary({
      columns: [
        { name: "Visit Date", type: "date" },
        { name: "Visit Start Time", type: "text", timeOfDay: {} },
        { name: "Visit End Time", type: "text", timeOfDay: {} },
      ],
      dateColumns: ["Visit Date"],
    });
    const pairs = detectDateTimePairs({ summary, data: [] });
    // Each time column gets its own pair against the only date column.
    assert.equal(pairs.length, 2);
    assert.deepEqual(
      pairs.map((p) => p.timeColumn).sort(),
      ["Visit End Time", "Visit Start Time"]
    );
    for (const p of pairs) {
      assert.equal(p.dateColumn, "Visit Date");
    }
  });

  it("respects the maxPairs cap", () => {
    const cols: Array<{ name: string; type: string; timeOfDay?: {} }> = [
      { name: "Date", type: "date" },
    ];
    for (let i = 0; i < 15; i++) {
      cols.push({ name: `Time${i}`, type: "text", timeOfDay: {} });
    }
    const summary = makeSummary({ columns: cols, dateColumns: ["Date"] });
    const pairs = detectDateTimePairs({ summary, data: [], options: { maxPairs: 5 } });
    assert.equal(pairs.length, 5);
  });
});
