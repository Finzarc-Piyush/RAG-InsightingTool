import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectRollupHierarchies } from "../lib/detectRollupHierarchies.js";
import type { DataSummary } from "../shared/schema.js";

function makeSummary(opts: {
  columns: string[];
  numericColumns?: string[];
  dateColumns?: string[];
}): DataSummary {
  return {
    rowCount: 100,
    columnCount: opts.columns.length,
    columns: opts.columns.map((name) => ({
      name,
      type:
        opts.numericColumns?.includes(name) ? "number"
        : opts.dateColumns?.includes(name) ? "date"
        : "string",
      sampleValues: [],
    })),
    numericColumns: opts.numericColumns ?? [],
    dateColumns: opts.dateColumns ?? [],
  };
}

describe("AD1 · detectRollupHierarchies — Marico-VN demo case", () => {
  it("detects FEMALE SHOWER GEL as a category total over MARICO/PURITE/OLIV/LASHE", () => {
    // Mirrors the screenshot proportions: rollup ≈ 88% of total, ~11× the runner-up.
    const data = [
      // category-total row (could appear once or many times; sums work either way)
      { Products: "FEMALE SHOWER GEL", Total_Sales_Value: 68_751 },
      { Products: "MARICO", Total_Sales_Value: 6_000 },
      { Products: "PURITE", Total_Sales_Value: 2_000 },
      { Products: "OLIV", Total_Sales_Value: 700 },
      { Products: "LASHE", Total_Sales_Value: 323 },
    ];
    const summary = makeSummary({
      columns: ["Products", "Total_Sales_Value"],
      numericColumns: ["Total_Sales_Value"],
    });
    const out = detectRollupHierarchies({
      data,
      summary,
      datasetProfile: { measureColumns: ["Total_Sales_Value"] } as any,
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].column, "Products");
    assert.equal(out[0].rollupValue, "FEMALE SHOWER GEL");
    assert.equal(out[0].source, "auto");
    assert.deepEqual(out[0].itemValues, ["MARICO", "PURITE", "OLIV", "LASHE"]);
    assert.match(out[0].description ?? "", /88%/);
    assert.match(out[0].description ?? "", /Total_Sales_Value/);
  });
});

describe("AD1 · detectRollupHierarchies — false-positive guards", () => {
  it("rejects a market leader at 60% share (dominance below threshold)", () => {
    const data = [
      { Brand: "MARICO", Sales: 600 },
      { Brand: "HUL", Sales: 200 },
      { Brand: "ITC", Sales: 100 },
      { Brand: "DABUR", Sales: 100 },
    ];
    const summary = makeSummary({
      columns: ["Brand", "Sales"],
      numericColumns: ["Sales"],
    });
    const out = detectRollupHierarchies({ data, summary });
    assert.deepEqual(out, []);
  });

  it("rejects 80% dominance without a 4× ratio (e.g. 80/20 split)", () => {
    const data = [
      { Channel: "Modern Trade", Sales: 800 },
      { Channel: "General Trade", Sales: 250 },
      { Channel: "E-Commerce", Sales: 250 },
      { Channel: "Other", Sales: 100 },
    ];
    const summary = makeSummary({
      columns: ["Channel", "Sales"],
      numericColumns: ["Sales"],
    });
    // top=800/total=1400 = 57% → below 70%
    const out = detectRollupHierarchies({ data, summary });
    assert.deepEqual(out, []);
  });

  it("rejects below minCardinality (binary split: 2 values)", () => {
    const data = [
      { Region: "TOTAL", Sales: 1000 },
      { Region: "NORTH", Sales: 100 },
    ];
    const summary = makeSummary({
      columns: ["Region", "Sales"],
      numericColumns: ["Sales"],
    });
    const out = detectRollupHierarchies({ data, summary });
    assert.deepEqual(out, []);
  });

  it("rejects above maxCardinality (60 distinct values)", () => {
    const data: Record<string, unknown>[] = [
      { Sku: "TOTAL", Sales: 100_000 },
    ];
    for (let i = 0; i < 60; i++) {
      data.push({ Sku: `SKU_${i}`, Sales: 100 });
    }
    const summary = makeSummary({
      columns: ["Sku", "Sales"],
      numericColumns: ["Sales"],
    });
    const out = detectRollupHierarchies({ data, summary });
    assert.deepEqual(out, []);
  });

  it("ignores numeric and date columns as candidate dimensions", () => {
    const data = [
      { OrderId: 1, Date: "2025-01-01", Sales: 1000 },
      { OrderId: 2, Date: "2025-01-02", Sales: 50 },
      { OrderId: 3, Date: "2025-01-03", Sales: 50 },
      { OrderId: 4, Date: "2025-01-04", Sales: 50 },
      { OrderId: 5, Date: "2025-01-05", Sales: 50 },
    ];
    const summary = makeSummary({
      columns: ["OrderId", "Date", "Sales"],
      numericColumns: ["OrderId", "Sales"],
      dateColumns: ["Date"],
    });
    const out = detectRollupHierarchies({ data, summary });
    assert.deepEqual(out, []);
  });

  it("returns empty when no measure column exists", () => {
    const data = [
      { Brand: "ALL", Sales: "not a number" },
      { Brand: "MARICO", Sales: "x" },
      { Brand: "HUL", Sales: "y" },
      { Brand: "ITC", Sales: "z" },
    ];
    const summary = makeSummary({
      columns: ["Brand", "Sales"],
      // Sales not flagged as numeric and contains non-numeric values
    });
    const out = detectRollupHierarchies({ data, summary });
    assert.deepEqual(out, []);
  });
});

describe("AD1 · detectRollupHierarchies — multi-column", () => {
  it("detects multiple rollups in different columns", () => {
    const data = [
      { Category: "FEMALE SHOWER GEL", Region: "All India", Sales: 10_000 },
      { Category: "MARICO", Region: "North", Sales: 200 },
      { Category: "PURITE", Region: "South", Sales: 200 },
      { Category: "OLIV", Region: "East", Sales: 200 },
      { Category: "LASHE", Region: "West", Sales: 200 },
    ];
    const summary = makeSummary({
      columns: ["Category", "Region", "Sales"],
      numericColumns: ["Sales"],
    });
    const out = detectRollupHierarchies({ data, summary });
    const cols = out.map((h) => h.column).sort();
    // Both Category and Region have rollup values that dominate (the single
    // "FEMALE SHOWER GEL" row also corresponds to "All India" → both columns
    // show 10000/(10000+800)=92% dominance, ratio 50×).
    assert.deepEqual(cols, ["Category", "Region"]);
  });

  it("picks the strongest measure when multiple measures exist", () => {
    // Volume signal is weak; Value signal is strong → detector should still trigger
    const data = [
      { Brand: "ALL", Volume: 100, Value: 10_000 },
      { Brand: "A", Volume: 50, Value: 200 },
      { Brand: "B", Volume: 40, Value: 200 },
      { Brand: "C", Volume: 30, Value: 200 },
      { Brand: "D", Volume: 20, Value: 200 },
    ];
    const summary = makeSummary({
      columns: ["Brand", "Volume", "Value"],
      numericColumns: ["Volume", "Value"],
    });
    const out = detectRollupHierarchies({ data, summary });
    assert.equal(out.length, 1);
    assert.equal(out[0].rollupValue, "ALL");
    assert.equal(out[0].column, "Brand");
    assert.match(out[0].description ?? "", /Value/);
  });
});

describe("AD1 · detectRollupHierarchies — guards", () => {
  it("returns empty for empty data", () => {
    assert.deepEqual(
      detectRollupHierarchies({
        data: [],
        summary: makeSummary({ columns: [] }),
      }),
      []
    );
  });
});
