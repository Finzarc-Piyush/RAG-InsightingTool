import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inferFiltersFromQuestion } from "../lib/agents/utils/inferFiltersFromQuestion.js";
import type { DataSummary } from "../shared/schema.js";

const SUMMARY: DataSummary = {
  rowCount: 100,
  columnCount: 4,
  columns: [
    {
      name: "Products",
      type: "string",
      sampleValues: [
        "FEMALE SHOWER GEL",
        "MARICO",
        "PURITE",
        "OLIV",
        "LASHE",
      ],
      categoricalSummary: {
        uniqueValues: ["FEMALE SHOWER GEL", "MARICO", "PURITE", "OLIV", "LASHE"],
        distinctCount: 5,
      },
    },
    {
      name: "Markets",
      type: "string",
      sampleValues: ["WEST", "EAST", "NORTH", "SOUTH"],
      categoricalSummary: {
        uniqueValues: ["WEST", "EAST", "NORTH", "SOUTH"],
        distinctCount: 4,
      },
    },
    {
      name: "Value",
      type: "number",
      sampleValues: [],
    },
  ],
  numericColumns: ["Value"],
  dateColumns: [],
} as unknown as DataSummary;

describe("RD3 · inferFiltersFromQuestion — negative filter pre-scan", () => {
  it("'please omit FEMALE SHOWER GEL. now give highest sales by product' emits not_in on Products", () => {
    const filters = inferFiltersFromQuestion(
      "please omit FEMALE SHOWER GEL. now give highest sales by product",
      SUMMARY
    );
    const notIn = filters.find((f) => f.op === "not_in");
    assert.ok(notIn, "expected a not_in filter");
    assert.equal(notIn!.column, "Products");
    assert.deepEqual(notIn!.values, ["FEMALE SHOWER GEL"]);
    assert.equal(notIn!.intent, "negative");
    // No positive filter on Products (FSG was the only product mentioned in
    // the question; it was negated).
    const posOnProducts = filters.find(
      (f) => f.op === "in" && f.column === "Products"
    );
    assert.equal(posOnProducts, undefined);
  });

  it("'exclude WEST' emits not_in on Markets", () => {
    const filters = inferFiltersFromQuestion(
      "show me top products excluding WEST",
      SUMMARY
    );
    const notIn = filters.find((f) => f.op === "not_in");
    assert.ok(notIn);
    assert.equal(notIn!.column, "Markets");
    assert.deepEqual(notIn!.values, ["WEST"]);
  });

  it("'without OLIV' strips OLIV from any positive filter on the same column", () => {
    const filters = inferFiltersFromQuestion(
      "rank MARICO and PURITE and OLIV without OLIV",
      SUMMARY
    );
    const posOnProducts = filters.find(
      (f) => f.op === "in" && f.column === "Products"
    );
    const notIn = filters.find((f) => f.op === "not_in");
    assert.ok(notIn);
    assert.deepEqual(notIn!.values, ["OLIV"]);
    // OLIV must be removed from the positive filter on Products
    if (posOnProducts) {
      assert.equal(posOnProducts.values.includes("OLIV"), false);
    }
  });

  it("'ignore the rest, just MARICO' does NOT emit not_in for MARICO (polarity flipper)", () => {
    const filters = inferFiltersFromQuestion(
      "ignore the rest, just MARICO",
      SUMMARY
    );
    const notIn = filters.find((f) => f.op === "not_in");
    assert.equal(notIn, undefined, "polarity flipper should suppress negative");
  });

  it("'omit small categories — show me top products by sales' does not emit not_in (no unique value match)", () => {
    const filters = inferFiltersFromQuestion(
      "omit small categories — show me top products by sales",
      SUMMARY
    );
    const notIn = filters.find((f) => f.op === "not_in");
    assert.equal(notIn, undefined, '"small categories" should not resolve uniquely');
  });

  it("question with no exclusion verb emits no not_in", () => {
    const filters = inferFiltersFromQuestion(
      "rank top products by sales",
      SUMMARY
    );
    for (const f of filters) {
      assert.notEqual(f.op, "not_in");
    }
  });

  it("sentence-boundary cap: 'omit FSG. show MARICO.' captures only the first clause", () => {
    const filters = inferFiltersFromQuestion(
      "omit FEMALE SHOWER GEL. show MARICO across markets",
      SUMMARY
    );
    const notIn = filters.find((f) => f.op === "not_in");
    assert.ok(notIn);
    assert.deepEqual(notIn!.values, ["FEMALE SHOWER GEL"]);
    // MARICO should NOT be in the not_in filter (boundary stopped the capture
    // at the period before "show MARICO").
    assert.equal(notIn!.values.includes("MARICO"), false);
  });

  it("intent='positive' is tagged on existing in-filters", () => {
    const filters = inferFiltersFromQuestion(
      "show me MARICO sales",
      SUMMARY
    );
    const pos = filters.find((f) => f.op === "in" && f.column === "Products");
    assert.ok(pos);
    assert.equal(pos!.intent, "positive");
  });

  it("AGENT_INFER_NEGATIVE_FILTERS=false disables the pre-scan", () => {
    const prev = process.env.AGENT_INFER_NEGATIVE_FILTERS;
    process.env.AGENT_INFER_NEGATIVE_FILTERS = "false";
    try {
      const filters = inferFiltersFromQuestion(
        "omit FEMALE SHOWER GEL",
        SUMMARY
      );
      const notIn = filters.find((f) => f.op === "not_in");
      assert.equal(notIn, undefined);
    } finally {
      if (prev === undefined) delete process.env.AGENT_INFER_NEGATIVE_FILTERS;
      else process.env.AGENT_INFER_NEGATIVE_FILTERS = prev;
    }
  });

  it("multiple exclusion clauses: 'omit FSG and exclude WEST'", () => {
    const filters = inferFiltersFromQuestion(
      "omit FEMALE SHOWER GEL and exclude WEST from the analysis",
      SUMMARY
    );
    const notInProducts = filters.find(
      (f) => f.op === "not_in" && f.column === "Products"
    );
    const notInMarkets = filters.find(
      (f) => f.op === "not_in" && f.column === "Markets"
    );
    assert.ok(notInProducts, "expected not_in on Products");
    assert.ok(notInMarkets, "expected not_in on Markets");
    assert.deepEqual(notInProducts!.values, ["FEMALE SHOWER GEL"]);
    assert.deepEqual(notInMarkets!.values, ["WEST"]);
  });
});
