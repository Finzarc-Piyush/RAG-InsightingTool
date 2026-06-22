// Wave H4 · the grain authority must pick a sub-day axis ONLY for intraday data,
// honoring the confirmed cyclical-vs-absolute rule, and must NEVER fabricate an
// hour axis for pure-daily data (the regression the user flagged).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveTrendGrain, type DateRange } from "../lib/temporalGrainAuthority.js";

// A datetime source column always has its 6 calendar facets materialized at ingest;
// the sample rows carry the raw source value so the authority can count sub-day buckets.
const CAL_FACETS = (src: string) =>
  ["Day", "Week", "Month", "Quarter", "Half-year", "Year"].map((g) => `${g} · ${src}`);

function intradaySingleDaySample() {
  // One calendar day, many hours.
  return Array.from({ length: 12 }, (_, i) => ({
    Stamp: `2026-06-22 ${String(8 + i).padStart(2, "0")}:00:00`,
    Logins: 5 + i,
  }));
}

function intradayMultiDaySample() {
  const rows: Record<string, unknown>[] = [];
  for (let day = 1; day <= 5; day++) {
    for (const h of [8, 12, 17]) {
      rows.push({ Stamp: `2026-06-${String(20 + day).padStart(2, "0")} ${String(h).padStart(2, "0")}:00:00`, Logins: h });
    }
  }
  return rows;
}

function dailySample() {
  return Array.from({ length: 8 }, (_, i) => ({
    Stamp: `2026-06-${String(10 + i).padStart(2, "0")}`,
    Logins: 5 + i,
  }));
}

const range = (over: Partial<DateRange>): DateRange => ({
  spanDays: 0,
  distinctDayCount: 1,
  minIso: "2026-06-22",
  maxIso: "2026-06-22",
  ...over,
});

describe("Wave H4 · sub-day grain selection", () => {
  it("single intraday day → absolute hourly timeline (SPAN)", () => {
    const d = resolveTrendGrain({
      availableColumns: ["Stamp", ...CAL_FACETS("Stamp")],
      dateColumns: ["Stamp"],
      dateRangeByColumn: new Map([["Stamp", range({ temporalResolution: "sub_day", distinctHourCount: 12 })]]),
      sample: intradaySingleDaySample(),
    });
    assert.equal(d.grain, "hour");
    assert.equal(d.facetColumn, "Hour · Stamp");
  });

  it('explicit "by hour" over multi-day intraday → cyclical hour-of-day', () => {
    const d = resolveTrendGrain({
      availableColumns: ["Stamp", ...CAL_FACETS("Stamp")],
      dateColumns: ["Stamp"],
      dateRangeByColumn: new Map([
        ["Stamp", range({ spanDays: 5, distinctDayCount: 5, maxIso: "2026-06-25", temporalResolution: "sub_day", distinctHourCount: 3 })],
      ]),
      question: "logins by hour",
      sample: intradayMultiDaySample(),
    });
    assert.equal(d.grain, "hour_of_day");
    assert.equal(d.facetColumn, "Hour of day · Stamp");
  });

  it('explicit "peak hour" → cyclical hour-of-day regardless of span', () => {
    const d = resolveTrendGrain({
      availableColumns: ["Stamp", ...CAL_FACETS("Stamp")],
      dateColumns: ["Stamp"],
      dateRangeByColumn: new Map([
        ["Stamp", range({ spanDays: 5, distinctDayCount: 5, maxIso: "2026-06-25", temporalResolution: "sub_day", distinctHourCount: 3 })],
      ]),
      question: "what is the peak hour for logins",
      sample: intradayMultiDaySample(),
    });
    assert.equal(d.grain, "hour_of_day");
  });

  it("REGRESSION · pure-daily column + 'by hour' → NEVER an hour axis", () => {
    const d = resolveTrendGrain({
      availableColumns: ["Stamp", ...CAL_FACETS("Stamp")],
      dateColumns: ["Stamp"],
      dateRangeByColumn: new Map([
        ["Stamp", range({ spanDays: 7, distinctDayCount: 8, maxIso: "2026-06-17", temporalResolution: "day" })],
      ]),
      question: "logins by hour",
      sample: dailySample(),
    });
    assert.ok(d.grain !== "hour" && d.grain !== "hour_of_day" && d.grain !== "minute", `got ${d.grain}`);
  });

  it("multi-day intraday with NO hour ask → calendar grain, not hourly", () => {
    const d = resolveTrendGrain({
      availableColumns: ["Stamp", ...CAL_FACETS("Stamp")],
      dateColumns: ["Stamp"],
      dateRangeByColumn: new Map([
        ["Stamp", range({ spanDays: 5, distinctDayCount: 5, maxIso: "2026-06-25", temporalResolution: "sub_day", distinctHourCount: 3 })],
      ]),
      sample: intradayMultiDaySample(),
    });
    assert.ok(d.grain !== "hour" && d.grain !== "minute", `got ${d.grain}`);
  });
});
