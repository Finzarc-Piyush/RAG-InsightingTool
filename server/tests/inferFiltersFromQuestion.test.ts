import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inferFiltersFromQuestion } from "../lib/agents/utils/inferFiltersFromQuestion.js";
import type { DataSummary } from "../shared/schema.js";

function superstoreSummary(): DataSummary {
  return {
    rowCount: 1000,
    columnCount: 6,
    columns: [
      { name: "Sales", type: "number", sampleValues: [] },
      { name: "Order Date", type: "string", sampleValues: [] },
      {
        name: "Category",
        type: "string",
        sampleValues: [],
        topValues: [
          { value: "Furniture", count: 300 },
          { value: "Office Supplies", count: 500 },
          { value: "Technology", count: 200 },
        ],
      },
      {
        name: "Region",
        type: "string",
        sampleValues: [],
        topValues: [
          { value: "Central", count: 250 },
          { value: "East", count: 250 },
          { value: "South", count: 250 },
          { value: "West", count: 250 },
        ],
      },
      {
        name: "Segment",
        type: "string",
        sampleValues: [],
        topValues: [
          { value: "Consumer", count: 500 },
          { value: "Corporate", count: 300 },
          { value: "Home Office", count: 200 },
        ],
      },
      {
        name: "Ship Mode",
        type: "string",
        sampleValues: [],
        topValues: [
          { value: "Standard Class", count: 600 },
          { value: "Second Class", count: 200 },
          { value: "First Class", count: 150 },
          { value: "Same Day", count: 50 },
        ],
      },
    ],
    numericColumns: ["Sales"],
    dateColumns: ["Order Date"],
  } as DataSummary;
}

describe("inferFiltersFromQuestion", () => {
  it("resolves the 'furniture' token in the bug question to Category=Furniture", () => {
    const summary = superstoreSummary();
    const out = inferFiltersFromQuestion(
      "which region is growing the most in terms of furniture sales?",
      summary
    );
    assert.equal(out.length, 1);
    assert.equal(out[0]!.column, "Category");
    assert.deepEqual(out[0]!.values, ["Furniture"]);
    assert.equal(out[0]!.op, "in");
    assert.ok(out[0]!.match === "exact" || out[0]!.match === "case_insensitive");
    assert.ok(out[0]!.matchedTokens.includes("furniture"));
  });

  it("is case-insensitive: FURNITURE still resolves", () => {
    const out = inferFiltersFromQuestion(
      "Give me FURNITURE sales by region",
      superstoreSummary()
    );
    assert.equal(out.length, 1);
    assert.equal(out[0]!.column, "Category");
    assert.deepEqual(out[0]!.values, ["Furniture"]);
  });

  it("plural 'furnitures' resolves via contains phase", () => {
    const out = inferFiltersFromQuestion(
      "how are furnitures doing?",
      superstoreSummary()
    );
    assert.equal(out.length, 1);
    assert.equal(out[0]!.column, "Category");
    assert.deepEqual(out[0]!.values, ["Furniture"]);
  });

  it("resolves multi-word values like 'office supplies'", () => {
    const out = inferFiltersFromQuestion(
      "how did office supplies perform last year?",
      superstoreSummary()
    );
    const cat = out.find((f) => f.column === "Category");
    assert.ok(cat, "expected a Category filter");
    assert.deepEqual(cat!.values, ["Office Supplies"]);
  });

  it("combines multiple inferred filters (Category + Region)", () => {
    const out = inferFiltersFromQuestion(
      "show me furniture in the east region",
      superstoreSummary()
    );
    const byCol = new Map(out.map((f) => [f.column, f]));
    assert.ok(byCol.has("Category"), "expected Category");
    assert.ok(byCol.has("Region"), "expected Region");
    assert.deepEqual(byCol.get("Category")!.values, ["Furniture"]);
    assert.deepEqual(byCol.get("Region")!.values, ["East"]);
  });

  it("abstains when a token is ambiguous across two columns", () => {
    const ambiguous: DataSummary = {
      rowCount: 100,
      columnCount: 3,
      columns: [
        { name: "Sales", type: "number", sampleValues: [] },
        {
          name: "ColA",
          type: "string",
          sampleValues: [],
          topValues: [{ value: "Alpha", count: 1 }],
        },
        {
          name: "ColB",
          type: "string",
          sampleValues: [],
          topValues: [{ value: "Alpha", count: 1 }],
        },
      ],
      numericColumns: ["Sales"],
      dateColumns: [],
    } as DataSummary;
    const out = inferFiltersFromQuestion("tell me about alpha sales", ambiguous);
    assert.deepEqual(out, []);
  });

  it("does not emit a filter when the user only names a column header", () => {
    const out = inferFiltersFromQuestion(
      "sales growth by region",
      superstoreSummary()
    );
    assert.deepEqual(out, []);
  });

  it("returns [] when the summary has no categorical topValues", () => {
    const bare: DataSummary = {
      rowCount: 10,
      columnCount: 2,
      columns: [
        { name: "Sales", type: "number", sampleValues: [] },
        { name: "Note", type: "string", sampleValues: [] },
      ],
      numericColumns: ["Sales"],
      dateColumns: [],
    } as DataSummary;
    const out = inferFiltersFromQuestion("furniture sales", bare);
    assert.deepEqual(out, []);
  });

  it("respects the maxFilters cap", () => {
    const summary = superstoreSummary();
    const out = inferFiltersFromQuestion(
      "furniture technology consumer corporate east west",
      summary,
      { maxFilters: 2 }
    );
    assert.ok(out.length <= 2);
  });

  it("skips 1-char tokens and pure numbers", () => {
    const out = inferFiltersFromQuestion(
      "a b 2023 42 furniture",
      superstoreSummary()
    );
    assert.equal(out.length, 1);
    assert.equal(out[0]!.column, "Category");
  });

  it("returns [] for an empty question", () => {
    assert.deepEqual(inferFiltersFromQuestion("", superstoreSummary()), []);
    assert.deepEqual(
      inferFiltersFromQuestion("   !?.,", superstoreSummary()),
      []
    );
  });
});
