import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SUPPORTED_DATE_AGGREGATION_PERIODS,
  TEMPORAL_CAPABILITY_GAPS,
} from "../lib/agentTemporalCapabilities.js";
import { sanitizeReadonlyDatasetSql } from "../lib/agentReadonlySql.js";
import { applyDeriveDimensionBucket } from "../lib/deriveDimensionBucket.js";
import { executeQueryPlan } from "../lib/queryPlanExecutor.js";
import { lintAfterAnalyticalTool } from "../lib/agentToolObservationLint.js";
import { executeReadonlySqlOnFrame } from "../lib/agentReadonlySql.js";
import type { DataSummary } from "../shared/schema.js";
import type { ParsedQuery } from "../shared/queryTypes.js";

describe("agentTemporalCapabilities (gap inventory)", () => {
  it("documents supported date aggregation periods", () => {
    assert.ok(SUPPORTED_DATE_AGGREGATION_PERIODS.includes("week"));
    assert.ok(SUPPORTED_DATE_AGGREGATION_PERIODS.includes("half_year"));
    assert.ok(SUPPORTED_DATE_AGGREGATION_PERIODS.includes("year"));
    assert.ok(TEMPORAL_CAPABILITY_GAPS.includes("fiscal_year_with_anchor"));
  });
});

describe("sanitizeReadonlyDatasetSql", () => {
  it("accepts a single SELECT from dataset", () => {
    const r = sanitizeReadonlyDatasetSql(`SELECT * FROM dataset LIMIT 10`);
    assert.equal(r.ok, true);
  });
  it("rejects INSERT", () => {
    const r = sanitizeReadonlyDatasetSql(`INSERT INTO dataset VALUES (1)`);
    assert.equal(r.ok, false);
  });
  it("rejects queries without dataset", () => {
    const r = sanitizeReadonlyDatasetSql(`SELECT 1`);
    assert.equal(r.ok, false);
  });
});

describe("applyDeriveDimensionBucket", () => {
  it("maps source values into bucket labels", () => {
    const summary: DataSummary = {
      rowCount: 2,
      columnCount: 2,
      columns: [
        { name: "Region", type: "string", sampleValues: [] },
        { name: "Sales", type: "number", sampleValues: [1] },
      ],
      numericColumns: ["Sales"],
      dateColumns: [],
    };
    const data = [
      { Region: "East A", Sales: 10 },
      { Region: "West Z", Sales: 20 },
    ];
    const out = applyDeriveDimensionBucket(data, summary, {
      sourceColumn: "Region",
      newColumnName: "Macro",
      buckets: [
        { label: "E", values: ["East A"] },
        { label: "W", values: ["West Z"] },
      ],
    });
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.rows[0]!.Macro, "E");
    assert.equal(out.rows[1]!.Macro, "W");
  });
});

describe("execute_query_plan week and half_year", () => {
  const summary: DataSummary = {
    rowCount: 3,
    columnCount: 2,
    columns: [
      { name: "Order Date", type: "date", sampleValues: [] },
      { name: "Sales", type: "number", sampleValues: [1] },
    ],
    numericColumns: ["Sales"],
    dateColumns: ["Order Date"],
  };

  it("buckets by ISO week", () => {
    const data = [
      { "Order Date": new Date(2024, 0, 1), Sales: 5 },
      { "Order Date": new Date(2024, 0, 3), Sales: 7 },
      { "Order Date": new Date(2024, 0, 10), Sales: 2 },
    ];
    const out = executeQueryPlan(data, summary, {
      groupBy: ["Order Date"],
      dateAggregationPeriod: "week",
      aggregations: [{ column: "Sales", operation: "sum" }],
    });
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.ok(out.data.length >= 2);
  });

  it("buckets by half year", () => {
    const data = [
      { "Order Date": new Date(2024, 1, 1), Sales: 10 },
      { "Order Date": new Date(2024, 8, 1), Sales: 20 },
    ];
    const out = executeQueryPlan(data, summary, {
      groupBy: ["Order Date"],
      dateAggregationPeriod: "half_year",
      aggregations: [{ column: "Sales", operation: "sum" }],
    });
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.data.length, 2);
  });
});

describe("executeReadonlySqlOnFrame (optional DuckDB)", () => {
  it("runs SELECT * FROM dataset on tiny frame or reports unavailable", async () => {
    const data = [{ Region: "A", Sales: "10" }];
    const out = await executeReadonlySqlOnFrame(data, "SELECT * FROM dataset");
    if (!out.ok) {
      assert.match(
        out.error,
        /DuckDB|not available|Error|syntax|read_json/i
      );
      return;
    }
    assert.equal(out.rows.length, 1);
    assert.ok(out.columns.includes("Region"));
  });
});

describe("lintAfterAnalyticalTool", () => {
  it("emits SYSTEM_VALIDATION when question grain mismatches plan period", () => {
    const parsed: ParsedQuery = {
      rawQuestion: "",
      groupBy: ["Order Date"],
      dateAggregationPeriod: "day",
    };
    const lines = lintAfterAnalyticalTool({
      tool: "execute_query_plan",
      ok: true,
      question: "sales trend over the years",
      parsed,
      outputRowCount: 400,
    });
    assert.ok(lines.some((l) => l.includes("[SYSTEM_VALIDATION]")));
  });

  it("emits SYSTEM_VALIDATION for vague trend when single-row aggregate has no time bucket column", () => {
    const parsed: ParsedQuery = {
      rawQuestion: "",
      groupBy: [],
      dateAggregationPeriod: null,
      aggregations: [{ column: "Sales", operation: "sum" }],
    };
    const lines = lintAfterAnalyticalTool({
      tool: "execute_query_plan",
      ok: true,
      question: "sales trend",
      parsed,
      outputRowCount: 1,
      outputColumns: ["Sales_sum"],
      appliedAggregation: true,
    });
    assert.ok(
      lines.some(
        (l) =>
          l.includes("[SYSTEM_VALIDATION]") &&
          l.includes("time-bucket") &&
          l.includes("Replan")
      )
    );
  });

  it("does not emit trend single-row lint when output includes a temporal facet column", () => {
    const parsed: ParsedQuery = {
      rawQuestion: "",
      groupBy: ["Month · Order Date"],
      dateAggregationPeriod: null,
      aggregations: [{ column: "Sales", operation: "sum" }],
    };
    const lines = lintAfterAnalyticalTool({
      tool: "execute_query_plan",
      ok: true,
      question: "sales trend",
      parsed,
      outputRowCount: 1,
      outputColumns: ["Month · Order Date", "Sales_sum"],
      appliedAggregation: true,
    });
    assert.ok(!lines.some((l) => l.includes("time-bucket")));
  });
});
