import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRichDataSummary,
  type NumericColumnProfile,
  type DateColumnProfile,
  type CategoricalColumnProfile,
} from "../lib/richColumnProfile.js";
import type { DataSummary } from "../shared/schema.js";

function makeSummary(over: Partial<DataSummary>): DataSummary {
  return {
    rowCount: 0,
    columnCount: 0,
    columns: [],
    numericColumns: [],
    dateColumns: [],
    ...over,
  } as DataSummary;
}

const ROWS: Record<string, unknown>[] = [
  { price: 10, region: "North", launched: "2023-01-15", active: "Yes" },
  { price: 20, region: "South", launched: "2023-02-20", active: "No" },
  { price: 30, region: "North", launched: "2023-03-10", active: "Yes" },
  { price: 40, region: "East", launched: "2023-06-01", active: "Yes" },
  { price: 1000, region: "North", launched: "2024-01-01", active: "" }, // outlier + null bool
];

const SUMMARY = makeSummary({
  rowCount: 5,
  columnCount: 4,
  numericColumns: ["price"],
  dateColumns: ["launched"],
  columns: [
    { name: "price", type: "number", sampleValues: [10, 20, 30] },
    { name: "region", type: "string", sampleValues: ["North", "South"] },
    { name: "launched", type: "date", sampleValues: ["2023-01-15"] },
    {
      name: "active",
      type: "string",
      sampleValues: ["Yes", "No"],
      indicator: {
        kind: "boolean",
        positiveValues: ["Yes"],
        negativeValues: ["No"],
        source: "auto",
      },
    },
  ],
} as Partial<DataSummary>);

test("classifies columns by authoritative type, not re-detection", () => {
  const result = buildRichDataSummary(ROWS, SUMMARY);
  const byName = new Map(result.columns.map((c) => [c.name, c]));
  assert.equal(byName.get("price")?.kind, "numeric");
  assert.equal(byName.get("launched")?.kind, "date");
  assert.equal(byName.get("region")?.kind, "categorical");
  assert.equal(byName.get("active")?.kind, "boolean");
  assert.deepEqual(result.dataset.typeBreakdown, {
    numeric: 1,
    date: 1,
    categorical: 1,
    boolean: 1,
  });
});

test("numeric profile computes correct stats + flags outliers", () => {
  const result = buildRichDataSummary(ROWS, SUMMARY);
  const price = result.columns.find((c) => c.name === "price") as NumericColumnProfile;
  assert.equal(price.min, 10);
  assert.equal(price.max, 1000);
  assert.equal(price.sum, 1100);
  assert.equal(price.mean, 220);
  assert.equal(price.median, 30);
  assert.equal(price.integerLike, true);
  assert.equal(price.zeroCount, 0);
  assert.equal(price.negativeCount, 0);
  assert.ok(price.outlierCount >= 1, "1000 should be an IQR outlier");
  assert.ok(price.histogram.length > 0);
  assert.equal(price.nullCount, 0);
});

test("histogram bin count stays bounded for wide-range integers", () => {
  // A few integers spanning thousands must not produce one bin per integer.
  const rows = Array.from({ length: 50 }, (_, i) => ({ amt: i * 1000 }));
  const summary = makeSummary({
    rowCount: rows.length,
    numericColumns: ["amt"],
    columns: [{ name: "amt", type: "number", sampleValues: [0, 1000] }],
  } as Partial<DataSummary>);
  const result = buildRichDataSummary(rows, summary);
  const amt = result.columns[0] as NumericColumnProfile;
  assert.ok(amt.histogram.length <= 24, `expected ≤24 bins, got ${amt.histogram.length}`);
  assert.ok(amt.integerLike);
});

test("date profile parses dates chronologically (not lexically)", () => {
  const rows = [
    { d: "Apr-22" },
    { d: "Jan-23" },
    { d: "Dec-21" },
  ];
  const summary = makeSummary({
    rowCount: 3,
    dateColumns: ["d"],
    columns: [{ name: "d", type: "date", sampleValues: ["Apr-22"] }],
  } as Partial<DataSummary>);
  const result = buildRichDataSummary(rows, summary);
  const d = result.columns[0] as DateColumnProfile;
  assert.equal(d.kind, "date");
  // Dec-21 is the chronological min even though "Apr-22" < "Dec-21" lexically.
  assert.equal(d.minIso, "2021-12-01");
  assert.equal(d.maxIso, "2023-01-01");
  assert.ok((d.spanDays ?? 0) > 365);
  assert.equal(d.distinctDayCount, 3);
});

test("categorical profile ranks top values with percentages", () => {
  const result = buildRichDataSummary(ROWS, SUMMARY);
  const region = result.columns.find((c) => c.name === "region") as CategoricalColumnProfile;
  assert.equal(region.distinctCount, 3);
  assert.equal(region.mode, "North");
  assert.equal(region.topValues[0].value, "North");
  assert.equal(region.topValues[0].count, 3);
  assert.equal(region.topValues[0].pct, 60);
  assert.equal(region.isConstant, false);
});

test("boolean column keeps its positive/negative partition and counts nulls", () => {
  const result = buildRichDataSummary(ROWS, SUMMARY);
  const active = result.columns.find((c) => c.name === "active") as CategoricalColumnProfile;
  assert.equal(active.kind, "boolean");
  assert.deepEqual(active.positiveValues, ["Yes"]);
  assert.deepEqual(active.negativeValues, ["No"]);
  assert.equal(active.nullCount, 1); // the "" cell
});

test("dataset completeness + quality score reflect real nulls", () => {
  const result = buildRichDataSummary(ROWS, SUMMARY);
  assert.equal(result.dataset.totalCells, 20);
  assert.equal(result.dataset.totalNulls, 1);
  assert.equal(result.dataset.overallCompleteness, 95);
  assert.equal(result.qualityScore, 95);
  assert.equal(result.dataset.duplicateRowCount, 0);
});

test("hidden __tf_* facet columns are excluded", () => {
  const rows = [{ region: "North", __tf_month: "2023-01" }];
  const summary = makeSummary({
    rowCount: 1,
    columns: [
      { name: "region", type: "string", sampleValues: ["North"] },
      {
        name: "__tf_month",
        type: "string",
        sampleValues: ["2023-01"],
        temporalFacetGrain: "month",
        temporalFacetSource: "launched",
      },
    ],
  } as Partial<DataSummary>);
  const result = buildRichDataSummary(rows, summary);
  assert.equal(result.columns.length, 1);
  assert.equal(result.columns[0].name, "region");
});
