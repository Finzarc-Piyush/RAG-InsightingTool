import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ChartSpec, DataSummary } from "../shared/schema.js";
import { selectScorecardMetrics } from "../lib/scorecard/selectScorecardMetrics.js";

/**
 * Wave W6 (data-bound cards) · Executive-Summary metric selection. Pins that
 * the band leads with the measures the charts are ABOUT, dedupes, excludes
 * dimensions/temporals, and stamps the correct default aggregation + PoP
 * comparison + polarity/format onto each scorecard definition.
 */

const summary: DataSummary = {
  columns: [
    { name: "NR", type: "numeric", additivity: "additive", semantics: { semanticType: "measure_additive", aggregation: "sum", displayKind: "numeric", source: "auto" } } as any,
    { name: "GC%", type: "numeric", additivity: "non_additive", additivityKind: "ratio_percent", semantics: { semanticType: "measure_ratio_percent", aggregation: "avg", displayKind: "numeric", source: "auto" } } as any,
    { name: "Volume", type: "numeric", additivity: "additive", semantics: { semanticType: "measure_additive", aggregation: "sum", displayKind: "numeric", source: "auto" } } as any,
    { name: "Region", type: "text", semantics: { semanticType: "categorical_dimension", aggregation: "none", displayKind: "categorical", source: "auto" } } as any,
    { name: "Month", type: "date", semantics: { semanticType: "temporal_month", aggregation: "none", displayKind: "date", source: "auto" } } as any,
  ],
  numericColumns: ["NR", "GC%", "Volume"],
  dateColumns: ["Month"],
  totalRows: 10,
  sampleRows: [],
} as any;

const charts: ChartSpec[] = [{ type: "bar", title: "NR by Region", x: "Region", y: "NR" } as any];

describe("W6 · selectScorecardMetrics", () => {
  it("leads with the chart measure, then the other real measures; excludes dims/temporals", () => {
    const defs = selectScorecardMetrics({ summary, charts });
    const refs = defs.map((d) => d.cardDefinition.measure.ref);
    assert.equal(refs[0], "NR", "chart Y measure leads");
    assert.ok(refs.includes("GC%"));
    assert.ok(refs.includes("Volume"));
    assert.ok(!refs.includes("Region"), "dimension excluded");
    assert.ok(!refs.includes("Month"), "temporal excluded");
  });

  it("dedupes a measure that appears both as chart Y and a numeric column", () => {
    const defs = selectScorecardMetrics({ summary, charts });
    const nrCount = defs.filter((d) => d.cardDefinition.measure.ref === "NR").length;
    assert.equal(nrCount, 1);
  });

  it("stamps correct default aggregation, PoP comparison, polarity, format", () => {
    const defs = selectScorecardMetrics({ summary, charts });
    const nr = defs.find((d) => d.cardDefinition.measure.ref === "NR")!;
    const gc = defs.find((d) => d.cardDefinition.measure.ref === "GC%")!;
    assert.equal(nr.cardDefinition.aggregation, "sum");
    assert.equal(gc.cardDefinition.aggregation, "avg", "a ratio defaults to avg (never sum)");
    assert.equal(nr.cardDefinition.comparison?.mode, "period_over_period");
    assert.equal(nr.metricPolarity, "higher_better");
    assert.equal(gc.format, "percent");
    assert.equal(nr.cardDefinition.cardType, "scorecard");
  });

  it("respects the max cap", () => {
    const defs = selectScorecardMetrics({ summary, charts, max: 2 });
    assert.equal(defs.length, 2);
  });
});
