import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inferModel } from "../lib/semantic/inferModel.js";
import type { DataSummary } from "../shared/schema.js";

function numericSummary(names: string[]): DataSummary {
  return {
    rowCount: 100,
    columnCount: names.length,
    columns: names.map((name) => ({ name, type: "number", sampleValues: [] })),
    numericColumns: names,
    dateColumns: [],
  } as unknown as DataSummary;
}

/**
 * W6 · inferModel must stop emitting `SUM(GC%)` + format:number. A non-additive
 * column gets AVG(...) + a percent/ratio format; an additive amount still SUMs.
 */
describe("inferModel — ratio-aware metric inference", () => {
  const model = inferModel({ summary: numericSummary(["Net Revenue", "GC%", "Realization"]), modelName: "t" });
  const byLabel = Object.fromEntries(model.metrics.map((m) => [m.label, m]));

  it("Net Revenue stays SUM + number", () => {
    assert.equal(byLabel["Net Revenue"].expression, "SUM(Net Revenue)");
    assert.equal(byLabel["Net Revenue"].format, "number");
  });
  it("GC% becomes AVG + percent (never SUM)", () => {
    assert.equal(byLabel["GC%"].expression, "AVG(GC%)");
    assert.equal(byLabel["GC%"].format, "percent");
  });
  it("Realization (per-unit) becomes AVG + ratio", () => {
    assert.equal(byLabel["Realization"].expression, "AVG(Realization)");
    assert.equal(byLabel["Realization"].format, "ratio");
  });
});

/**
 * A2 · inferModel honours the per-column semantic authority: int-encoded
 * temporals + ordinals become DIMENSIONS (never metrics), ratios flagged by
 * semantics (even if the finance catalog missed the name) are AVG'd, and empty
 * columns are dropped entirely.
 */
describe("inferModel — semantic-type-driven routing (A2)", () => {
  const summary = {
    rowCount: 100,
    columnCount: 5,
    numericColumns: ["Year", "fy_month_number", "Volume (KL)", "Primary Scheme"],
    dateColumns: [],
    columns: [
      {
        name: "Year",
        type: "number",
        sampleValues: [],
        semantics: { semanticType: "temporal_year", aggregation: "none", displayKind: "date", temporalGrain: "year", source: "deterministic" },
      },
      {
        name: "fy_month_number",
        type: "number",
        sampleValues: [],
        semantics: { semanticType: "ordinal", aggregation: "none", displayKind: "ordinal", source: "deterministic" },
      },
      {
        name: "Volume (KL)",
        type: "number",
        sampleValues: [],
        semantics: { semanticType: "measure_additive", aggregation: "sum", displayKind: "numeric", source: "deterministic" },
      },
      {
        name: "Primary Scheme",
        type: "number",
        sampleValues: [],
        semantics: { semanticType: "measure_ratio_percent", aggregation: "avg", displayKind: "numeric", source: "llm" },
      },
      {
        name: "UGST",
        type: "string",
        sampleValues: [],
        semantics: { semanticType: "empty", aggregation: "none", displayKind: "empty", source: "deterministic" },
      },
    ],
  } as unknown as DataSummary;

  const model = inferModel({ summary, modelName: "t" });
  const metricLabels = model.metrics.map((m) => m.label);
  const dimLabels = model.dimensions.map((d) => d.label);

  it("Year → temporal dimension, NOT a metric", () => {
    assert.ok(dimLabels.includes("Year"));
    assert.ok(!metricLabels.includes("Year"));
  });
  it("fy_month_number → dimension, NOT a metric", () => {
    assert.ok(dimLabels.includes("fy_month_number"));
    assert.ok(!metricLabels.includes("fy_month_number"));
  });
  it("Volume (KL) → SUM metric", () => {
    const m = model.metrics.find((x) => x.label === "Volume (KL)");
    assert.equal(m?.expression, "SUM(Volume (KL))");
  });
  it("Primary Scheme → AVG (ratio) even though the finance catalog misses it", () => {
    const m = model.metrics.find((x) => x.label === "Primary Scheme");
    assert.equal(m?.expression, "AVG(Primary Scheme)");
    assert.equal(m?.format, "percent");
  });
  it("empty column is dropped from the model", () => {
    assert.ok(!metricLabels.includes("UGST"));
    assert.ok(!dimLabels.includes("UGST"));
  });
});
