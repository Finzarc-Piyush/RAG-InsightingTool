/**
 * Wave QL9.C · `buildChartFromAnalyticalTable` skips pure-scalar results.
 *
 * A 1-row result has no meaningful x-axis. Auto-promoting it to a bar
 * chart picks one numeric column as x and another as y, producing the
 * confusing "num_days=30 on X, avg=3.5K on Y" single bar the user saw on
 * the Marico-VN scalar question. The fix: return null when rows.length === 1.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildChartFromAnalyticalTable } from "../lib/agents/runtime/chartFromTable.js";
import type { DataSummary } from "../shared/schema.js";

function summary(): DataSummary {
  return {
    rowCount: 12,
    columnCount: 3,
    columns: [
      { name: "Compliance Visit", type: "number", sampleValues: [] },
      { name: "Date", type: "date", sampleValues: [] },
      { name: "Cluster Name", type: "string", sampleValues: [] },
    ],
    numericColumns: ["Compliance Visit"],
    dateColumns: ["Date"],
  };
}

describe("Wave QL9.C · buildChartFromAnalyticalTable scalar guard", () => {
  it("returns null for a 1-row QL7 ratio result (3 numerics, 0 dimensions)", () => {
    const chart = buildChartFromAnalyticalTable({
      table: {
        columns: [
          "total_compliance_visit",
          "num_distinct_date",
          "avg_compliance_visit_per_date",
        ],
        rows: [
          {
            total_compliance_visit: 104870,
            num_distinct_date: 30,
            avg_compliance_visit_per_date: 3495.67,
          },
        ],
      },
      summary: summary(),
      question: "average compliance visits per day",
    });
    assert.equal(chart, null);
  });

  it("returns null for a 1-row result even when one column is a string (no meaningful trend)", () => {
    const chart = buildChartFromAnalyticalTable({
      table: {
        columns: ["Cluster Name", "total_visits"],
        rows: [{ "Cluster Name": "Cluster 1 EAST", total_visits: 4200 }],
      },
      summary: summary(),
      question: "total visits for cluster 1 east",
    });
    assert.equal(chart, null);
  });

  it("STILL builds a chart for multi-row results with one dim + one measure", () => {
    const chart = buildChartFromAnalyticalTable({
      table: {
        columns: ["Cluster Name", "total_visits"],
        rows: [
          { "Cluster Name": "A", total_visits: 5000 },
          { "Cluster Name": "B", total_visits: 4200 },
          { "Cluster Name": "C", total_visits: 3500 },
        ],
      },
      summary: summary(),
      question: "total visits by cluster",
    });
    assert.ok(chart, "multi-row chart should still build");
    assert.equal(chart!.x, "Cluster Name");
    assert.equal(chart!.y, "total_visits");
  });
});
