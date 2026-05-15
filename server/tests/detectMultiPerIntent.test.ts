/**
 * Wave PD3 · `detectMultiPerIntent` extracts a structured multi-clause
 * intent from the question. Strict: only fires when ≥1 temporal per-clause
 * AND ≥1 dimension per-clause are present (or via adverbial + by-clause).
 * Otherwise returns null and PD1's single-per detector handles the case.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectMultiPerIntent } from "../lib/agents/runtime/planArgRepairs.js";
import type { DataSummary } from "../shared/schema.js";

function summary(extra?: Partial<DataSummary>): Pick<DataSummary, "columns" | "dateColumns"> {
  return {
    columns: [
      { name: "Compliance Visit", type: "number", sampleValues: [] },
      { name: "Sales", type: "number", sampleValues: [] },
      { name: "Cluster Name", type: "string", sampleValues: [] },
      { name: "Region", type: "string", sampleValues: [] },
      { name: "Customer", type: "string", sampleValues: [] },
      { name: "Date", type: "date", sampleValues: [] },
    ],
    dateColumns: ["Date"],
    ...(extra ?? {}),
  };
}

describe("Wave PD3 · detectMultiPerIntent", () => {
  it("fires for the Marico failing scenario: 'average compliance visits per day per cluster'", () => {
    const intent = detectMultiPerIntent(
      "What is the average number of compliance visits per day per cluster",
      summary()
    );
    assert.ok(intent, "intent should be detected");
    assert.equal(intent!.outerOp, "mean");
    assert.equal(intent!.rateDenominator.column, "Day · Date");
    assert.equal(intent!.rateDenominator.sourceColumn, "Date");
    assert.equal(intent!.rateDenominator.grain, "date");
    assert.deepEqual(intent!.groupColumns, ["Cluster Name"]);
  });

  it("fires for 'per day by region' (per + by combined)", () => {
    const intent = detectMultiPerIntent("Average sales per day by region", summary());
    assert.ok(intent);
    assert.equal(intent!.rateDenominator.column, "Day · Date");
    assert.deepEqual(intent!.groupColumns, ["Region"]);
  });

  it("fires for 'by region per day' (order doesn't matter)", () => {
    const intent = detectMultiPerIntent("Average sales by region per day", summary());
    assert.ok(intent);
    assert.equal(intent!.rateDenominator.column, "Day · Date");
    assert.deepEqual(intent!.groupColumns, ["Region"]);
  });

  it("fires for adverbial rate + by-clause: 'daily average sales by region'", () => {
    const intent = detectMultiPerIntent("Daily average sales by region", summary());
    assert.ok(intent);
    assert.equal(intent!.outerOp, "mean");
    assert.equal(intent!.rateDenominator.column, "Day · Date");
    assert.equal(intent!.rateDenominator.grain, "date");
    assert.deepEqual(intent!.groupColumns, ["Region"]);
  });

  it("fires for 'weekly total sales per cluster'", () => {
    const intent = detectMultiPerIntent(
      "Weekly total sales per cluster name",
      summary()
    );
    assert.ok(intent);
    assert.equal(intent!.outerOp, "sum");
    assert.equal(intent!.rateDenominator.column, "Week · Date");
    assert.deepEqual(intent!.groupColumns, ["Cluster Name"]);
  });

  it("supports multiple group dimensions: 'average sales per day per region per customer'", () => {
    const intent = detectMultiPerIntent(
      "Average sales per day per region per customer",
      summary()
    );
    assert.ok(intent);
    assert.equal(intent!.rateDenominator.column, "Day · Date");
    // Both non-temporal per-clauses become group columns
    assert.equal(intent!.groupColumns.length, 2);
    assert.ok(intent!.groupColumns.includes("Region"));
    assert.ok(intent!.groupColumns.includes("Customer"));
  });

  it("returns null for single-per 'average X per day' (PD1 handles it)", () => {
    const intent = detectMultiPerIntent("Average compliance visits per day", summary());
    assert.equal(intent, null);
  });

  it("returns null for single-per 'average X per region' (no temporal, falls back to PD1)", () => {
    const intent = detectMultiPerIntent("Average sales per region", summary());
    assert.equal(intent, null);
  });

  it("returns null for non-per questions: 'sales by region'", () => {
    const intent = detectMultiPerIntent("Show me sales by region", summary());
    assert.equal(intent, null);
  });

  it("returns null when both per-clauses are temporal (ambiguous)", () => {
    const intent = detectMultiPerIntent("Average sales per day per week", summary());
    assert.equal(intent, null);
  });

  it("rejects 'per row id' as a denominator (runaway protection)", () => {
    const intent = detectMultiPerIntent(
      "Average sales per row id per region",
      summary()
    );
    // The "per row id" is rejected — leaving "per region" alone, but no
    // temporal → null.
    assert.equal(intent, null);
  });

  it("returns null when dataset has no date columns and intent is temporal", () => {
    const noDate = {
      columns: [
        { name: "Sales", type: "number", sampleValues: [] },
        { name: "Region", type: "string", sampleValues: [] },
      ],
      dateColumns: [],
    };
    const intent = detectMultiPerIntent("Average sales per day per region", noDate);
    assert.equal(intent, null);
  });

  it("skips dimensions with cardinality > 5000 to avoid groupBy blow-out", () => {
    const highCard = {
      columns: [
        { name: "Sales", type: "number", sampleValues: [] },
        {
          name: "Customer",
          type: "string",
          sampleValues: [],
          uniqueCount: 50000,
        } as never,
        { name: "Date", type: "date", sampleValues: [] },
      ],
      dateColumns: ["Date"],
    };
    const intent = detectMultiPerIntent("Average sales per day per customer", highCard);
    // No surviving dimension clause → null
    assert.equal(intent, null);
  });
});
