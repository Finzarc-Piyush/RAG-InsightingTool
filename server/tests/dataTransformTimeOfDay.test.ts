import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyQueryTransformations } from "../lib/dataTransform.js";
import type { DataSummary } from "../shared/schema.js";
import type { ParsedQuery } from "../shared/queryTypes.js";

/**
 * TOD-AGG · the generic in-memory aggregation path (used when DuckDB is
 * unavailable) must average a time-of-day ("Clock-In Time") column correctly.
 * Pre-fix it ran `toNumber("09:45:34")` → NaN → every group averaged to 0;
 * it now coerces clock cells to seconds-since-midnight and renders the mean
 * back as "HH:MM", matching the DuckDB executor and breakdownRankingTool.
 */
describe("dataTransform · in-memory time-of-day aggregation", () => {
  const summary = {
    rowCount: 4,
    columnCount: 2,
    columns: [
      { name: "Cluster Name", type: "string", sampleValues: [] },
      {
        name: "Clock-In Time",
        type: "string",
        sampleValues: [],
        timeOfDay: { sentinelValues: ["Absent"] },
      },
    ],
  } as unknown as DataSummary;

  const rows = [
    { "Cluster Name": "North", "Clock-In Time": "09:00:00" },
    { "Cluster Name": "North", "Clock-In Time": "10:00:00" }, // North avg 09:30
    { "Cluster Name": "South", "Clock-In Time": "08:30:00" },
    { "Cluster Name": "South", "Clock-In Time": "Absent" }, // sentinel excluded
  ];

  it("averages HH:MM:SS clock cells back to a clock string (not NaN/0)", () => {
    const out = applyQueryTransformations(rows, summary, {
      groupBy: ["Cluster Name"],
      aggregations: [
        { column: "Clock-In Time", operation: "avg", alias: "avg_clock_in_time" },
      ],
    } as ParsedQuery);
    const byCluster = new Map(
      out.data.map((r) => [r["Cluster Name"], r["avg_clock_in_time"]])
    );
    assert.equal(byCluster.get("North"), "09:30");
    assert.equal(byCluster.get("South"), "08:30"); // "Absent" excluded
  });

  it("does not clock-format a normal numeric average", () => {
    const numSummary = {
      rowCount: 2,
      columnCount: 2,
      columns: [
        { name: "Cluster Name", type: "string", sampleValues: [] },
        { name: "Total PC", type: "number", sampleValues: [] },
      ],
    } as unknown as DataSummary;
    const numRows = [
      { "Cluster Name": "North", "Total PC": 10 },
      { "Cluster Name": "North", "Total PC": 20 },
    ];
    const out = applyQueryTransformations(numRows, numSummary, {
      groupBy: ["Cluster Name"],
      aggregations: [{ column: "Total PC", operation: "avg", alias: "avg_pc" }],
    } as ParsedQuery);
    assert.equal(out.data[0]!["avg_pc"], 15);
  });
});
