import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planContinuousDimensionBucket,
  applyContinuousDimensionBucket,
  bucketContinuousXForSpec,
} from "../lib/continuousDimensionBucket.js";
import { resolveSort, applyChartSort, detectAxisOrdered } from "../shared/chartSort.js";
import type { DataSummary } from "../shared/schema.js";

const DASH = "–";

function rowsFrom(col: string, values: unknown[]): Record<string, unknown>[] {
  return values.map((v) => ({ [col]: v, metric: 1 }));
}

function makeSummary(columns: DataSummary["columns"]): DataSummary {
  return {
    rowCount: 0,
    columnCount: columns.length,
    columns,
    numericColumns: [],
    dateColumns: [],
  } as unknown as DataSummary;
}

// ── time-of-day ───────────────────────────────────────────────────────────────────

test("time-of-day spanning ≥3 hours → hour-of-day bands", () => {
  const col = "Clock-In Time";
  const rows = rowsFrom(col, [
    "08:05:00", "08:55:10", "09:14:19", "09:47:30", "10:02:00", "11:30:00", "11:59:59",
  ]);
  const plan = planContinuousDimensionBucket({
    column: col,
    rows,
    summaryColumn: { name: col, type: "string", sampleValues: [], timeOfDay: {} } as never,
  });
  assert.ok(plan, "plan produced");
  assert.equal(plan!.kind, "time_of_day");
  assert.equal(plan!.assign("09:14:19"), `09:00${DASH}10:00`);
  assert.equal(plan!.assign("08:05:00"), `08:00${DASH}09:00`);
  // 08,09,10,11 → 4 ascending bands
  assert.deepEqual(plan!.orderedKeys, [
    `08:00${DASH}09:00`, `09:00${DASH}10:00`, `10:00${DASH}11:00`, `11:00${DASH}12:00`,
  ]);
  assert.match(plan!.reason, /hour-of-day/);
});

test("time-of-day clustered in one hour → auto-refines to a finer grain (≥2 bands)", () => {
  const col = "Clock-In Time";
  // all within 08:50–09:47 → hour grain gives only {08:00,09:00}=2 bands → refine.
  const rows = rowsFrom(col, [
    "08:50:49", "09:14:19", "09:14:56", "09:24:04", "09:28:24", "09:47:30",
  ]);
  const plan = planContinuousDimensionBucket({
    column: col,
    rows,
    summaryColumn: { name: col, type: "string", sampleValues: [], timeOfDay: {} } as never,
  });
  assert.ok(plan);
  assert.ok(plan!.orderedKeys.length >= 3, `got ${plan!.orderedKeys.length} bands`);
  // refined grain is 30-min: 08:50→08:30 band, 09:14/09:24/09:28→09:00, 09:47→09:30
  assert.equal(plan!.assign("08:50:49"), `08:30${DASH}09:00`);
  assert.equal(plan!.assign("09:24:04"), `09:00${DASH}09:30`);
  assert.match(plan!.reason, /30-minute/);
});

// ── duration ──────────────────────────────────────────────────────────────────────

test("duration column → clean whole-hour ranges", () => {
  const col = "Working Hrs";
  const rows = rowsFrom(col, [
    "03:16:55", "04:48:47", "05:33:15", "06:13:08", "06:25:50", "07:17:06",
  ]);
  const plan = planContinuousDimensionBucket({
    column: col,
    rows,
    summaryColumn: {
      name: col, type: "number", sampleValues: [], duration: { unit: "hours", format: "hm" },
    } as never,
  });
  assert.ok(plan);
  assert.equal(plan!.kind, "duration");
  assert.equal(plan!.assign("03:16:55"), `3h${DASH}4h`);
  assert.equal(plan!.assign("06:13:08"), `6h${DASH}7h`);
  // 3,4,5,6,7 → ascending; 6:13 and 6:25 collapse into the same 6h–7h band
  assert.deepEqual(plan!.orderedKeys, [
    `3h${DASH}4h`, `4h${DASH}5h`, `5h${DASH}6h`, `6h${DASH}7h`, `7h${DASH}8h`,
  ]);
});

test("wide duration span widens the bucket to stay within the bucket cap", () => {
  const col = "TAT Hours";
  // 0..60h: width 1 → 61 buckets > 24, so the planner widens to a round width.
  const rows = rowsFrom(
    col,
    Array.from({ length: 61 }, (_, h) => `${String(h).padStart(2, "0")}:30:00`),
  );
  const plan = planContinuousDimensionBucket({
    column: col,
    rows,
    summaryColumn: {
      name: col, type: "number", sampleValues: [], duration: { unit: "hours", format: "hm" },
    } as never,
  });
  assert.ok(plan);
  assert.ok(plan!.orderedKeys.length <= 24, `${plan!.orderedKeys.length} ≤ 24`);
});

// ── detection precedence + fallbacks ────────────────────────────────────────────────

test("no annotation → shape-detects a time-of-day column from the rows", () => {
  const col = "In At";
  const rows = rowsFrom(col, [
    "08:05:00", "08:55:10", "09:14:19", "09:47:30", "10:02:00", "11:30:00",
  ]);
  const plan = planContinuousDimensionBucket({ column: col, rows }); // no summaryColumn
  assert.ok(plan, "shape detection fired");
  assert.equal(plan!.kind, "time_of_day");
});

test("sentinel cells map to null (dropped, no sentinel bucket)", () => {
  const col = "Clock-In Time";
  const rows = rowsFrom(col, ["08:05:00", "Absent", "09:14:19", "N/A", "10:02:00", "11:30:00"]);
  const plan = planContinuousDimensionBucket({
    column: col,
    rows,
    summaryColumn: { name: col, type: "string", sampleValues: [], timeOfDay: {} } as never,
  });
  assert.ok(plan);
  assert.equal(plan!.assign("Absent"), null);
  assert.equal(plan!.assign("N/A"), null);
  const out = applyContinuousDimensionBucket(rows, plan!);
  assert.equal(out.length, 4, "two sentinel rows dropped");
});

test("low-cardinality categorical column → no plan (chart natively)", () => {
  const col = "Region";
  const rows = rowsFrom(col, ["North", "South", "East", "West", "North", "South"]);
  const plan = planContinuousDimensionBucket({
    column: col,
    rows,
    summaryColumn: { name: col, type: "string", sampleValues: [] } as never,
  });
  assert.equal(plan, null);
});

test("calendar date column is never bucketed here (left to the temporal authority)", () => {
  const col = "Order Date";
  const rows = rowsFrom(col, ["2024-01-15", "2024-02-20", "2024-03-10"]);
  const plan = planContinuousDimensionBucket({
    column: col,
    rows,
    summaryColumn: { name: col, type: "date", sampleValues: [] } as never,
  });
  assert.equal(plan, null);
});

test("single distinct value → orderedKeys collapses to <2 (caller charts natively)", () => {
  const col = "Clock-In Time";
  const rows = rowsFrom(col, ["09:10:00", "09:12:00", "09:14:00", "09:13:00", "09:11:00"]);
  const plan = planContinuousDimensionBucket({
    column: col,
    rows,
    summaryColumn: { name: col, type: "string", sampleValues: [], timeOfDay: {} } as never,
  });
  // even the finest 15-min grain keeps these in one band → caller will skip the rewrite
  assert.ok(plan === null || plan.orderedKeys.length < 2);
});

// ── ordering: labels lead with their lower bound so chartSort orders them ────────────

test("bucket labels are detected as an ordered axis and sort ascending (3 before 10)", () => {
  const labels = [`10h${DASH}11h`, `3h${DASH}4h`, `2h${DASH}3h`];
  assert.equal(detectAxisOrdered(labels), true);
  const rows = labels.map((b, i) => ({ b, metric: i }));
  const sort = resolveSort({}, { xValues: rows.map((r) => r.b) });
  assert.deepEqual(sort, { by: "category", direction: "asc" });
  const ordered = applyChartSort(rows, sort, { xCol: "b", yCol: "metric" }).map((r) => r.b);
  assert.deepEqual(ordered, [`2h${DASH}3h`, `3h${DASH}4h`, `10h${DASH}11h`]);
});

// ── the spec wrapper ────────────────────────────────────────────────────────────────

test("bucketContinuousXForSpec rewrites rows + returns axisReason for a continuous x", () => {
  const col = "Clock-In Time";
  const rows = rowsFrom(col, [
    "08:05:00", "08:55:10", "09:14:19", "09:47:30", "10:02:00", "11:30:00",
  ]);
  const summary = makeSummary([
    { name: col, type: "string", sampleValues: [], timeOfDay: {} } as never,
  ]);
  const out = bucketContinuousXForSpec(rows, { x: col }, summary);
  assert.ok(out.axisReason && /hour-of-day/.test(out.axisReason));
  const distinct = new Set(out.rows.map((r) => r[col]));
  assert.ok(distinct.size <= 24 && distinct.size >= 3);
  // every rewritten value is a bucket label, not a raw clock reading
  for (const v of distinct) assert.match(String(v), /\d\d:\d\d–\d\d:\d\d/);
});

test("bucketContinuousXForSpec passes rows through untouched for a nominal x", () => {
  const col = "Region";
  const rows = rowsFrom(col, ["North", "South", "East", "North"]);
  const summary = makeSummary([{ name: col, type: "string", sampleValues: [] } as never]);
  const out = bucketContinuousXForSpec(rows, { x: col }, summary);
  assert.equal(out.axisReason, undefined);
  assert.equal(out.rows, rows);
});
