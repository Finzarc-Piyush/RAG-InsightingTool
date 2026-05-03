import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { __test__ } from "../lib/agents/runtime/hypothesisPlanner.js";
import type { AgentExecutionContext } from "../lib/agents/runtime/types.js";

const { formatColumnMeta, buildUserBlock } = __test__;

/**
 * DB1 · The hypothesis prompt now carries column metadata (cardinality hints,
 * value examples, numeric ranges, date ranges) so the LLM can discriminate
 * dimension-like columns from id-like columns and ground its hypotheses in
 * actual data shape rather than just column names.
 */

const numericSet = new Set(["Sales", "Quantity"]);
const dateSet = new Set(["Order Date"]);

describe("formatColumnMeta", () => {
  it("emits cardinality and examples for low-cardinality categoricals", () => {
    const out = formatColumnMeta(
      {
        name: "Region",
        type: "string",
        sampleValues: ["West", "East"],
        topValues: [
          { value: "West", count: 100 },
          { value: "East", count: 80 },
          { value: "Central", count: 60 },
          { value: "South", count: 50 },
        ],
      },
      numericSet,
      dateSet
    );
    assert.match(out, /^Region \(string, distinct≈4, examples=\[/);
    assert.ok(out.includes("West"));
    assert.ok(out.includes("South"));
  });

  it("emits distinct≥48 for saturated topValues lists", () => {
    const topValues = Array.from({ length: 48 }, (_, i) => ({
      value: `v${i}`,
      count: 100 - i,
    }));
    const out = formatColumnMeta(
      { name: "ProductSKU", type: "string", sampleValues: ["v0"], topValues },
      numericSet,
      dateSet
    );
    assert.ok(out.includes("distinct≥48"), `expected saturated marker in ${out}`);
  });

  it("emits sample-range for numeric columns", () => {
    const out = formatColumnMeta(
      {
        name: "Sales",
        type: "number",
        sampleValues: [12.5, 200, 45, 7800.4],
      },
      numericSet,
      dateSet
    );
    assert.match(out, /Sales \(number, sample-range≈\[/);
    assert.ok(out.includes("12.5"));
    assert.ok(out.includes("7800.4"));
  });

  it("emits range hint for date columns", () => {
    const out = formatColumnMeta(
      {
        name: "Order Date",
        type: "date",
        sampleValues: ["2018-01-01", "2018-06-15", "2020-12-31"],
      },
      numericSet,
      dateSet
    );
    assert.match(out, /Order Date \(date, range≈2018-01-01\.\.2020-12-31\)/);
  });

  it("falls back to bare type for categoricals without topValues", () => {
    const out = formatColumnMeta(
      { name: "Notes", type: "string", sampleValues: ["x", "y"] },
      numericSet,
      dateSet
    );
    assert.strictEqual(out, "Notes (string)");
  });
});

describe("buildUserBlock", () => {
  it("renders the metadata-rich Columns block with one line per column", () => {
    const ctx = {
      question: "What drives sales?",
      summary: {
        rowCount: 100,
        columnCount: 3,
        columns: [
          {
            name: "Region",
            type: "string",
            sampleValues: ["West"],
            topValues: [
              { value: "West", count: 100 },
              { value: "East", count: 80 },
            ],
          },
          { name: "Sales", type: "number", sampleValues: [10, 200] },
          { name: "Order Date", type: "date", sampleValues: ["2020-01-01", "2020-12-31"] },
        ],
        numericColumns: ["Sales"],
        dateColumns: ["Order Date"],
      },
    } as unknown as AgentExecutionContext;
    const out = buildUserBlock(ctx);
    assert.ok(out.startsWith("Question: What drives sales?"));
    assert.ok(out.includes("Region (string, distinct≈2"));
    assert.ok(out.includes("Sales (number, sample-range≈"));
    assert.ok(out.includes("Order Date (date, range≈2020-01-01..2020-12-31)"));
    // Each column appears as a "  - " bullet line
    assert.match(out, /Columns:\n  - Region/);
  });

  it("caps at 60 columns and notes truncation", () => {
    const cols = Array.from({ length: 80 }, (_, i) => ({
      name: `c${i}`,
      type: "string",
      sampleValues: [],
      topValues: [{ value: "x", count: 1 }],
    }));
    const ctx = {
      question: "q",
      summary: {
        rowCount: 1,
        columnCount: 80,
        columns: cols,
        numericColumns: [],
        dateColumns: [],
      },
    } as unknown as AgentExecutionContext;
    const out = buildUserBlock(ctx);
    assert.ok(out.includes("(showing first 60 of 80)"));
    // c59 is in (last of first 60), c60 is not
    assert.ok(out.includes("c59 ("));
    assert.ok(!out.includes("c60 ("));
  });

  it("stays under a coarse 24k-char ceiling on a typical 30-column dataset", () => {
    const cols = Array.from({ length: 30 }, (_, i) => ({
      name: `Column${i}`,
      type: "string",
      sampleValues: [`val${i}`],
      topValues: Array.from({ length: 8 }, (_, j) => ({
        value: `Value_${i}_${j}_with_some_padding`,
        count: 100 - j,
      })),
    }));
    const ctx = {
      question: "build me a sales dashboard",
      summary: {
        rowCount: 9800,
        columnCount: 30,
        columns: cols,
        numericColumns: [],
        dateColumns: [],
      },
    } as unknown as AgentExecutionContext;
    const out = buildUserBlock(ctx);
    assert.ok(out.length < 24_000, `expected <24k chars, got ${out.length}`);
  });
});
