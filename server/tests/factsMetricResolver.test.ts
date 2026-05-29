/**
 * Wave W-GMK4 · tests for `resolveFactsMetric`.
 *
 * Detect a narrow-format Facts/Metric/KPI discriminator column at chart-build
 * time so the chart layer can filter to ONE metric value before summing
 * (preventing the "Sales Value_sum by Products = 0" symptom from the
 * Marico FMCG screenshots — caused by summing across mixed metric types
 * or projecting a metric name that doesn't exist as a literal column).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveFactsMetric } from "../lib/factsMetricResolver.js";
import type { DataSummary } from "../shared/schema.js";

function summary(overrides: Partial<DataSummary> = {}): DataSummary {
  return {
    rowCount: 100,
    columnCount: 4,
    columns: [],
    numericColumns: [],
    dateColumns: [],
    sampleRows: [],
    ...overrides,
  } as DataSummary;
}

describe("resolveFactsMetric", () => {
  describe("detection", () => {
    it("returns null when no Facts column present", () => {
      const sample = [
        { Product: "A", Value: 100 },
        { Product: "B", Value: 200 },
      ];
      const d = resolveFactsMetric(
        ["Product", "Value"],
        sample,
        summary()
      );
      assert.equal(d.metricColumn, null);
    });

    it("detects 'Facts' column by literal name", () => {
      const sample = [
        { Facts: "Value Sales", Value: 100 },
        { Facts: "Volume Sales", Value: 200 },
        { Facts: "Distribution", Value: 50 },
      ];
      const d = resolveFactsMetric(["Facts", "Value"], sample, summary());
      assert.equal(d.metricColumn, "Facts");
      assert.ok(d.injectedFilter);
    });

    it("detects 'Metric' column by literal name", () => {
      const sample = [
        { Metric: "Sales", Value: 100 },
        { Metric: "Returns", Value: 5 },
      ];
      const d = resolveFactsMetric(["Metric", "Value"], sample, summary());
      assert.equal(d.metricColumn, "Metric");
    });

    it("detects via wideFormatTransform.metricColumn even if column name unusual", () => {
      const sample = [
        { measure_name_unique: "A", Value: 1 },
        { measure_name_unique: "B", Value: 2 },
      ];
      const d = resolveFactsMetric(
        ["measure_name_unique", "Value"],
        sample,
        summary({
          wideFormatTransform: {
            detected: true,
            shape: "compound",
            idColumns: [],
            meltedColumns: [],
            periodCount: 0,
            periodColumn: "Period",
            periodIsoColumn: "PeriodIso",
            periodKindColumn: "PeriodKind",
            valueColumn: "Value",
            metricColumn: "measure_name_unique",
          } as DataSummary["wideFormatTransform"],
        })
      );
      assert.equal(d.metricColumn, "measure_name_unique");
    });

    it("returns null when metric column has only 1 distinct value (no choice)", () => {
      const sample = [
        { Facts: "Value Sales", Value: 100 },
        { Facts: "Value Sales", Value: 200 },
      ];
      const d = resolveFactsMetric(["Facts", "Value"], sample, summary());
      assert.equal(d.metricColumn, null);
    });
  });

  describe("value selection", () => {
    const sample = [
      { Facts: "Value Sales", Value: 100 },
      { Facts: "Value Sales", Value: 200 },
      { Facts: "Value Sales", Value: 300 },
      { Facts: "Volume Sales", Value: 50 },
      { Facts: "Distribution", Value: 75 },
    ];

    it("picks dominant value when no question context", () => {
      const d = resolveFactsMetric(["Facts", "Value"], sample, summary());
      assert.equal(d.metricValue, "Value Sales");
      assert.equal(d.injectedFilter!.value, "Value Sales");
      assert.match(d.reason, /most common value/);
    });

    it("matches a value literally mentioned in the question", () => {
      const d = resolveFactsMetric(
        ["Facts", "Value"],
        sample,
        summary(),
        "show me Volume Sales by period"
      );
      assert.equal(d.metricValue, "Volume Sales");
      assert.match(d.reason, /matched from your question/);
    });

    it("synonym match: 'revenue' → Value Sales", () => {
      const d = resolveFactsMetric(
        ["Facts", "Value"],
        sample,
        summary(),
        "what is total revenue"
      );
      assert.equal(d.metricValue, "Value Sales");
    });

    it("synonym match: 'units' → Volume Sales", () => {
      const d = resolveFactsMetric(
        ["Facts", "Value"],
        sample,
        summary(),
        "how many units did we sell"
      );
      assert.equal(d.metricValue, "Volume Sales");
    });

    it("synonym match: 'distribution' / 'acv' → Distribution", () => {
      const d1 = resolveFactsMetric(
        ["Facts", "Value"],
        sample,
        summary(),
        "what is ACV trend"
      );
      assert.equal(d1.metricValue, "Distribution");
    });
  });

  describe("filter injection", () => {
    it("populates injectedFilter with correct column and value", () => {
      const sample = [
        { Facts: "Value Sales", Value: 100 },
        { Facts: "Value Sales", Value: 200 },
        { Facts: "Volume Sales", Value: 50 },
      ];
      const d = resolveFactsMetric(["Facts", "Value"], sample, summary());
      assert.ok(d.injectedFilter);
      assert.equal(d.injectedFilter!.column, "Facts");
      assert.equal(d.injectedFilter!.op, "eq");
      assert.equal(d.injectedFilter!.value, "Value Sales");
    });
  });
});
