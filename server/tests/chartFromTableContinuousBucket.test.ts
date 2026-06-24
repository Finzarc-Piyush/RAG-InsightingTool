import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChartFromAnalyticalTable } from "../lib/agents/runtime/chartFromTable.js";
import type { DataSummary } from "../shared/schema.js";

const DASH = "–";

function makeSummary(overrides: Partial<DataSummary> = {}): DataSummary {
  const base: DataSummary = {
    rowCount: 100,
    columns: [],
    columnCount: 0,
    numericColumns: [],
    dateColumns: [],
    categoricalColumns: [],
    sampleRows: [],
  } as unknown as DataSummary;
  return { ...base, ...overrides } as DataSummary;
}

function clock(secondsOfDay: number): string {
  const h = Math.floor(secondsOfDay / 3600);
  const m = Math.floor((secondsOfDay % 3600) / 60);
  const s = secondsOfDay % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

// 200 rows, every clock-in a DISTINCT per-second value across 08:00–11:59 (≫ the
// X_LABEL_CARDINALITY_CAP of 60). Pre-bucketing this table is either suppressed by the
// cap or rendered one-bar-per-second; after bucketing it is hour-of-day bands.
test("chartFromTable: per-second Clock-In Time column → hour-of-day bar (not suppressed)", () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({
    "Clock-In Time": clock(8 * 3600 + i * 72), // 08:00:00 … 11:58:48, all distinct
    "Compliance Visit": 40 + (i % 50),
  }));
  const out = buildChartFromAnalyticalTable({
    table: { rows, columns: ["Clock-In Time", "Compliance Visit"] },
    summary: makeSummary({
      numericColumns: ["Compliance Visit"],
      columns: [
        { name: "Clock-In Time", type: "string", sampleValues: [], timeOfDay: {} },
        { name: "Compliance Visit", type: "number", sampleValues: [] },
      ] as never,
    }),
    question: "compliance by clock-in time",
  });

  assert.notEqual(out, null, "chart NOT suppressed by the cardinality cap");
  assert.equal(out!.type, "bar");
  assert.equal(out!.x, "Clock-In Time");
  assert.equal(out!.y, "Compliance Visit");
  assert.match(String(out!.axisReason ?? ""), /hour-of-day/);

  const xs = (out!.data as Record<string, unknown>[]).map((r) => String(r["Clock-In Time"]));
  assert.ok(xs.length >= 3 && xs.length <= 24, `bucketed to ${xs.length} bars`);
  for (const x of xs) assert.match(x, /^\d\d:\d\d–\d\d:\d\d$/, `bucket label: ${x}`);
  // 08:00–09:00 … 11:00–12:00, ascending
  assert.deepEqual(xs, [
    `08:00${DASH}09:00`, `09:00${DASH}10:00`, `10:00${DASH}11:00`, `11:00${DASH}12:00`,
  ]);
});

// A nominal categorical x must be untouched — the bucket authority returns null for it.
test("chartFromTable: nominal category column is unaffected by bucketing", () => {
  const out = buildChartFromAnalyticalTable({
    table: {
      rows: [
        { Region: "North", Sales_sum: 100 },
        { Region: "South", Sales_sum: 80 },
        { Region: "East", Sales_sum: 60 },
      ],
      columns: ["Region", "Sales_sum"],
    },
    summary: makeSummary({
      numericColumns: ["Sales_sum"],
      columns: [
        { name: "Region", type: "string", sampleValues: [] },
        { name: "Sales_sum", type: "number", sampleValues: [] },
      ] as never,
    }),
    question: "sales by region",
  });
  assert.notEqual(out, null);
  assert.equal(out!.x, "Region");
  assert.equal(out!.axisReason ?? "", "");
  const xs = (out!.data as Record<string, unknown>[]).map((r) => String(r["Region"]));
  assert.deepEqual(new Set(xs), new Set(["North", "South", "East"]));
});
