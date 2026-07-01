import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DataSummary } from "../shared/schema.js";
import { buildBuilderMetadata } from "../lib/dashboardTileCompose.js";

/**
 * Wave W9 (data-bound cards) · the guided-builder metadata. Pins that the
 * picker offers real measures with their LEGAL aggregations (ratio → avg only),
 * and dimensions with distinct values for the filter dropdowns — the metadata
 * is what makes the builder selection-only.
 */

const summary: DataSummary = {
  columns: [
    { name: "NR", type: "numeric", additivity: "additive", semantics: { semanticType: "measure_additive", aggregation: "sum", displayKind: "numeric", source: "auto" } } as any,
    { name: "GC%", type: "numeric", additivity: "non_additive", additivityKind: "ratio_percent", semantics: { semanticType: "measure_ratio_percent", aggregation: "avg", displayKind: "numeric", source: "auto" } } as any,
    { name: "Channel", type: "text", semantics: { semanticType: "categorical_dimension", aggregation: "none", displayKind: "categorical", source: "auto" }, topValues: [{ value: "GT", count: 100 }, { value: "MT", count: 60 }] } as any,
    { name: "OrderId", type: "text", semantics: { semanticType: "identifier", aggregation: "none", displayKind: "categorical", source: "auto" } } as any,
    { name: "Month", type: "date", semantics: { semanticType: "temporal_month", aggregation: "none", displayKind: "date", source: "auto" } } as any,
  ],
  numericColumns: ["NR", "GC%"],
  dateColumns: ["Month"],
  totalRows: 10,
  sampleRows: [],
} as any;

describe("W9 · buildBuilderMetadata", () => {
  const meta = buildBuilderMetadata(summary);

  it("exposes measures with legal aggregations (ratio → avg only, sum forbidden)", () => {
    const nr = meta.measures.find((m) => m.ref === "NR")!;
    const gc = meta.measures.find((m) => m.ref === "GC%")!;
    assert.ok(nr.allowedAggregations.includes("sum"));
    assert.equal(nr.defaultAggregation, "sum");
    assert.deepEqual(gc.allowedAggregations, ["avg"]);
    assert.ok(!gc.allowedAggregations.includes("sum"));
    assert.equal(gc.format, "percent");
  });

  it("exposes dimensions with distinct values for filters; excludes identifiers", () => {
    const cols = meta.dimensions.map((d) => d.column);
    assert.ok(cols.includes("Channel"));
    assert.ok(cols.includes("Month"));
    assert.ok(!cols.includes("OrderId"), "high-cardinality identifier is not a filterable dimension");
    assert.ok(!cols.includes("NR"), "a measure is not a dimension");

    const channel = meta.dimensions.find((d) => d.column === "Channel")!;
    assert.equal(channel.kind, "categorical");
    assert.equal(channel.hasTopValues, true);
    assert.deepEqual(channel.values?.map((v) => v.value), ["GT", "MT"]);

    const month = meta.dimensions.find((d) => d.column === "Month")!;
    assert.equal(month.kind, "temporal");
  });
});
