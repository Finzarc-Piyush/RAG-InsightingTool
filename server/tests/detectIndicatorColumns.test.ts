/**
 * Wave SU-IC1 · indicator-column detector tests.
 *
 * Pin the contract: the heuristic catches the Marico screenshot's
 * indicator columns from a 50-row sample, picks the right kind +
 * polarity partition, rejects non-indicator categoricals, and skips
 * numeric / date / time-of-day columns.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  detectIndicatorColumns,
  applyIndicatorsToSummary,
} from "../lib/detectIndicatorColumns.js";
import type { DataSummary } from "../shared/schema.js";

function makeSummary(
  cols: Array<{ name: string; type: string; timeOfDay?: { sentinelValues?: string[] } }>,
  numericColumns: string[] = [],
  dateColumns: string[] = []
): DataSummary {
  return {
    rowCount: 50,
    columnCount: cols.length,
    columns: cols.map((c) => ({
      name: c.name,
      type: c.type,
      sampleValues: [],
      ...(c.timeOfDay !== undefined ? { timeOfDay: c.timeOfDay } : {}),
    })),
    numericColumns,
    dateColumns,
  };
}

function repeat<T>(values: T[], count: number): T[] {
  const out: T[] = [];
  while (out.length < count) {
    for (const v of values) {
      if (out.length >= count) break;
      out.push(v);
    }
  }
  return out;
}

describe("Wave SU-IC1 · detectIndicatorColumns", () => {
  it("picks the Marico screenshot's indicator columns from a 50-row sample", () => {
    const summary = makeSummary(
      [
        { name: "TSO_TSE Name", type: "text" },
        { name: "Clock-In <09:30", type: "text" },
        { name: "Compliance Visit", type: "text" },
        { name: "Attn Status", type: "text" },
        { name: "PJP Adherence", type: "text" },
        { name: "Total Visited OL's", type: "number" },
      ],
      ["Total Visited OL's"]
    );
    const yesNo = repeat(["Yes", "No", "Absent"], 50);
    const yesNoOnly = repeat(["Yes", "No"], 50);
    const attn = repeat(["Present", "Absent", "Leave"], 50);
    const adher = repeat(["Adherent", "Non-Adherent"], 50);
    const data = yesNo.map((v, i) => ({
      "TSO_TSE Name": `Person ${i % 24}`,
      "Clock-In <09:30": v,
      "Compliance Visit": yesNoOnly[i],
      "Attn Status": attn[i],
      "PJP Adherence": adher[i],
      "Total Visited OL's": i,
    }));
    const indicators = detectIndicatorColumns({ summary, data });
    const byCol = new Map(indicators.map((i) => [i.column, i]));

    // All four indicator columns detected; the entity name + numeric are
    // skipped.
    assert.equal(indicators.length, 4);
    assert.deepEqual(
      indicators.map((i) => i.column).sort(),
      [
        "Attn Status",
        "Clock-In <09:30",
        "Compliance Visit",
        "PJP Adherence",
      ]
    );

    // Yes/No → boolean shape with sentinel detected.
    const clockIn = byCol.get("Clock-In <09:30")!;
    assert.equal(clockIn.kind, "boolean");
    assert.deepEqual(clockIn.positiveValues, ["Yes"]);
    assert.deepEqual(clockIn.negativeValues, ["No"]);
    assert.deepEqual(clockIn.sentinelValues, ["Absent"]);

    // Present/Absent/Leave → categorical (only Present and Absent are in
    // the dictionary; Leave isn't).
    const attnStatus = byCol.get("Attn Status")!;
    assert.equal(attnStatus.kind, "categorical");

    // Adherent/Non-Adherent → boolean shape via dictionary.
    const adherCol = byCol.get("PJP Adherence")!;
    assert.equal(adherCol.kind, "boolean");
    assert.deepEqual(adherCol.positiveValues, ["Adherent"]);
    assert.deepEqual(adherCol.negativeValues, ["Non-Adherent"]);
  });

  it("rejects a 5-bucket categorical that's not an indicator", () => {
    const summary = makeSummary([{ name: "Region", type: "text" }]);
    const data = repeat(["North", "South", "East", "West", "Central"], 50).map(
      (r) => ({ Region: r })
    );
    const indicators = detectIndicatorColumns({ summary, data });
    assert.deepEqual(indicators, []);
  });

  it("admits a name-pattern match even when values are not in the dictionary", () => {
    const summary = makeSummary([{ name: "Compliance Status", type: "text" }]);
    // Only 4 distinct values, not in the polarity dictionary, but the
    // column name carries "Status" + "Compliance".
    const data = repeat(["Bronze", "Silver", "Gold", "Platinum"], 50).map(
      (v) => ({ "Compliance Status": v })
    );
    const indicators = detectIndicatorColumns({ summary, data });
    assert.equal(indicators.length, 1);
    assert.equal(indicators[0].column, "Compliance Status");
    assert.equal(indicators[0].kind, "categorical");
  });

  it("skips numeric columns (even when 0/1 binary)", () => {
    const summary = makeSummary(
      [{ name: "IsCompliant", type: "number" }],
      ["IsCompliant"]
    );
    const data = repeat([0, 1], 50).map((v) => ({ IsCompliant: v }));
    const indicators = detectIndicatorColumns({ summary, data });
    assert.deepEqual(indicators, []);
  });

  it("skips date columns", () => {
    const summary = makeSummary(
      [{ name: "Day · Date", type: "date" }],
      [],
      ["Day · Date"]
    );
    const data = [{ "Day · Date": "2024-04-30" }, { "Day · Date": "2024-05-01" }];
    const indicators = detectIndicatorColumns({ summary, data });
    assert.deepEqual(indicators, []);
  });

  it("skips time-of-day columns (TOD1 owns those)", () => {
    const summary = makeSummary([
      {
        name: "Clock-In Time",
        type: "text",
        timeOfDay: { sentinelValues: ["Absent"] },
      },
    ]);
    const data = [
      { "Clock-In Time": "09:00:00" },
      { "Clock-In Time": "Absent" },
    ];
    const indicators = detectIndicatorColumns({ summary, data });
    assert.deepEqual(indicators, []);
  });

  it("rejects mixed-vocabulary value sets below the dictionary hit-rate floor", () => {
    const summary = makeSummary([{ name: "Vendor Tier", type: "text" }]);
    // 5 distinct values, only "Yes" matches the dictionary → 20% hit rate,
    // below the 80% gate. Name has no indicator pattern. Should reject.
    const data = repeat(
      ["Yes", "Bronze", "Silver", "Gold", "Platinum"],
      50
    ).map((v) => ({ "Vendor Tier": v }));
    const indicators = detectIndicatorColumns({ summary, data });
    assert.deepEqual(indicators, []);
  });

  it("honours the cardinality cap", () => {
    const summary = makeSummary([{ name: "Many Values", type: "text" }]);
    const buckets = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];
    const data = repeat(buckets, 100).map((v) => ({ "Many Values": v }));
    const indicators = detectIndicatorColumns({ summary, data });
    assert.deepEqual(indicators, []);
  });

  describe("applyIndicatorsToSummary", () => {
    it("stamps detected indicators onto the per-column meta", () => {
      const summary = makeSummary([
        { name: "Clock-In <09:30", type: "text" },
      ]);
      const indicators = [
        {
          column: "Clock-In <09:30",
          kind: "boolean" as const,
          positiveValues: ["Yes"],
          negativeValues: ["No"],
          sentinelValues: ["Absent"],
          source: "auto" as const,
        },
      ];
      applyIndicatorsToSummary(summary, indicators);
      const col = summary.columns.find((c) => c.name === "Clock-In <09:30");
      assert.ok(col?.indicator);
      assert.equal(col!.indicator!.kind, "boolean");
      assert.equal(col!.indicator!.source, "auto");
      assert.deepEqual(col!.indicator!.positiveValues, ["Yes"]);
    });

    it("preserves user-source indicators (immutability across re-detection)", () => {
      const summary = makeSummary([{ name: "X", type: "text" }]);
      summary.columns[0].indicator = {
        kind: "categorical",
        positiveValues: ["UserSet"],
        source: "user",
      };
      applyIndicatorsToSummary(summary, [
        {
          column: "X",
          kind: "boolean",
          positiveValues: ["Yes"],
          negativeValues: ["No"],
          source: "auto",
        },
      ]);
      // The user-source entry must survive — the H2-style guard.
      assert.equal(summary.columns[0].indicator?.source, "user");
      assert.deepEqual(
        summary.columns[0].indicator?.positiveValues,
        ["UserSet"]
      );
    });
  });
});
