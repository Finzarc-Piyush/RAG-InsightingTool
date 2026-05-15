import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  queryPlanBodySchema,
  executeQueryPlan,
  windowAggregationSchema,
} from "../lib/queryPlanExecutor.js";
import type { DataSummary } from "../shared/schema.js";

/**
 * Wave W1 · Pins the windowAggregations surface.
 *
 * The schema accepts SUM/MEAN/MIN/MAX/COUNT (windowed aggregates),
 * ROW_NUMBER/RANK/DENSE_RANK (ranking), and LAG/LEAD (positional).
 * Frame shapes are `{rows: N}` (rolling) or `{range: "unbounded_preceding"}`
 * (cumulative).
 *
 * The in-memory executor materialises the window's output column onto
 * every row BEFORE the rest of the plan runs (so the alias can be
 * referenced by groupBy / aggregations / sort).
 *
 * Production traffic hits the DuckDB executor; the in-memory path is
 * the fallback for chart enrichment + small-dataset paths. Behaviour
 * parity between the two paths is tested via the DuckDB SQL builder
 * unit elsewhere (covered indirectly by the existing
 * `queryPlanDuckdbExecutor.test.ts` regression sweep).
 */

const summary: DataSummary = {
  rowCount: 12,
  columnCount: 3,
  numericColumns: ["Sales"],
  dateColumns: ["Week"],
  columns: [
    { name: "Brand", type: "string", sampleValues: ["A", "B"] },
    { name: "Week", type: "string", sampleValues: ["2024-W01", "2024-W02"] },
    { name: "Sales", type: "number", sampleValues: [100, 200] },
  ],
};

describe("Wave W1 · windowAggregationSchema validates the surface", () => {
  it("accepts a rolling 4-week mean", () => {
    const w = windowAggregationSchema.parse({
      alias: "rolling_4wk",
      operation: "mean",
      column: "Sales",
      partitionBy: ["Brand"],
      orderBy: [{ column: "Week", direction: "asc" }],
      frame: { rows: 4 },
    });
    assert.equal(w.alias, "rolling_4wk");
    assert.equal(w.operation, "mean");
  });

  it("accepts cumulative sum (unbounded preceding)", () => {
    const w = windowAggregationSchema.parse({
      alias: "cum_sales",
      operation: "sum",
      column: "Sales",
      partitionBy: ["Brand"],
      orderBy: [{ column: "Week", direction: "asc" }],
      frame: { range: "unbounded_preceding" },
    });
    assert.equal(w.operation, "sum");
  });

  it("accepts row_number / rank / dense_rank without a column", () => {
    const r = windowAggregationSchema.parse({
      alias: "rk",
      operation: "row_number",
      orderBy: [{ column: "Sales", direction: "desc" }],
    });
    assert.equal(r.operation, "row_number");
  });

  it("rejects ranking ops with frame", () => {
    assert.throws(() =>
      windowAggregationSchema.parse({
        alias: "rk",
        operation: "rank",
        orderBy: [{ column: "Sales", direction: "desc" }],
        frame: { rows: 3 },
      })
    );
  });

  it("rejects sum/mean/min/max/lag/lead without column", () => {
    assert.throws(() =>
      windowAggregationSchema.parse({
        alias: "x",
        operation: "sum",
        orderBy: [{ column: "Week", direction: "asc" }],
      })
    );
  });

  it("queryPlanBodySchema accepts windowAggregations and caps at 6", () => {
    const plan = queryPlanBodySchema.parse({
      windowAggregations: [
        {
          alias: "w1",
          operation: "sum",
          column: "Sales",
          orderBy: [{ column: "Week", direction: "asc" }],
        },
      ],
    });
    assert.equal(plan.windowAggregations?.length, 1);
    assert.throws(() =>
      queryPlanBodySchema.parse({
        windowAggregations: Array.from({ length: 7 }, (_, i) => ({
          alias: `w${i}`,
          operation: "sum",
          column: "Sales",
          orderBy: [{ column: "Week", direction: "asc" }],
        })),
      })
    );
  });
});

describe("Wave W1 · in-memory executor materialises window columns", () => {
  function mkRows(): Record<string, any>[] {
    return [
      { Brand: "A", Week: "2024-W01", Sales: 100 },
      { Brand: "A", Week: "2024-W02", Sales: 200 },
      { Brand: "A", Week: "2024-W03", Sales: 300 },
      { Brand: "A", Week: "2024-W04", Sales: 400 },
      { Brand: "B", Week: "2024-W01", Sales: 50 },
      { Brand: "B", Week: "2024-W02", Sales: 60 },
      { Brand: "B", Week: "2024-W03", Sales: 70 },
      { Brand: "B", Week: "2024-W04", Sales: 80 },
    ];
  }

  it("rolling 3-week sum per brand walks the partition correctly", () => {
    const result = executeQueryPlan(mkRows(), summary, {
      windowAggregations: [
        {
          alias: "roll3",
          operation: "sum",
          column: "Sales",
          partitionBy: ["Brand"],
          orderBy: [{ column: "Week", direction: "asc" }],
          frame: { rows: 3 },
        },
      ],
    });
    assert.ok(result.ok);
    const rows = result.data;
    // Brand A, sorted: 100, 200, 300, 400 → rolling 3 → 100, 300, 600, 900
    const brandA = rows.filter((r) => r.Brand === "A");
    const aOrdered = brandA.sort((a, b) => a.Week.localeCompare(b.Week));
    assert.equal(aOrdered[0].roll3, 100);
    assert.equal(aOrdered[1].roll3, 300);
    assert.equal(aOrdered[2].roll3, 600);
    assert.equal(aOrdered[3].roll3, 900);
    // Brand B isolated → 50, 110, 180, 210
    const brandB = rows.filter((r) => r.Brand === "B").sort((a, b) =>
      a.Week.localeCompare(b.Week)
    );
    assert.equal(brandB[0].roll3, 50);
    assert.equal(brandB[3].roll3, 210); // 60+70+80
  });

  it("cumulative sum (unbounded preceding) per brand", () => {
    const result = executeQueryPlan(mkRows(), summary, {
      windowAggregations: [
        {
          alias: "cum",
          operation: "sum",
          column: "Sales",
          partitionBy: ["Brand"],
          orderBy: [{ column: "Week", direction: "asc" }],
          frame: { range: "unbounded_preceding" },
        },
      ],
    });
    assert.ok(result.ok);
    const a = result.data
      .filter((r) => r.Brand === "A")
      .sort((x, y) => x.Week.localeCompare(y.Week));
    assert.equal(a[0].cum, 100);
    assert.equal(a[1].cum, 300);
    assert.equal(a[2].cum, 600);
    assert.equal(a[3].cum, 1000);
  });

  it("dense_rank by Sales desc per brand", () => {
    const rows = [
      { Brand: "A", Week: "W1", Sales: 100 },
      { Brand: "A", Week: "W2", Sales: 100 },
      { Brand: "A", Week: "W3", Sales: 50 },
    ];
    const result = executeQueryPlan(rows, summary, {
      windowAggregations: [
        {
          alias: "rk",
          operation: "dense_rank",
          partitionBy: ["Brand"],
          orderBy: [{ column: "Sales", direction: "desc" }],
        },
      ],
    });
    assert.ok(result.ok);
    const sortedBySales = result.data.sort((x, y) => y.Sales - x.Sales);
    assert.equal(sortedBySales[0].rk, 1);
    assert.equal(sortedBySales[1].rk, 1); // tie
    assert.equal(sortedBySales[2].rk, 2); // dense_rank: no gap after tie
  });

  it("lag(Sales, 1) per brand computes month-over-month previous value", () => {
    const result = executeQueryPlan(mkRows(), summary, {
      windowAggregations: [
        {
          alias: "prev",
          operation: "lag",
          column: "Sales",
          partitionBy: ["Brand"],
          orderBy: [{ column: "Week", direction: "asc" }],
        },
      ],
    });
    assert.ok(result.ok);
    const a = result.data
      .filter((r) => r.Brand === "A")
      .sort((x, y) => x.Week.localeCompare(y.Week));
    assert.equal(a[0].prev, null); // no prior row
    assert.equal(a[1].prev, 100);
    assert.equal(a[2].prev, 200);
    assert.equal(a[3].prev, 300);
  });

  it("window alias columns appear on every output row (visible to clients reading the result table)", () => {
    const result = executeQueryPlan(mkRows(), summary, {
      windowAggregations: [
        {
          alias: "cum",
          operation: "sum",
          column: "Sales",
          partitionBy: ["Brand"],
          orderBy: [{ column: "Week", direction: "asc" }],
          frame: { range: "unbounded_preceding" },
        },
      ],
      limit: 100,
    });
    assert.ok(result.ok);
    // Every output row carries the window column.
    for (const r of result.data) {
      assert.ok("cum" in r, "every row must carry the window alias column");
      assert.ok(typeof r.cum === "number");
    }
    // Spot-check Brand A's last-week cumulative = 1000.
    const aLast = result.data
      .filter((r) => r.Brand === "A")
      .sort((x, y) => x.Week.localeCompare(y.Week))[3];
    assert.equal(aLast.cum, 1000);
  });
});

describe("Wave W1 · large-dataset cap", () => {
  it("rejects in-memory window passes over 100k rows", () => {
    const big = Array.from({ length: 100_001 }, (_, i) => ({
      Brand: "A",
      Week: `W${i}`,
      Sales: i,
    }));
    const result = executeQueryPlan(big, summary, {
      windowAggregations: [
        {
          alias: "cum",
          operation: "sum",
          column: "Sales",
          orderBy: [{ column: "Week", direction: "asc" }],
          frame: { range: "unbounded_preceding" },
        },
      ],
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /100k cap|DuckDB/);
    }
  });
});
