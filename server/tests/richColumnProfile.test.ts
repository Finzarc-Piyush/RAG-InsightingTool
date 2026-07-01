import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRichDataSummary,
  computeFullColumnNumericStats,
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
    empty: 0,
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

// ── Semantic-type-driven presentation (the user's fixes) ────────────────────

function semanticSummary(
  colName: string,
  semantics: NonNullable<DataSummary["columns"][number]["semantics"]>,
  extra: Partial<DataSummary["columns"][number]> = {},
): DataSummary {
  return makeSummary({
    rowCount: 3,
    numericColumns: extra.type === "number" ? [colName] : [],
    dateColumns: extra.type === "date" ? [colName] : [],
    columns: [
      { name: colName, type: extra.type ?? "number", sampleValues: [], semantics, ...extra },
    ],
  } as Partial<DataSummary>);
}

test("ratio_percent measure → sum suppressed, mean kept (SS5-7: never sum a %)", () => {
  const rows = [{ margin: 12 }, { margin: 18 }, { margin: 30 }];
  const summary = semanticSummary("margin", {
    semanticType: "measure_ratio_percent",
    aggregation: "avg",
    displayKind: "numeric",
    source: "deterministic",
  }, { type: "number" });
  const m = buildRichDataSummary(rows, summary).columns[0] as NumericColumnProfile;
  assert.equal(m.kind, "numeric");
  assert.equal(m.sum, null); // never summed
  assert.equal(m.mean, 20); // mean still meaningful
});

test("ordinal (fy_month_number) → mean+sum null, counts as categorical (SS3)", () => {
  const rows = [{ fy_month_number: 1 }, { fy_month_number: 1 }, { fy_month_number: 1 }];
  const summary = semanticSummary("fy_month_number", {
    semanticType: "ordinal",
    aggregation: "none",
    displayKind: "ordinal",
    source: "deterministic",
  }, { type: "number" });
  const result = buildRichDataSummary(rows, summary);
  const o = result.columns[0] as NumericColumnProfile;
  assert.equal(o.kind, "ordinal");
  assert.equal(o.mean, null);
  assert.equal(o.sum, null);
  assert.equal(o.min, 1); // order statistic kept
  assert.equal(result.dataset.typeBreakdown.categorical, 1);
  assert.equal(result.dataset.typeBreakdown.numeric, 0);
});

test("temporal_year → date tally, no mean/sum (SS2)", () => {
  const rows = [{ Year: 26 }, { Year: 26 }, { Year: 26 }];
  const summary = semanticSummary("Year", {
    semanticType: "temporal_year",
    aggregation: "none",
    displayKind: "date",
    temporalGrain: "year",
    source: "deterministic",
  }, { type: "number" });
  const result = buildRichDataSummary(rows, summary);
  assert.equal(result.dataset.typeBreakdown.date, 1);
  assert.equal(result.dataset.typeBreakdown.numeric, 0);
});

test("single-date Month column → grain monthOrQuarter, NOT dayOrWeek (SS1)", () => {
  const rows = [
    { Month: "2026-04-01" },
    { Month: "2026-04-01" },
    { Month: "2026-04-01" },
  ];
  const summary = semanticSummary("Month", {
    semanticType: "temporal_month",
    aggregation: "none",
    displayKind: "date",
    temporalGrain: "monthOrQuarter",
    source: "deterministic",
  }, { type: "date" });
  const d = buildRichDataSummary(rows, summary).columns[0] as DateColumnProfile;
  assert.equal(d.kind, "date");
  assert.equal(d.grain, "monthOrQuarter");
});

test("empty column (100% blank) → empty profile + empty tally (SS4)", () => {
  const rows = [{ UGST: null }, { UGST: "" }, { UGST: null }];
  const summary = semanticSummary("UGST", {
    semanticType: "empty",
    aggregation: "none",
    displayKind: "empty",
    source: "deterministic",
  }, { type: "string" });
  const result = buildRichDataSummary(rows, summary);
  assert.equal(result.columns[0].kind, "empty");
  assert.equal(result.columns[0].nullPct, 100);
  assert.equal(result.dataset.typeBreakdown.empty, 1);
});

test("sum/min/max come from FULL column even when profiled rows are a sample (P3)", () => {
  // Full data: sum 55, min 1, max 10. Simulate the endpoint sampling to 3 rows
  // by passing full stats + a reduced `data`.
  const fullData = Array.from({ length: 10 }, (_, i) => ({ v: i + 1 }));
  const fullStats = computeFullColumnNumericStats(fullData, ["v"]);
  const sampledData = [{ v: 1 }, { v: 5 }, { v: 9 }]; // a sample; its own sum is 15
  const summary = makeSummary({
    rowCount: 10,
    numericColumns: ["v"],
    columns: [{ name: "v", type: "number", sampleValues: [1, 2, 3] }],
  } as Partial<DataSummary>);
  const result = buildRichDataSummary(sampledData, summary, {
    fullColumnNumericStats: fullStats,
  });
  const v = result.columns[0] as NumericColumnProfile;
  assert.equal(v.sum, 55); // full sum, NOT the sample's 15
  assert.equal(v.min, 1);
  assert.equal(v.max, 10);
  assert.equal(v.mean, 5.5);
});

test("accounting-negative strings parse to negatives, not positives (N1)", () => {
  const rows = [{ adj: "(1.5)" }, { adj: "2.0" }, { adj: "(3)" }];
  const summary = makeSummary({
    rowCount: 3,
    numericColumns: ["adj"],
    columns: [{ name: "adj", type: "number", sampleValues: ["(1.5)"] }],
  } as Partial<DataSummary>);
  const p = buildRichDataSummary(rows, summary).columns[0] as NumericColumnProfile;
  assert.equal(p.min, -3); // not +3
  assert.equal(p.negativeCount, 2);
  assert.equal(p.sum, -2.5); // -1.5 + 2 - 3, not +6.5
});

test("no semantics → legacy numeric/date membership routing is preserved", () => {
  // SUMMARY has no `semantics` on any column; behaves exactly as before.
  const result = buildRichDataSummary(ROWS, SUMMARY);
  const price = result.columns.find((c) => c.name === "price") as NumericColumnProfile;
  assert.equal(price.kind, "numeric");
  assert.equal(price.sum, 1100); // still summed (default aggregation)
});
