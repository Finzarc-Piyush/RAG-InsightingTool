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
