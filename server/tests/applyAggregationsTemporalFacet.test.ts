import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyQueryTransformations, resolveDateBucketForGroupBy } from "../lib/dataTransform.js";
import type { DataSummary } from "../shared/schema.js";
import type { ParsedQuery } from "../shared/queryTypes.js";

function makeSummary(): DataSummary {
  return {
    rowCount: 0,
    columnCount: 2,
    columns: [
      { name: "Order Date", type: "date", sampleValues: [] },
      { name: "Sales", type: "number", sampleValues: [] },
    ],
    numericColumns: ["Sales"],
    dateColumns: ["Order Date"],
  };
}

/**
 * Regression: with plans like groupBy=["Month · Order Date"] + sum(Sales) and
 * dateAggregationPeriod cleared, rows loaded from columnar storage don't carry
 * the virtual facet column — the aggregator used to collapse every row into a
 * single "null" group. After the fix, the display facet key must decompose into
 * its source date column + grain and bucket through normalizeDateToPeriod.
 */
describe("applyQueryTransformations — temporal facet groupBy (no dateAggregationPeriod)", () => {
  const summary = makeSummary();

  it("buckets Month · Order Date into monthly groups when period is absent", () => {
    const data: Record<string, any>[] = [
      { "Order Date": "2017-01-03T00:00:00.000Z", Sales: 100 },
      { "Order Date": "2017-01-28T00:00:00.000Z", Sales: 50 },
      { "Order Date": "2017-02-10T00:00:00.000Z", Sales: 200 },
      { "Order Date": "2017-03-15T00:00:00.000Z", Sales: 75 },
      { "Order Date": "2018-01-02T00:00:00.000Z", Sales: 400 },
      { "Order Date": "2018-04-20T00:00:00.000Z", Sales: 300 },
    ];
    const parsed: ParsedQuery = {
      rawQuestion: "sales trend",
      groupBy: ["Month · Order Date"],
      aggregations: [{ column: "Sales", operation: "sum", alias: "Sales_sum" }],
      dateAggregationPeriod: null,
    };

    const { data: out } = applyQueryTransformations(data, summary, parsed);
    assert.strictEqual(out.length, 5, `expected 5 month buckets, got ${out.length}: ${JSON.stringify(out)}`);
    for (const row of out) {
      const key = row["Month · Order Date"];
      // normalizeDateToPeriod produces human labels like "Jan 2017", never "null"/"undefined".
      assert.match(
        String(key),
        /^[A-Z][a-z]{2} \d{4}$/,
        `expected MMM YYYY bucket key, got ${JSON.stringify(key)}`
      );
      assert.notStrictEqual(key, "null");
      assert.notStrictEqual(key, "undefined");
    }
    const total = out.reduce((s, r) => s + (r.Sales_sum as number), 0);
    assert.strictEqual(total, 100 + 50 + 200 + 75 + 400 + 300);
    const jan2017 = out.find((r) => r["Month · Order Date"] === "Jan 2017");
    assert.ok(jan2017, "expected Jan 2017 bucket");
    assert.strictEqual(jan2017!.Sales_sum, 150);
  });

  it("buckets Year · Order Date into YYYY keys", () => {
    const data: Record<string, any>[] = [
      { "Order Date": "2017-01-03", Sales: 10 },
      { "Order Date": "2017-06-15", Sales: 20 },
      { "Order Date": "2018-02-10", Sales: 30 },
      { "Order Date": "2018-12-31", Sales: 40 },
    ];
    const parsed: ParsedQuery = {
      rawQuestion: "yearly sales",
      groupBy: ["Year · Order Date"],
      aggregations: [{ column: "Sales", operation: "sum", alias: "Sales_sum" }],
    };

    const { data: out } = applyQueryTransformations(data, summary, parsed);
    const keys = out.map((r) => String(r["Year · Order Date"])).sort();
    assert.deepStrictEqual(keys, ["2017", "2018"]);
    const byYear: Record<string, number> = {};
    for (const r of out) byYear[String(r["Year · Order Date"])] = r.Sales_sum as number;
    assert.strictEqual(byYear["2017"], 30);
    assert.strictEqual(byYear["2018"], 70);
  });

  it("resolveDateBucketForGroupBy returns facetPeriod for display facet keys", () => {
    const res = resolveDateBucketForGroupBy(
      "Month · Order Date",
      summary,
      [{ "Order Date": "2017-01-03" }],
      null
    );
    assert.strictEqual(res.mode, "schema");
    assert.strictEqual(res.readColumn, "Order Date");
    assert.strictEqual(res.facetPeriod, "month");
  });

  it("resolveDateBucketForGroupBy ignores facet keys whose source is not a date column", () => {
    const badSummary: DataSummary = { ...summary, dateColumns: [] };
    const res = resolveDateBucketForGroupBy(
      "Month · Order Date",
      badSummary,
      [{ Sales: 1 }],
      null
    );
    assert.strictEqual(res.mode, "none");
    assert.strictEqual(res.facetPeriod, undefined);
  });
});
