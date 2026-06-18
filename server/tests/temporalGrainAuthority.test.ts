import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveTrendGrain,
  deriveDateRangeFromRows,
  type DateRangeByColumn,
} from "../lib/temporalGrainAuthority.js";

/** Build N daily rows within a single month with materialized facet columns whose
 *  DISTINCT COUNTS match a real single-month daily span (the authority only reads
 *  per-facet distinct counts + the raw date column, so fabricated keys are fine). */
function dailyRows(year: number, month: number, days: number) {
  const rows: Record<string, unknown>[] = [];
  for (let d = 1; d <= days; d++) {
    const iso = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    rows.push({
      Date: iso,
      "Day · Date": iso, // unique per day
      "Week · Date": `${year}-W${String(Math.ceil(d / 7)).padStart(2, "0")}`, // ~5 distinct
      "Month · Date": `${year}-${String(month).padStart(2, "0")}`, // constant → 1 distinct
      "Compliance Visit": 100 + d,
    });
  }
  return rows;
}

const COLS_DATE = ["Day · Date", "Week · Date", "Month · Date", "Date", "Compliance Visit"];

test("single-month DAILY data → Day facet (span branch)", () => {
  const sample = dailyRows(2026, 4, 30);
  const dateRangeByColumn: DateRangeByColumn = new Map([
    ["Date", { spanDays: 29, distinctDayCount: 30, minIso: "2026-04-01", maxIso: "2026-04-30" }],
  ]);
  const d = resolveTrendGrain({
    availableColumns: COLS_DATE,
    dateColumns: ["Date"],
    dateRangeByColumn,
    sample,
  });
  assert.equal(d.facetColumn, "Day · Date");
  assert.equal(d.grain, "date");
  assert.equal(d.source, "span");
});

test("single-month DAILY with NO dateRange metadata → still Day (row-derived span fallback)", () => {
  const sample = dailyRows(2026, 4, 30);
  const d = resolveTrendGrain({
    availableColumns: COLS_DATE,
    dateColumns: ["Date"],
    dateRangeByColumn: new Map(), // stripped (columnar/metadata reload path)
    sample,
  });
  assert.equal(d.facetColumn, "Day · Date");
  assert.equal(d.grain, "date");
});

test("alias-tolerant: dateRange keyed by different case still resolves span", () => {
  const sample = dailyRows(2026, 4, 30).map((r) => {
    const { Date: dt, ...rest } = r;
    return { ...rest, "Order Date": dt, "Day · Order Date": rest["Day · Date"], "Month · Order Date": rest["Month · Date"], "Week · Order Date": rest["Week · Date"] };
  });
  const d = resolveTrendGrain({
    availableColumns: ["Day · Order Date", "Week · Order Date", "Month · Order Date", "Order Date", "Compliance Visit"],
    dateColumns: ["Order Date"],
    dateRangeByColumn: new Map([
      ["order date", { spanDays: 29, distinctDayCount: 30, minIso: "2026-04-01", maxIso: "2026-04-30" }],
    ]),
    sample,
  });
  assert.equal(d.facetColumn, "Day · Order Date");
  assert.equal(d.source, "span");
});

test("explicit 'monthly' on single-month data falls through to Day (intent collapses)", () => {
  const sample = dailyRows(2026, 4, 30);
  const d = resolveTrendGrain({
    availableColumns: COLS_DATE,
    dateColumns: ["Date"],
    dateRangeByColumn: new Map([
      ["Date", { spanDays: 29, distinctDayCount: 30, minIso: "2026-04-01", maxIso: "2026-04-30" }],
    ]),
    question: "show me the monthly trend",
    sample,
  });
  assert.equal(d.facetColumn, "Day · Date");
});

test("explicit 'monthly' WITH multiple months → Month honored (intent wins over span-day)", () => {
  // 90 days across 3 months of daily data: span≤90 → span would say Day, but intent=month with ≥2 buckets wins.
  const rows: Record<string, unknown>[] = [];
  for (let m = 1; m <= 3; m++) {
    for (let d = 1; d <= 28; d++) {
      const iso = `2026-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      rows.push({ Date: iso, "Day · Date": iso, "Month · Date": `2026-${String(m).padStart(2, "0")}`, Sales: 1 });
    }
  }
  const d = resolveTrendGrain({
    availableColumns: ["Day · Date", "Month · Date", "Date", "Sales"],
    dateColumns: ["Date"],
    dateRangeByColumn: new Map([
      ["Date", { spanDays: 87, distinctDayCount: 84, minIso: "2026-01-01", maxIso: "2026-03-28" }],
    ]),
    question: "show the monthly trend",
    sample: rows,
  });
  assert.equal(d.facetColumn, "Month · Date");
  assert.equal(d.source, "intent");
});

test("facet NAME present but UNMATERIALIZED on sample + real span → Day via span (columnar runtime frame)", () => {
  // The columnar runtime rows carry the raw date but NO materialized "Day · Date"
  // value (facets are computed inline at render). materializedDistinct → 0; the
  // authority must consult the real span rather than treat 0 as a single bucket —
  // otherwise single-month daily collapses to Month even after the facet NAME is
  // listed. Regression guard for the bucketCount span-fallthrough fix.
  const sample = Array.from({ length: 30 }, (_, d) => ({
    Date: `2026-04-${String(d + 1).padStart(2, "0")}`,
    Sales: 1 + d,
    // intentionally NO "Day · Date" / "Week · Date" / "Month · Date" values
  }));
  const d = resolveTrendGrain({
    availableColumns: ["Day · Date", "Week · Date", "Month · Date", "Date", "Sales"],
    dateColumns: ["Date"],
    dateRangeByColumn: new Map([
      ["Date", { spanDays: 29, distinctDayCount: 30, minIso: "2026-04-01", maxIso: "2026-04-30" }],
    ]),
    sample,
  });
  assert.equal(d.facetColumn, "Day · Date");
  assert.equal(d.grain, "date");
  assert.equal(d.source, "span");
});

test("multi-year MONTHLY-only data stays Month (no down-convert to Day/Week)", () => {
  const rows: Record<string, unknown>[] = [];
  for (let y = 2022; y <= 2024; y++) {
    for (let m = 1; m <= 12; m++) {
      const iso = `${y}-${String(m).padStart(2, "0")}-01`;
      rows.push({
        Date: iso,
        "Day · Date": iso, // 36 distinct month-starts
        "Week · Date": iso, // 36 distinct
        "Month · Date": `${y}-${String(m).padStart(2, "0")}`, // 36
        "Quarter · Date": `${y}-Q${Math.ceil(m / 3)}`, // 12
        "Year · Date": String(y), // 3
        Sales: 10,
      });
    }
  }
  const d = resolveTrendGrain({
    availableColumns: ["Day · Date", "Week · Date", "Month · Date", "Quarter · Date", "Year · Date", "Date", "Sales"],
    dateColumns: ["Date"],
    dateRangeByColumn: new Map([
      ["Date", { spanDays: 1065, distinctDayCount: 36, minIso: "2022-01-01", maxIso: "2024-12-01" }],
    ]),
    sample: rows,
  });
  assert.equal(d.facetColumn, "Month · Date");
  assert.equal(d.grain, "month");
});

test("quarterly-only Period with all-null Month·Period facet → Quarter (materialized guard, L-007)", () => {
  const rows: Record<string, unknown>[] = [];
  for (let y = 2023; y <= 2024; y++) {
    for (let q = 1; q <= 4; q++) {
      rows.push({
        Period: `Q${q} ${String(y).slice(2)}`,
        PeriodIso: `${y}-Q${q}`,
        "Quarter · Period": `${y}-Q${q}`, // 8 distinct
        "Year · Period": String(y), // 2 distinct
        "Month · Period": null, // all null (quarter iso has no month grain)
        "Day · Period": null,
        "Week · Period": null,
        Sales: 5,
      });
    }
  }
  const d = resolveTrendGrain({
    availableColumns: ["Day · Period", "Week · Period", "Month · Period", "Quarter · Period", "Year · Period", "Sales"],
    dateColumns: ["Period"],
    dateRangeByColumn: new Map(),
    sample: rows,
  });
  assert.equal(d.facetColumn, "Quarter · Period");
  assert.equal(d.grain, "quarter");
});

test("single-DAY data → one honest point on coarsest available facet (default)", () => {
  const sample = [
    { Date: "2026-04-15", "Day · Date": "2026-04-15", "Month · Date": "2026-04", Sales: 1 },
    { Date: "2026-04-15", "Day · Date": "2026-04-15", "Month · Date": "2026-04", Sales: 2 },
  ];
  const d = resolveTrendGrain({
    availableColumns: ["Day · Date", "Month · Date", "Date", "Sales"],
    dateColumns: ["Date"],
    dateRangeByColumn: new Map([
      ["Date", { spanDays: 0, distinctDayCount: 1, minIso: "2026-04-15", maxIso: "2026-04-15" }],
    ]),
    sample,
    allowSingleBucket: true, // dashboard/visual-planner accept a one-point chart
  });
  assert.equal(d.source, "default");
  assert.equal(d.facetColumn, "Month · Date");
});

test("single-DAY data with allowSingleBucket OFF → no temporal axis (caller falls back)", () => {
  const sample = [
    { Date: "2026-04-15", "Day · Date": "2026-04-15", "Month · Date": "2026-04", Sales: 1 },
    { Date: "2026-04-15", "Day · Date": "2026-04-15", "Month · Date": "2026-04", Sales: 2 },
  ];
  const d = resolveTrendGrain({
    availableColumns: ["Day · Date", "Month · Date", "Date", "Sales"],
    dateColumns: ["Date"],
    dateRangeByColumn: new Map(),
    sample,
  });
  assert.equal(d.facetColumn, null);
  assert.equal(d.source, "none");
});

test("no date/temporal column → no temporal axis", () => {
  const d = resolveTrendGrain({
    availableColumns: ["Brand", "Sales"],
    dateColumns: [],
    sample: [{ Brand: "X", Sales: 1 }],
  });
  assert.equal(d.facetColumn, null);
  assert.equal(d.grain, null);
  assert.equal(d.source, "none");
});

test("deriveDateRangeFromRows computes a single-month daily span", () => {
  const rows = dailyRows(2026, 4, 30);
  const r = deriveDateRangeFromRows(rows, "Date");
  assert.ok(r);
  assert.equal(r!.distinctDayCount, 30);
  assert.ok(r!.spanDays >= 28 && r!.spanDays <= 30);
  assert.equal(r!.minIso, "2026-04-01");
  assert.equal(r!.maxIso, "2026-04-30");
});
