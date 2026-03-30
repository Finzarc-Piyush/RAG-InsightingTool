import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildAnalyticalChartSpecs,
  shouldBuildDeterministicAnalyticalCharts,
} from "../lib/analyticalChartBuilders.js";
import { pivotLongToWideBar, sanitizeSeriesKey, processChartData } from "../lib/chartGenerator.js";
import type { DataSummary } from "../shared/schema.js";
import type { ParsedQuery } from "../shared/queryTypes.js";

describe("analyticalChartSpec", () => {
  it("shouldBuildDeterministic when two groupBy dimensions", () => {
    assert.equal(
      shouldBuildDeterministicAnalyticalCharts("give me sales", { groupBy: ["a", "b"] } as ParsedQuery, [
        "a",
        "b",
        "c",
      ]),
      true
    );
  });

  it("buildAnalyticalChartSpecs returns stacked bar for two group columns", () => {
    const rows = [
      { region: "N", segment: "S1", sales_sum: 10 },
      { region: "N", segment: "S2", sales_sum: 20 },
    ];
    const summary: DataSummary = {
      rowCount: 2,
      columnCount: 3,
      columns: [
        { name: "region", type: "string", sampleValues: [] },
        { name: "segment", type: "string", sampleValues: [] },
        { name: "sales_sum", type: "number", sampleValues: [] },
      ],
      numericColumns: ["sales_sum"],
      dateColumns: [],
    };
    const pq: ParsedQuery = {
      rawQuestion: "",
      groupBy: ["region", "segment"],
      aggregations: [{ column: "sales", operation: "sum", alias: "sales_sum" }],
    };
    const specs = buildAnalyticalChartSpecs(rows, summary, pq, "sales by region by segment");
    assert.equal(specs.length, 1);
    assert.equal(specs[0].type, "bar");
    assert.equal(specs[0].seriesColumn, "segment");
    assert.equal(specs[0].x, "region");
  });

  it("sanitizeSeriesKey strips unsafe characters", () => {
    assert.match(sanitizeSeriesKey("A/B"), /^A_B$/);
  });

  it("pivotLongToWideBar produces seriesKeys and wide rows", () => {
    const rows = [
      { region: "N", segment: "S1", sales: 5 },
      { region: "N", segment: "S2", sales: 7 },
      { region: "S", segment: "S1", sales: 3 },
    ];
    const spec = {
      type: "bar" as const,
      title: "t",
      x: "region",
      y: "sales",
      seriesColumn: "segment",
    };
    const { rows: wide, seriesKeys } = pivotLongToWideBar(
      rows,
      "region",
      "segment",
      "sales",
      "sum",
      spec
    );
    assert.ok(seriesKeys.length >= 1);
    assert.equal(wide.length, 2);
    const proc = processChartData(rows, {
      ...spec,
      barLayout: "stacked",
      aggregate: "sum",
    });
    assert.ok(proc.length >= 1);
  });
});
