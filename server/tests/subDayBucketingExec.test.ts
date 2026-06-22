// Wave H5 · sub-day bucketing must actually compute — both the DuckDB inline SQL
// and the in-JS aggregation path — and AVG/SUM must work over the new buckets.
// hour-of-day aggregates ACROSS days (the "average by hour of day" use case).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { facetColumnInlineDuckDbExpr } from "../lib/temporalFacetColumns.js";
import { applyQueryTransformations } from "../lib/dataTransform.js";
import { createDataSummary } from "../lib/fileParser.js";
import type { ParsedQuery } from "../shared/queryTypes.js";

describe("Wave H5 · DuckDB inline sub-day SQL", () => {
  const cols = new Set(["Stamp", "Logins"]);
  it("hour → date_trunc('hour') keyed YYYY-MM-DD HH", () => {
    const e = facetColumnInlineDuckDbExpr("Hour · Stamp", cols)!;
    assert.ok(e.includes("date_trunc('hour'"), e);
    assert.ok(e.includes("'%Y-%m-%d %H'"), e);
  });
  it("minute → date_trunc('minute')", () => {
    const e = facetColumnInlineDuckDbExpr("Minute · Stamp", cols)!;
    assert.ok(e.includes("date_trunc('minute'"), e);
  });
  it("hour_of_day → EXTRACT(hour …) zero-padded, with a TIME fallback for pure-time cols", () => {
    const e = facetColumnInlineDuckDbExpr("Hour of day · Stamp", cols)!;
    assert.ok(e.includes("EXTRACT(hour FROM"), e);
    assert.ok(e.includes("printf('%02d'"), e);
    assert.ok(e.includes("AS TIME"), `should COALESCE a TRY_CAST AS TIME path: ${e}`);
  });
  it("returns null when the source column is absent", () => {
    assert.equal(facetColumnInlineDuckDbExpr("Hour · Stamp", new Set(["Logins"])), null);
  });
});

describe("Wave H5 · in-JS hour-of-day AVG across days", () => {
  // 3 days; each day has 08:00 and 14:00 readings. Average by hour of day should
  // collapse all three days into two buckets ("08", "14") with the mean per hour.
  const rows = [
    { Stamp: "2026-06-20 08:00:00", Logins: 10 },
    { Stamp: "2026-06-20 14:00:00", Logins: 30 },
    { Stamp: "2026-06-21 08:00:00", Logins: 20 },
    { Stamp: "2026-06-21 14:00:00", Logins: 40 },
    { Stamp: "2026-06-22 08:00:00", Logins: 30 },
    { Stamp: "2026-06-22 14:00:00", Logins: 50 },
  ];
  const summary = createDataSummary(rows);

  it("averages Logins by hour of day across all days", () => {
    const parsed: ParsedQuery = {
      rawQuestion: "average logins by hour of day",
      groupBy: ["Hour of day · Stamp"],
      aggregations: [{ column: "Logins", operation: "mean" }],
    };
    const { data } = applyQueryTransformations(rows, summary, parsed);
    // The in-JS path emits the display label per bucket (like "Jan 2026" for month);
    // hour-of-day → "08:00"/"14:00". Two buckets, each averaged across all 3 days.
    const byKey = new Map(data.map((r) => [String(r["Hour of day · Stamp"]), r]));
    assert.deepEqual([...byKey.keys()].sort(), ["08:00", "14:00"]);
    // 08 mean = (10+20+30)/3 = 20 ; 14 mean = (30+40+50)/3 = 40
    const val = (r: Record<string, any>) => Number(r["Logins_mean"]);
    assert.equal(val(byKey.get("08:00")!), 20);
    assert.equal(val(byKey.get("14:00")!), 40);
  });

  it("confirms the source column was detected as intraday (sub_day)", () => {
    const col = summary.columns.find((c) => c.name === "Stamp") as
      | { dateRange?: { temporalResolution?: string } }
      | undefined;
    assert.equal(col?.dateRange?.temporalResolution, "sub_day");
  });
});
