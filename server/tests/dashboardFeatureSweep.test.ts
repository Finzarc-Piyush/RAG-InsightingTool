import { test } from "node:test";
import assert from "node:assert/strict";

import {
  enumerateMissingDashboardCharts,
  __test__ as sweepTest,
} from "../lib/agents/runtime/dashboardFeatureSweep.js";
import type { AgentExecutionContext } from "../lib/agents/runtime/types.js";
import type { AnalysisBrief, ChartSpec, DataSummary } from "../shared/schema.js";
import { isTemporalFacetColumnKey } from "../lib/temporalFacetColumns.js";

/** Build a ctx whose summary carries temporal-facet columns + a base date
 *  column with `dateRange`, for the W3 grain-selection tests. */
/** Emit `days` consecutive daily rows from `startIso` with materialized facet
 *  columns (Day/Week/Month · Date), so the grain authority can count REAL
 *  buckets from the rows even when dateRange metadata is absent. */
function genDailyRows(startIso: string, days: number): Record<string, unknown>[] {
  const start = new Date(startIso + "T00:00:00");
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(start.getTime());
    d.setDate(d.getDate() + i);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const iso = `${y}-${m}-${day}`;
    const week = Math.ceil((d.getTime() - new Date(y, 0, 1).getTime()) / (7 * 86400000)) + 1;
    rows.push({
      ASM: i % 2 === 0 ? "North" : "South",
      Date: iso,
      "Day · Date": iso,
      "Week · Date": `${y}-W${String(week).padStart(2, "0")}`,
      "Month · Date": `${y}-${m}`,
      Sales: 100 + i,
    });
  }
  return rows;
}

function makeTemporalCtx(
  dateRange: {
    spanDays: number;
    distinctDayCount: number;
    minIso?: string;
    maxIso?: string;
  } | null,
  rows: Record<string, unknown>[] = [],
): AgentExecutionContext {
  const columns: DataSummary["columns"] = [
    { name: "ASM", type: "string", sampleValues: [] },
    {
      name: "Date",
      type: "date",
      sampleValues: [],
      ...(dateRange ? { dateRange } : {}),
    } as DataSummary["columns"][number],
    { name: "Day · Date", type: "date", sampleValues: [] },
    { name: "Week · Date", type: "date", sampleValues: [] },
    { name: "Month · Date", type: "date", sampleValues: [] },
  ];
  const summary: DataSummary = {
    rowCount: 100,
    columnCount: columns.length,
    columns,
    numericColumns: [],
    dateColumns: ["Date", "Day · Date", "Week · Date", "Month · Date"],
  };
  return {
    sessionId: "s",
    question: "build a pjp dashboard",
    data: rows,
    turnStartDataRef: rows,
    summary,
    chatHistory: [],
    mode: "analysis",
  } as AgentExecutionContext;
}

test("MW2 · numeric-outcome breakdowns are size-normalized (mean), not raw sum", () => {
  const data = [
    { Region: "East", Sales: 10 },
    { Region: "East", Sales: 30 },
    { Region: "West", Sales: 20 },
    { Region: "West", Sales: 40 },
  ];
  const ctx = makeCtx(
    makeBrief({
      requestsDashboard: true,
      outcomeMetricColumn: "Sales",
      candidateDriverDimensions: ["Region"],
    }),
    data,
    ["Sales"]
  );
  const charts = enumerateMissingDashboardCharts(ctx, []);
  const bar = charts.find((c) => c.type === "bar" && c.x === "Region");
  assert.ok(bar, "expected a Sales-by-Region bar breakdown");
  assert.strictEqual(bar!.aggregate, "mean");
  assert.match(bar!.title, /\(avg\)/);
});

test("TG5 · single-month daily span → Day facet (collapsing Month refined)", () => {
  const rows = genDailyRows("2026-04-01", 30);
  const ctx = makeTemporalCtx(
    { spanDays: 29, distinctDayCount: 30, minIso: "2026-04-01", maxIso: "2026-04-30" },
    rows,
  );
  assert.equal(sweepTest.pickStrongestDateColumn(ctx, rows), "Day · Date");
});

test("TG5 · ≤1yr span → Week facet (span-appropriate, consistent with pickTrendGrainForSpan / planner)", () => {
  const rows = genDailyRows("2026-01-01", 200);
  const ctx = makeTemporalCtx(
    { spanDays: 200, distinctDayCount: 200, minIso: "2026-01-01", maxIso: "2026-07-19" },
    rows,
  );
  // 200-day span → pickTrendGrainForSpan returns "week"; the planner already binds
  // weekly for such a trend query, so the dashboard now matches (was Month under W3).
  assert.equal(sweepTest.pickStrongestDateColumn(ctx, rows), "Week · Date");
});

test("TG5 · missing dateRange metadata but daily rows → STILL Day (metadata-free fix)", () => {
  // The columnar/metadata reload path strips dateRange. The authority derives the
  // grain from the materialized facet buckets in the raw rows, so a single month
  // of daily data still yields Day — the old W3 logic silently kept Month here.
  const rows = genDailyRows("2026-04-01", 30);
  const ctx = makeTemporalCtx(null, rows);
  assert.equal(sweepTest.pickStrongestDateColumn(ctx, rows), "Day · Date");
});

function makeBrief(over: Partial<AnalysisBrief> = {}): AnalysisBrief {
  return {
    version: 1,
    clarifyingQuestions: [],
    epistemicNotes: [],
    ...over,
  } as AnalysisBrief;
}

function makeCtx(
  brief: AnalysisBrief | undefined,
  data: Record<string, unknown>[],
  numericColumns: string[],
  dateColumns: string[] = []
): AgentExecutionContext {
  const colNames = Object.keys(data[0] ?? {});
  const summary: DataSummary = {
    rowCount: data.length,
    columnCount: colNames.length,
    columns: colNames.map((name) => ({
      name,
      type: numericColumns.includes(name) ? "number" : "string",
      sampleValues: [],
    })),
    numericColumns,
    dateColumns,
  };
  return {
    sessionId: "s",
    question: "create a sales dashboard",
    data: data as Record<string, any>[],
    turnStartDataRef: data as Record<string, any>[],
    analysisBrief: brief,
    summary,
    chatHistory: [],
    mode: "analysis",
  } as AgentExecutionContext;
}

test("returns [] when requestsDashboard is unset", () => {
  const ctx = makeCtx(undefined, [{ Region: "East", Sales: 10 }], ["Sales"]);
  assert.deepEqual(enumerateMissingDashboardCharts(ctx, []), []);
});

test("returns [] when outcomeMetricColumn is missing or non-numeric", () => {
  const data = [{ Region: "East", Sales: 10 }];
  const ctx1 = makeCtx(
    makeBrief({ requestsDashboard: true, segmentationDimensions: ["Region"] }),
    data,
    ["Sales"]
  );
  assert.deepEqual(enumerateMissingDashboardCharts(ctx1, []), []);

  const ctx2 = makeCtx(
    makeBrief({
      requestsDashboard: true,
      outcomeMetricColumn: "Region", // not numeric
      segmentationDimensions: ["Region"],
    }),
    data,
    ["Sales"]
  );
  assert.deepEqual(enumerateMissingDashboardCharts(ctx2, []), []);
});

test("builds outcome-by-dim charts for every uncovered dimension", () => {
  const data = [
    { Region: "East", Category: "Tech", Channel: "Online", Sales: 10 },
    { Region: "West", Category: "Furniture", Channel: "Retail", Sales: 20 },
    { Region: "North", Category: "Office", Channel: "Online", Sales: 15 },
    { Region: "South", Category: "Tech", Channel: "Retail", Sales: 30 },
  ];
  const ctx = makeCtx(
    makeBrief({
      outcomeMetricColumn: "Sales",
      segmentationDimensions: ["Region", "Category"],
      candidateDriverDimensions: ["Channel"],
      requestsDashboard: true,
    }),
    data,
    ["Sales"]
  );
  const out = enumerateMissingDashboardCharts(ctx, []);
  const xs = out.map((c) => c.x);
  assert.ok(xs.includes("Region"), `expected Region, got ${xs.join(",")}`);
  assert.ok(xs.includes("Category"));
  assert.ok(xs.includes("Channel"));
  assert.equal(out.length, 3);
  for (const c of out) {
    assert.equal(c.type, "bar");
  }
});

test("skips dimensions already covered by mergedCharts", () => {
  const data = [
    { Region: "East", Category: "Tech", Sales: 10 },
    { Region: "West", Category: "Furniture", Sales: 20 },
  ];
  const ctx = makeCtx(
    makeBrief({
      outcomeMetricColumn: "Sales",
      segmentationDimensions: ["Region", "Category"],
      requestsDashboard: true,
    }),
    data,
    ["Sales"]
  );
  const existing: ChartSpec[] = [
    {
      type: "bar",
      title: "Sales by Region",
      x: "Region",
      y: "Sales_sum",
      aggregate: "sum",
    } as ChartSpec,
  ];
  const out = enumerateMissingDashboardCharts(ctx, existing);
  const xs = out.map((c) => c.x);
  assert.ok(!xs.includes("Region"), "Region was already covered");
  assert.ok(xs.includes("Category"));
});

test("DB4: very-high-cardinality dimensions (EMBED_CAP < uniques ≤ 500) are charted via top-N + Other bucketing", () => {
  // 400 distinct IDs > EMBED_CAP (300): too many to embed/chart in full, so the
  // dim is rolled into top-15 + a visible "Other". (Dims ≤ EMBED_CAP now embed
  // the full set and bake an honest Top-N display default instead — see the
  // "full-embed" test below.)
  const rows = Array.from({ length: 400 }, (_, i) => ({
    CustomerID: `C-${i}`,
    Region: i % 4 === 0 ? "East" : "West",
    Sales: i + 1,
  }));
  const ctx = makeCtx(
    makeBrief({
      outcomeMetricColumn: "Sales",
      segmentationDimensions: ["CustomerID", "Region"],
      requestsDashboard: true,
    }),
    rows,
    ["Sales"]
  );
  const out = enumerateMissingDashboardCharts(ctx, []);
  const xs = out.map((c) => c.x);
  // CustomerID exceeds EMBED_CAP, so it is bucketed into top-15 + Other — legible
  // AND the dim still appears (a plain hard skip would silently drop it).
  assert.ok(xs.includes("CustomerID"), "very-high-cardinality dim should be bucketed and charted");
  assert.ok(xs.includes("Region"));
  const customerChart = out.find((c) => c.x === "CustomerID");
  assert.ok(customerChart);
  // The processed chart data should contain "Other" as a category — proof the
  // bucketing helper flowed through to the rendered spec.
  const xsInChartData = (customerChart!.data as Array<Record<string, unknown>>).map(
    (r) => String(r.CustomerID)
  );
  assert.ok(xsInChartData.includes("Other"), "Other bucket should appear after rollup");
  // Top-15 native rows + 1 Other row = at most 16 distinct categories.
  const distinct = new Set(xsInChartData);
  assert.ok(distinct.size <= 16, `expected ≤16 distinct x values, got ${distinct.size}`);
});

test("bar-limit: high-cardinality dim ≤ EMBED_CAP embeds the FULL set + bakes an honest Top-N (no middle dropped)", () => {
  // 87 distinct brands ≤ EMBED_CAP (300): the sweep embeds EVERY brand (so the
  // "View all … as a sortable table" path reaches all of them) and bakes a
  // durable Top-15 display default — never the old best+worst merge that dropped
  // the middle. This is the exact case from the bug report ("16 of 87 brands").
  const rows = Array.from({ length: 87 }, (_, i) => ({
    Brand: `B-${i}`,
    NR: i + 1,
  }));
  const ctx = makeCtx(
    makeBrief({
      outcomeMetricColumn: "NR",
      segmentationDimensions: ["Brand"],
      requestsDashboard: true,
    }),
    rows,
    ["NR"]
  );
  const out = enumerateMissingDashboardCharts(ctx, []);
  const brandChart = out.find((c) => c.x === "Brand");
  assert.ok(brandChart, "the brand dimension is charted");
  const cats = new Set(
    (brandChart!.data as Array<Record<string, unknown>>).map((r) => String(r.Brand))
  );
  assert.equal(cats.size, 87, "every brand is embedded — no middle dropped");
  assert.ok(!cats.has("Other"), "no 'Other' rollup when fully embedded");
  assert.deepEqual(brandChart!.limit, { mode: "top", n: 15 }, "honest Top-15 display default baked");
  assert.equal(brandChart!.sort?.direction, "desc", "value-desc sort baked so Top-N selects the biggest");
});

test("DB4: high-cardinality dimensions (>500 uniques) are still skipped and reported", () => {
  const rows = Array.from({ length: 1000 }, (_, i) => ({
    AccountID: `A-${i}`,
    Region: i % 4 === 0 ? "East" : "West",
    Sales: i + 1,
  }));
  const ctx = makeCtx(
    makeBrief({
      outcomeMetricColumn: "Sales",
      segmentationDimensions: ["AccountID", "Region"],
      requestsDashboard: true,
    }),
    rows,
    ["Sales"]
  );
  const report = {
    skippedHighCardinality: [] as Array<{ dimension: string; uniques: number }>,
    bucketedDimensions: [] as Array<{ dimension: string; uniques: number; topN: number }>,
  };
  const out = enumerateMissingDashboardCharts(ctx, [], {}, report);
  const xs = out.map((c) => c.x);
  assert.ok(!xs.includes("AccountID"), "1000-unique dim should be skipped entirely");
  assert.ok(xs.includes("Region"));
  assert.strictEqual(report.skippedHighCardinality.length, 1);
  assert.strictEqual(report.skippedHighCardinality[0].dimension, "AccountID");
  assert.ok(report.skippedHighCardinality[0].uniques > 500);
});

test("DB4: bucketRowsTopN keeps the top-N values verbatim and rewrites the rest to 'Other'", async () => {
  const { __test__ } = await import("../lib/agents/runtime/dashboardFeatureSweep.js");
  const rows = [
    { Cust: "A", S: 100 },
    { Cust: "B", S: 80 },
    { Cust: "C", S: 60 },
    { Cust: "D", S: 40 },
    { Cust: "E", S: 20 },
    { Cust: "F", S: 10 },
    { Cust: "G", S: 5 },
  ];
  const out = __test__.bucketRowsTopN(rows, "Cust", 3, "S");
  // Top-3 by sum(S) = A, B, C — those stay; D-G become "Other".
  assert.deepStrictEqual(
    out.map((r) => r.Cust),
    ["A", "B", "C", "Other", "Other", "Other", "Other"]
  );
  // Original input should be untouched (function is pure).
  assert.strictEqual(rows[3].Cust, "D");
});

test("adds a date trend when no chart yet uses the date column", () => {
  const data = [
    { OrderDate: "2024-01-01", Region: "East", Sales: 10 },
    { OrderDate: "2024-02-01", Region: "West", Sales: 20 },
    { OrderDate: "2024-03-01", Region: "North", Sales: 15 },
  ];
  const ctx = makeCtx(
    makeBrief({
      outcomeMetricColumn: "Sales",
      segmentationDimensions: ["Region"],
      requestsDashboard: true,
    }),
    data,
    ["Sales"],
    ["OrderDate"]
  );
  const out = enumerateMissingDashboardCharts(ctx, []);
  const trend = out.find((c) => c.type === "line" && c.x === "OrderDate");
  assert.ok(trend, "expected a line trend on OrderDate");
});

// ───────────────────────────────────────────────────────────────────────────
// Temporal facet columns ("Day · Date", "Week · Date") must render as LINE, not
// BAR — even though they live in summary.columns as type "string" categoricals.
// Regression for the "Compliance Visit (avg) by Day · Date" bar bug.
// ───────────────────────────────────────────────────────────────────────────

/** Daily rows carrying materialized temporal-facet columns + two numeric
 *  measures (one rate-named, one count-named). */
function genFacetRows(days: number): Record<string, unknown>[] {
  const start = new Date("2026-04-01T00:00:00");
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(start.getTime());
    d.setDate(d.getDate() + i);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const iso = `${y}-${m}-${day}`;
    const week =
      Math.ceil((d.getTime() - new Date(y, 0, 1).getTime()) / (7 * 86400000)) + 1;
    rows.push({
      ASM: i % 2 === 0 ? "North" : "South",
      Date: iso,
      "Day · Date": iso,
      "Week · Date": `${y}-W${String(week).padStart(2, "0")}`,
      "Month · Date": `${y}-${m}`,
      "Compliance Visit": 100 + (i % 10), // rate-named (matches RATE_METRIC_RX)
      Sales: 50 + i, // count-named
    });
  }
  return rows;
}

/** ctx where temporal facets are in summary.columns (type "string") but, per
 *  `facetsInDateColumns`, optionally absent from summary.dateColumns — the real
 *  ingest shape (fileParser stamps facets type "string", not in dateColumns). */
function makeFacetCtx(
  rows: Record<string, unknown>[],
  opts: { facetsInDateColumns?: boolean } = {}
): AgentExecutionContext {
  const numeric = ["Compliance Visit", "Sales"];
  const names = Object.keys(rows[0] ?? {});
  const facets = names.filter(isTemporalFacetColumnKey);
  const columns: DataSummary["columns"] = names.map((name) => ({
    name,
    type: numeric.includes(name)
      ? "number"
      : name === "Date"
        ? "date"
        : "string", // facets are type "string" — like real ingest
    sampleValues: [],
  }));
  const dateColumns = opts.facetsInDateColumns ? ["Date", ...facets] : ["Date"];
  const summary: DataSummary = {
    rowCount: rows.length,
    columnCount: columns.length,
    columns,
    numericColumns: numeric,
    dateColumns,
  };
  return {
    sessionId: "s",
    question: "compliance visit analysis",
    data: rows as Record<string, any>[],
    turnStartDataRef: rows as Record<string, any>[],
    summary,
    chatHistory: [],
    mode: "analysis",
  } as AgentExecutionContext;
}

test("temporal facets render as LINE not BAR (facets absent from dateColumns — real ingest shape)", () => {
  const ctx = makeFacetCtx(genFacetRows(30));
  const out = enumerateMissingDashboardCharts(ctx, [], {
    exhaustiveDimensions: true,
    outcomeOverride: "Compliance Visit",
    maxAdds: 50,
  });
  const dayChart = out.find((c) => c.x === "Day · Date");
  const weekChart = out.find((c) => c.x === "Week · Date");
  assert.ok(dayChart, "expected a Day · Date chart");
  assert.equal(dayChart!.type, "line");
  assert.ok(weekChart, "expected a Week · Date chart");
  assert.equal(weekChart!.type, "line");
  // The core invariant: no temporal facet is EVER a bar.
  assert.ok(
    !out.some((c) => isTemporalFacetColumnKey(String(c.x)) && c.type === "bar"),
    "no temporal facet column may render as a bar"
  );
});

test("temporal facets are never bars in EITHER ingest shape (L-019 dual-input check)", () => {
  for (const facetsInDateColumns of [false, true]) {
    const ctx = makeFacetCtx(genFacetRows(30), { facetsInDateColumns });
    const out = enumerateMissingDashboardCharts(ctx, [], {
      exhaustiveDimensions: true,
      outcomeOverride: "Compliance Visit",
      maxAdds: 50,
    });
    assert.ok(
      !out.some((c) => isTemporalFacetColumnKey(String(c.x)) && c.type === "bar"),
      `facet bar leaked with facetsInDateColumns=${facetsInDateColumns}`
    );
  }
});

test("metric-aware aggregate: rate metric → mean/(avg) line; count metric → sum line", () => {
  // Pre-cover the trend grain (Day) so the loop deterministically builds the
  // Week facet via the override path.
  const cover = (y: string): ChartSpec[] => [
    { type: "line", title: `${y} by Day · Date`, x: "Day · Date", y, aggregate: "sum" } as ChartSpec,
  ];

  const rateCtx = makeFacetCtx(genFacetRows(30));
  const rateOut = enumerateMissingDashboardCharts(rateCtx, cover("Compliance Visit"), {
    exhaustiveDimensions: true,
    outcomeOverride: "Compliance Visit",
    maxAdds: 50,
  });
  const rateWeek = rateOut.find((c) => c.x === "Week · Date");
  assert.ok(rateWeek, "expected a Week · Date line for the rate metric");
  assert.equal(rateWeek!.type, "line");
  assert.equal(rateWeek!.aggregate, "mean");
  assert.match(rateWeek!.title, /\(avg\)/);

  const countCtx = makeFacetCtx(genFacetRows(30));
  const countOut = enumerateMissingDashboardCharts(countCtx, cover("Sales"), {
    exhaustiveDimensions: true,
    outcomeOverride: "Sales",
    maxAdds: 50,
  });
  const countWeek = countOut.find((c) => c.x === "Week · Date");
  assert.ok(countWeek, "expected a Week · Date line for the count metric");
  assert.equal(countWeek!.type, "line");
  assert.equal(countWeek!.aggregate, "sum");
  assert.doesNotMatch(countWeek!.title, /\(avg\)/);
});

test("high-cardinality daily facet is a wide line, NOT top-N bucketed", () => {
  // Isolated fixture (just the facet + the measure) so the narrow-frame series
  // auto-bind doesn't apply — mirrors production's wide-frame early-return path
  // where the facet line is single-series. 90 distinct days > LOW_CARDINALITY_MAX
  // (60): the OLD code would top-15+Other bucket this; a time axis must not be.
  const rows = Array.from({ length: 90 }, (_, i) => {
    const d = new Date("2026-04-01T00:00:00");
    d.setDate(d.getDate() + i);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate()
    ).padStart(2, "0")}`;
    return { "Day · Date": iso, "Compliance Visit": 100 + (i % 10) };
  });
  const ctx = {
    sessionId: "s",
    question: "daily compliance",
    data: rows as Record<string, any>[],
    turnStartDataRef: rows as Record<string, any>[],
    summary: {
      rowCount: rows.length,
      columnCount: 2,
      columns: [
        { name: "Day · Date", type: "string", sampleValues: [] },
        { name: "Compliance Visit", type: "number", sampleValues: [] },
      ],
      numericColumns: ["Compliance Visit"],
      dateColumns: [], // no raw date col → trend branch is skipped; loop owns the facet
    },
    chatHistory: [],
    mode: "analysis",
  } as AgentExecutionContext;
  const out = enumerateMissingDashboardCharts(ctx, [], {
    exhaustiveDimensions: true,
    outcomeOverride: "Compliance Visit",
    maxAdds: 50,
  });
  const dayChart = out.find((c) => c.x === "Day · Date");
  assert.ok(dayChart, "expected a Day · Date chart");
  assert.equal(dayChart!.type, "line");
  const xs = (dayChart!.data as Array<Record<string, unknown>>).map((r) =>
    String(r["Day · Date"])
  );
  assert.ok(!xs.includes("Other"), "a time axis must not be top-N+Other bucketed");
  assert.ok(new Set(xs).size > 60, `expected the full daily span, got ${new Set(xs).size}`);
});

test("no duplicate grain line: the trend-branch grain is not re-emitted by the loop", () => {
  const ctx = makeFacetCtx(genFacetRows(30)); // 30-day span → trend picks Day
  const out = enumerateMissingDashboardCharts(ctx, [], {
    exhaustiveDimensions: true,
    outcomeOverride: "Compliance Visit",
    maxAdds: 50,
  });
  const dayCharts = out.filter((c) => c.x === "Day · Date");
  assert.equal(dayCharts.length, 1, "the Day grain must appear exactly once");
});

test("respects maxAdds cap", () => {
  const data = Array.from({ length: 6 }, (_, i) => ({
    A: `a-${i % 3}`,
    B: `b-${i % 2}`,
    C: `c-${i % 3}`,
    D: `d-${i % 2}`,
    E: `e-${i % 2}`,
    Sales: i,
  }));
  const ctx = makeCtx(
    makeBrief({
      outcomeMetricColumn: "Sales",
      segmentationDimensions: ["A", "B", "C", "D", "E"],
      requestsDashboard: true,
    }),
    data,
    ["Sales"]
  );
  const out = enumerateMissingDashboardCharts(ctx, [], { maxAdds: 2 });
  assert.equal(out.length, 2);
});
