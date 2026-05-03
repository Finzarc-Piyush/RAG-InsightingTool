// WPF8 · End-to-end golden test that pins the full compound-shape contract
// from upload-time melt through planner-side guards and SQL builder.
//
// Validates that on a wide compound dataset asking "compare value sales by
// Markets in Q1 23 vs Q1 24":
//  (a) Wide format is detected and melted to long form (Markets/Period/PeriodIso/PeriodKind/Metric/Value).
//  (b) The planner-side compound-shape guard injects a Metric filter for
//      value_sales (so SUM(Value) doesn't mix value_sales + volume).
//  (c) The DuckDB SQL builder, when grouping by Period, also adds PeriodIso
//      to GROUP BY and ORDER BY so chronological order is preserved.
//  (d) The fallback re-parse helper restores long-form rows when the original
//      wide buffer is re-read (large-file scenario).
//
// This is a deterministic pipeline test — no LLM calls, no DuckDB execution.
// It pins the contract of the deterministic guards added in WPF1–WPF7.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseFile,
  createDataSummary,
} from "../lib/fileParser.js";
import { classifyDataset } from "../lib/wideFormat/classifyDataset.js";
import { meltDataset } from "../lib/wideFormat/meltDataset.js";
import { applyWideFormatTransformToSummary } from "../lib/wideFormat/applyWideFormatToSummary.js";
import { applyWideFormatMeltIfNeeded } from "../lib/wideFormat/applyWideFormatMeltIfNeeded.js";
import {
  injectCompoundShapeMetricGuard,
  extractDistinctMetricValues,
} from "../lib/agents/runtime/planArgRepairs.js";
import { buildQueryPlanDuckdbSql } from "../lib/queryPlanDuckdbExecutor.js";
import type { PlanStep } from "../lib/agents/runtime/types.js";

function csv(rows: string[]): Buffer {
  return Buffer.from(rows.join("\n"), "utf-8");
}

// 2 brands × 4 quarters × 2 metrics = 16 long rows after melt.
// Header carries period + metric → compound shape.
const buf = csv([
  'Markets,Products,"Q1 23 Value Sales","Q1 23 Volume","Q2 23 Value Sales","Q2 23 Volume","Q1 24 Value Sales","Q1 24 Volume","Q2 24 Value Sales","Q2 24 Volume"',
  'Off VN,MARICO,"đ100,000,000","1000","đ110,000,000","1100","đ130,000,000","1300","đ140,000,000","1400"',
  'Off VN,OLIV,"đ50,000,000","500","đ55,000,000","550","đ65,000,000","650","đ70,000,000","700"',
]);

describe("WPF8 · golden e2e — compound-shape pipeline + guards", () => {
  it("upload pipeline detects compound shape and melts to long form", async () => {
    let data = await parseFile(buf, "marico-vn-compound.csv");
    assert.equal(data.length, 2);

    const headers = Object.keys(data[0] ?? {});
    const classification = classifyDataset(headers);
    assert.equal(classification.isWide, true);
    assert.equal(classification.shape, "compound");

    const melted = meltDataset(data, classification);
    // 2 rows × 8 melted columns = 16 long rows
    assert.equal(melted.rows.length, 16);
    assert.equal(melted.summary.shape, "compound");
    assert.equal(melted.summary.metricColumn, "Metric");

    // Long-form schema check
    for (const r of melted.rows) {
      assert.ok("Markets" in r);
      assert.ok("Period" in r);
      assert.ok("PeriodIso" in r);
      assert.ok("PeriodKind" in r);
      assert.ok("Metric" in r);
      assert.ok("Value" in r);
      assert.equal(typeof r.Value, "number");
    }

    data = melted.rows;
    const summary = createDataSummary(data);
    applyWideFormatTransformToSummary(summary, {
      detected: true,
      shape: melted.summary.shape,
      idColumns: melted.summary.idColumns,
      meltedColumns: melted.summary.meltedColumns,
      periodCount: melted.summary.periodCount,
      periodColumn: melted.summary.periodColumn,
      periodIsoColumn: melted.summary.periodIsoColumn,
      periodKindColumn: melted.summary.periodKindColumn,
      valueColumn: melted.summary.valueColumn,
      metricColumn: melted.summary.metricColumn,
      detectedCurrencySymbol: melted.summary.detectedCurrencySymbol,
    });

    assert.equal(summary.wideFormatTransform?.detected, true);
    assert.equal(summary.wideFormatTransform?.shape, "compound");
    assert.equal(summary.wideFormatTransform?.metricColumn, "Metric");
    // VND tag should propagate to the long Value column.
    const valueCol = summary.columns.find((c) => c.name === "Value");
    assert.equal(valueCol?.currency?.isoCode, "VND");
  });

  it("compound-shape guard injects Metric=value_sales for sales-intent question", async () => {
    let data = await parseFile(buf, "marico-vn-compound.csv");
    const classification = classifyDataset(Object.keys(data[0] ?? {}));
    const melted = meltDataset(data, classification);
    data = melted.rows;

    const distincts = extractDistinctMetricValues(data, "Metric");
    // metricVocabulary's canonical names are Title Case ("Value Sales",
    // "Volume Sales") — the WPF2 metric-keyword regex tolerates both
    // snake_case and Title-Case variants (case-insensitive `value\s+sales`
    // and `\bvolume\b`).
    assert.ok(
      distincts.includes("Value Sales"),
      `expected "Value Sales" in distincts, got: ${distincts.join(", ")}`
    );
    assert.ok(
      distincts.some((d) => /volume/i.test(d)),
      `expected a volume metric in distincts, got: ${distincts.join(", ")}`
    );

    const step: PlanStep = {
      id: "s1",
      tool: "execute_query_plan",
      args: {
        plan: {
          groupBy: ["Markets", "Period"],
          aggregations: [{ column: "Value", operation: "sum" }],
        },
      },
    };
    const result = injectCompoundShapeMetricGuard(
      step,
      {
        detected: true,
        shape: "compound",
        idColumns: melted.summary.idColumns,
        meltedColumns: melted.summary.meltedColumns,
        periodCount: melted.summary.periodCount,
        periodColumn: "Period",
        periodIsoColumn: "PeriodIso",
        periodKindColumn: "PeriodKind",
        valueColumn: "Value",
        metricColumn: "Metric",
        detectedCurrencySymbol: "đ",
      },
      "compare value sales by Markets in Q1 23 vs Q1 24",
      distincts
    );
    assert.deepEqual(result.injectedFilter, ["Value Sales"]);
    const filters = (step.args.plan as any).dimensionFilters as any[];
    assert.equal(filters.length, 1);
    assert.equal(filters[0].column, "Metric");
    assert.equal(filters[0].op, "in");
  });

  it("DuckDB SQL groups Period chronologically via PeriodIso", async () => {
    let data = await parseFile(buf, "marico-vn-compound.csv");
    const classification = classifyDataset(Object.keys(data[0] ?? {}));
    const melted = meltDataset(data, classification);
    data = melted.rows;
    const summary = createDataSummary(data);
    applyWideFormatTransformToSummary(summary, {
      detected: true,
      shape: melted.summary.shape,
      idColumns: melted.summary.idColumns,
      meltedColumns: melted.summary.meltedColumns,
      periodCount: melted.summary.periodCount,
      periodColumn: "Period",
      periodIsoColumn: "PeriodIso",
      periodKindColumn: "PeriodKind",
      valueColumn: "Value",
      metricColumn: "Metric",
      detectedCurrencySymbol: "đ",
    });

    const built = buildQueryPlanDuckdbSql(
      {
        groupBy: ["Markets", "Period"],
        aggregations: [{ column: "Value", operation: "sum" }],
        dimensionFilters: [
          { column: "Metric", op: "in", values: ["value_sales"] },
        ],
      },
      {
        tableColumns: new Set([
          "Markets",
          "Products",
          "Period",
          "PeriodIso",
          "PeriodKind",
          "Metric",
          "Value",
        ]),
        summary,
      }
    );
    assert.ok(built);
    assert.match(built!.aggregateSql, /"PeriodIso" AS "PeriodIso"/);
    assert.match(built!.aggregateSql, /GROUP BY .*"Period".*"PeriodIso"/);
    assert.match(built!.aggregateSql, /ORDER BY "PeriodIso" ASC/);
    assert.deepEqual(built!.hiddenColumns, ["PeriodIso"]);
  });

  it("fallback re-parse re-melts the wide buffer when dataSummary expects long form", async () => {
    // Simulate the large-file path: rawData is empty, currentDataBlob is null,
    // so dataLoader re-parses the original wide buffer. Without WPF4 the
    // returned rows would be wide; the WPF4 helper must re-melt them.
    const wideRows = await parseFile(buf, "marico-vn-compound.csv");
    assert.equal(wideRows.length, 2);

    const summaryWithTransform = {
      rowCount: 16,
      columnCount: 7,
      columns: [
        { name: "Markets", type: "string", sampleValues: [] },
        { name: "Products", type: "string", sampleValues: [] },
        { name: "Period", type: "string", sampleValues: [] },
        { name: "PeriodIso", type: "string", sampleValues: [] },
        { name: "PeriodKind", type: "string", sampleValues: [] },
        { name: "Metric", type: "string", sampleValues: [] },
        { name: "Value", type: "number", sampleValues: [] },
      ],
      numericColumns: ["Value"],
      dateColumns: [],
      wideFormatTransform: {
        detected: true as const,
        shape: "compound" as const,
        idColumns: ["Markets", "Products"],
        meltedColumns: [
          "Q1 23 Value Sales",
          "Q1 23 Volume",
          "Q2 23 Value Sales",
          "Q2 23 Volume",
          "Q1 24 Value Sales",
          "Q1 24 Volume",
          "Q2 24 Value Sales",
          "Q2 24 Volume",
        ],
        periodCount: 8,
        periodColumn: "Period",
        periodIsoColumn: "PeriodIso",
        periodKindColumn: "PeriodKind",
        valueColumn: "Value",
        metricColumn: "Metric",
        detectedCurrencySymbol: "đ",
      },
    };

    const out = applyWideFormatMeltIfNeeded(wideRows, summaryWithTransform);
    assert.equal(out.remelted, true);
    assert.equal(out.rows.length, 16);
    for (const r of out.rows) {
      assert.ok("Period" in r);
      assert.ok("Metric" in r);
      assert.ok("Value" in r);
    }
  });
});
