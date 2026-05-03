// WPF7 · Pivot defaults sanity for melted compound-shape datasets.
// Without this guard, the default pivot SUMs Value across mixed Metric
// values (value_sales + volume = garbage). The fix pre-selects a single
// metric so the first render is correct.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergePivotDefaultRowsAndValues } from "../lib/pivotDefaultsFromExecution.js";
import type { DataSummary, WideFormatTransform } from "../shared/schema.js";
import type { QueryPlanBody } from "../lib/queryPlanExecutor.js";

const compoundTransform: WideFormatTransform = {
  detected: true,
  shape: "compound",
  idColumns: ["Markets", "Products"],
  meltedColumns: ["Q1 23 Value Sales", "Q1 23 Volume"],
  periodCount: 2,
  periodColumn: "Period",
  periodIsoColumn: "PeriodIso",
  periodKindColumn: "PeriodKind",
  valueColumn: "Value",
  metricColumn: "Metric",
  detectedCurrencySymbol: "đ",
};

const compoundSummary: DataSummary = {
  rowCount: 16,
  columnCount: 7,
  columns: [
    { name: "Markets", type: "string", sampleValues: [] },
    { name: "Products", type: "string", sampleValues: [] },
    { name: "Period", type: "string", sampleValues: [] },
    { name: "PeriodIso", type: "string", sampleValues: [] },
    { name: "PeriodKind", type: "string", sampleValues: [] },
    {
      name: "Metric",
      type: "string",
      sampleValues: ["value_sales"],
      topValues: [
        { value: "value_sales", count: 8 },
        { value: "volume", count: 8 },
      ],
    },
    { name: "Value", type: "number", sampleValues: [] },
  ],
  numericColumns: ["Value"],
  dateColumns: [],
  wideFormatTransform: compoundTransform,
};

describe("WPF7 · pivot defaults pre-select a metric for compound-shape datasets", () => {
  it("adds Metric to filterFields with value_sales pre-selected when not already pinned", () => {
    const tracePlan: QueryPlanBody = {
      groupBy: ["Markets"],
      aggregations: [{ column: "Value", operation: "sum" }],
    };
    const tableRows = [
      { Markets: "Off VN", Value_sum: 1234 },
      { Markets: "Off SG", Value_sum: 567 },
    ];
    const tableColumns = ["Markets", "Value_sum"];
    const out = mergePivotDefaultRowsAndValues({
      dataSummary: compoundSummary,
      tracePlan,
      tableRows,
      tableColumns,
    });

    assert.ok(out, "expected pivot defaults result");
    assert.ok(
      out!.filterFields?.includes("Metric"),
      "Metric must be pinned as a filter"
    );
    assert.deepEqual(out!.filterSelections?.Metric, ["value_sales"]);
  });

  it("does not double-pin Metric when it's already in groupBy (cross-metric intent)", () => {
    const tracePlan: QueryPlanBody = {
      groupBy: ["Metric", "Markets"],
      aggregations: [{ column: "Value", operation: "sum" }],
    };
    const tableRows = [
      { Metric: "value_sales", Markets: "Off VN", Value_sum: 1234 },
      { Metric: "volume", Markets: "Off VN", Value_sum: 56 },
    ];
    const tableColumns = ["Metric", "Markets", "Value_sum"];
    const out = mergePivotDefaultRowsAndValues({
      dataSummary: compoundSummary,
      tracePlan,
      tableRows,
      tableColumns,
    });
    assert.ok(out);
    assert.equal(
      out!.filterSelections?.Metric,
      undefined,
      "Metric is part of the grouping, not a filter"
    );
  });

  it("falls back to first distinct metric when no value_sales-family value exists", () => {
    const customSummary: DataSummary = {
      ...compoundSummary,
      columns: compoundSummary.columns.map((c) =>
        c.name === "Metric"
          ? {
              ...c,
              topValues: [
                { value: "distribution", count: 4 },
                { value: "price", count: 4 },
              ],
            }
          : c
      ),
    };
    const tracePlan: QueryPlanBody = {
      groupBy: ["Markets"],
      aggregations: [{ column: "Value", operation: "sum" }],
    };
    const out = mergePivotDefaultRowsAndValues({
      dataSummary: customSummary,
      tracePlan,
      tableRows: [{ Markets: "Off VN", Value_sum: 1 }],
      tableColumns: ["Markets", "Value_sum"],
    });
    assert.deepEqual(out!.filterSelections?.Metric, ["distribution"]);
  });

  it("does nothing for pure_period shape (no Metric column)", () => {
    const purePeriod: WideFormatTransform = {
      ...compoundTransform,
      shape: "pure_period",
      metricColumn: undefined,
    };
    const purePeriodSummary: DataSummary = {
      ...compoundSummary,
      wideFormatTransform: purePeriod,
      columns: compoundSummary.columns.filter((c) => c.name !== "Metric"),
    };
    const tracePlan: QueryPlanBody = {
      groupBy: ["Markets"],
      aggregations: [{ column: "Value", operation: "sum" }],
    };
    const out = mergePivotDefaultRowsAndValues({
      dataSummary: purePeriodSummary,
      tracePlan,
      tableRows: [{ Markets: "Off VN", Value_sum: 1 }],
      tableColumns: ["Markets", "Value_sum"],
    });
    assert.ok(out);
    assert.equal(out!.filterSelections, undefined);
  });

  it("does nothing when wideFormatTransform is absent", () => {
    const noWfSummary: DataSummary = {
      ...compoundSummary,
      wideFormatTransform: undefined,
    };
    const tracePlan: QueryPlanBody = {
      groupBy: ["Markets"],
      aggregations: [{ column: "Value", operation: "sum" }],
    };
    const out = mergePivotDefaultRowsAndValues({
      dataSummary: noWfSummary,
      tracePlan,
      tableRows: [{ Markets: "Off VN", Value_sum: 1 }],
      tableColumns: ["Markets", "Value_sum"],
    });
    assert.ok(out);
    assert.equal(out!.filterSelections, undefined);
  });
});
