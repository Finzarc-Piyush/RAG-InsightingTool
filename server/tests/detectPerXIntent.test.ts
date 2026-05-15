/**
 * Wave PD1 · `detectPerXIntent` — regex-gated detection of "average X per Y"
 * rate intent. Strict by design: catches every common phrasing the planner
 * historically misroutes as single-pass `mean()`, and stays narrow enough to
 * not false-positive on "sales by region" / "how many regions are there".
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectPerXIntent } from "../lib/agents/runtime/planArgRepairs.js";
import type { DataSummary } from "../shared/schema.js";

function summary(): Pick<DataSummary, "columns" | "dateColumns"> {
  return {
    columns: [
      { name: "Compliance Visit", type: "number", sampleValues: [] },
      { name: "Sales", type: "number", sampleValues: [] },
      { name: "Cluster Name", type: "string", sampleValues: [] },
      { name: "Region", type: "string", sampleValues: [] },
      { name: "Customer", type: "string", sampleValues: [] },
      { name: "TSOE-Date Combo", type: "date", sampleValues: [] },
    ],
    dateColumns: ["TSOE-Date Combo"],
  };
}

describe("Wave PD1 · detectPerXIntent", () => {
  it("detects the Marico screenshot scenario (average compliance visits per day across clusters)", () => {
    const intent = detectPerXIntent(
      "What is the average number of compliance visits per day across clusters?",
      summary()
    );
    assert.ok(intent, "intent should be detected");
    assert.equal(intent!.outerOp, "mean");
    assert.equal(intent!.perDimension, "Day · TSOE-Date Combo");
    assert.equal(intent!.perDimensionKind, "temporal");
  });

  it("detects adverbial 'daily average visits'", () => {
    const intent = detectPerXIntent("Daily average compliance visits", summary());
    assert.ok(intent);
    assert.equal(intent!.outerOp, "mean");
    assert.equal(intent!.perDimension, "Day · TSOE-Date Combo");
  });

  it("detects adverbial 'weekly total sales'", () => {
    const intent = detectPerXIntent("Show me weekly total sales by region", summary());
    assert.ok(intent);
    assert.equal(intent!.outerOp, "sum");
    assert.equal(intent!.perDimension, "Week · TSOE-Date Combo");
  });

  it("detects 'per-day' hyphenated form when paired with a verb earlier in the question", () => {
    const intent = detectPerXIntent(
      "Average compliance visits per-day by region",
      summary()
    );
    assert.ok(intent);
    assert.equal(intent!.outerOp, "mean");
    assert.equal(intent!.perDimension, "Day · TSOE-Date Combo");
  });

  it("detects 'total sales per customer' (non-temporal dimension)", () => {
    const intent = detectPerXIntent("Total sales per customer by region", summary());
    assert.ok(intent);
    assert.equal(intent!.outerOp, "sum");
    assert.equal(intent!.perDimension, "Customer");
    assert.equal(intent!.perDimensionKind, "dimension");
  });

  it("detects 'max visits per region' (max outer op + dimension perDim)", () => {
    const intent = detectPerXIntent(
      "Maximum compliance visits per region by cluster",
      summary()
    );
    assert.ok(intent);
    assert.equal(intent!.outerOp, "max");
    assert.equal(intent!.perDimension, "Region");
  });

  it("detects 'lowest sales per quarter'", () => {
    const intent = detectPerXIntent("Lowest sales per quarter", summary());
    assert.ok(intent);
    assert.equal(intent!.outerOp, "min");
    assert.equal(intent!.perDimension, "Quarter · TSOE-Date Combo");
  });

  it("rejects non-rate questions: 'sales by region'", () => {
    const intent = detectPerXIntent("Show sales by region", summary());
    assert.equal(intent, null);
  });

  it("rejects non-rate questions: 'how many regions are there'", () => {
    const intent = detectPerXIntent("How many regions are there?", summary());
    assert.equal(intent, null);
  });

  it("rejects 'sales per row' / 'visits per record' (denominator runaway)", () => {
    assert.equal(detectPerXIntent("Sales per row", summary()), null);
    assert.equal(detectPerXIntent("Average visits per record", summary()), null);
    assert.equal(detectPerXIntent("Total visits per row id", summary()), null);
  });

  it("returns null on empty / undefined input", () => {
    assert.equal(detectPerXIntent("", summary()), null);
    assert.equal(detectPerXIntent(undefined, summary()), null);
  });

  it("returns null when dataset has no date columns and intent is temporal", () => {
    const noDate: Pick<DataSummary, "columns" | "dateColumns"> = {
      columns: [
        { name: "Sales", type: "number", sampleValues: [] },
        { name: "Region", type: "string", sampleValues: [] },
      ],
      dateColumns: [],
    };
    const intent = detectPerXIntent("Average sales per day", noDate);
    assert.equal(intent, null);
  });
});
