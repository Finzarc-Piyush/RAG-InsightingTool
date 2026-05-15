import { test } from "node:test";
import assert from "node:assert/strict";
import { createDataSummary } from "../lib/fileParser.js";

/**
 * Wave T1 · `createDataSummary` must populate per-date-column `dateRange`
 * (minIso, maxIso, distinctDayCount, spanDays) on every column it
 * classifies as a date. The Wave T2 grain-picker reads these.
 */

test("dateRange populated with min/max/distinctDays/span over full data, not just sample", () => {
  // 1500 rows so we exceed the 1000-row sample window in createDataSummary;
  // the dateRange MUST come from the full pass, not the first 1000.
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < 1500; i++) {
    rows.push({
      "Order Date": `2024-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
      Amount: i + 1,
    });
  }
  // Tail row pushes max beyond the first 1000 — exercises the full-data sweep.
  rows.push({ "Order Date": "2024-06-15T00:00:00.000Z", Amount: 9999 });

  const summary = createDataSummary(rows);
  const col = summary.columns.find((c) => c.name === "Order Date");
  assert.ok(col?.dateRange, "expected dateRange to be populated on Order Date");
  assert.equal(col!.dateRange!.minIso, "2024-01-01");
  assert.equal(col!.dateRange!.maxIso, "2024-06-15");
  // Distinct days: 28 distinct day-of-month values + the tail's 2024-06-15 day.
  assert.ok(col!.dateRange!.distinctDayCount >= 28);
  assert.ok(col!.dateRange!.spanDays > 90, "expected wide-span dataset");
});

test("dateRange absent on non-date columns", () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({
    "Order Date": `2024-02-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
    Region: i % 2 === 0 ? "North" : "South",
    Amount: i + 1,
  }));
  const summary = createDataSummary(rows);
  const region = summary.columns.find((c) => c.name === "Region");
  const amount = summary.columns.find((c) => c.name === "Amount");
  assert.equal(region?.dateRange, undefined);
  assert.equal(amount?.dateRange, undefined);
});

test("dateRange spanDays = 0 for a single-day dataset", () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({
    "Order Date": "2026-04-01T00:00:00.000Z",
    Region: ["A", "B", "C"][i % 3],
    Amount: i,
  }));
  const summary = createDataSummary(rows);
  const col = summary.columns.find((c) => c.name === "Order Date");
  assert.ok(col?.dateRange);
  assert.equal(col!.dateRange!.minIso, "2026-04-01");
  assert.equal(col!.dateRange!.maxIso, "2026-04-01");
  assert.equal(col!.dateRange!.distinctDayCount, 1);
  assert.equal(col!.dateRange!.spanDays, 0);
});

test("dateRange reflects narrow 30-day single-month dataset (the failure case)", () => {
  // Mirrors the Marico-TSOE compliance dataset: 10K rows all in April.
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < 600; i++) {
    const day = (i % 30) + 1;
    rows.push({
      "Order Date": `2026-04-${String(day).padStart(2, "0")}T00:00:00.000Z`,
      Region: ["North", "South", "East", "West"][i % 4],
      Visits: i,
    });
  }
  const summary = createDataSummary(rows);
  const col = summary.columns.find((c) => c.name === "Order Date");
  assert.ok(col?.dateRange);
  assert.equal(col!.dateRange!.minIso, "2026-04-01");
  assert.equal(col!.dateRange!.maxIso, "2026-04-30");
  assert.equal(col!.dateRange!.distinctDayCount, 30);
  assert.equal(col!.dateRange!.spanDays, 29);
});

test("dateRange omitted (gracefully) when all date cells fail to parse", () => {
  // Whitelisted name forces date classification even though cells are
  // unparseable — Wave T1's dateRange must still be omitted on the column
  // because parseFlexibleDate finds nothing.
  const rows = Array.from({ length: 12 }, () => ({
    "Order Date": "not-a-date",
    Amount: 1,
  }));
  const summary = createDataSummary(rows);
  const col = summary.columns.find((c) => c.name === "Order Date");
  assert.equal(col?.dateRange, undefined);
});
