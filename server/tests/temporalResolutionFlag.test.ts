// Wave H1 · the `temporalResolution` gate must be set IDENTICALLY on every ingest
// path (invariant L-019). createDataSummary (in-memory CSV/Excel) and the
// authority's deriveDateRangeFromRows (columnar/Snowflake/reload fallback) must
// agree: a column with ≥2 distinct non-midnight times → 'sub_day'; a pure-daily
// column → 'day' (never promoted to an hour axis).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createDataSummary } from "../lib/fileParser.js";
import { deriveDateRangeFromRows } from "../lib/temporalGrainAuthority.js";

function intradayRows(): Record<string, unknown>[] {
  // Same calendar day, varying times → genuine intraday detail.
  return [
    { Stamp: "2026-06-22 09:15:00", Sales: 10 },
    { Stamp: "2026-06-22 11:30:00", Sales: 12 },
    { Stamp: "2026-06-22 14:45:00", Sales: 8 },
    { Stamp: "2026-06-23 08:05:00", Sales: 9 },
    { Stamp: "2026-06-23 17:20:00", Sales: 11 },
  ];
}

function dailyRows(): Record<string, unknown>[] {
  return Array.from({ length: 6 }, (_, i) => ({
    Stamp: `2026-06-${String(20 + i).padStart(2, "0")}`,
    Sales: 10 + i,
  }));
}

function constantTimeRows(): Record<string, unknown>[] {
  // Every row at the SAME non-midnight time (placeholder) → must NOT be sub_day.
  return Array.from({ length: 6 }, (_, i) => ({
    Stamp: `2026-06-${String(20 + i).padStart(2, "0")} 09:00:00`,
    Sales: 10 + i,
  }));
}

function dateRangeOf(rows: Record<string, unknown>[]) {
  const summary = createDataSummary(rows);
  const col = summary.columns.find((c) => c.name === "Stamp") as
    | { dateRange?: { temporalResolution?: string } }
    | undefined;
  return col?.dateRange;
}

describe("Wave H1 · temporalResolution gate", () => {
  it("createDataSummary marks an intraday column 'sub_day'", () => {
    const r = dateRangeOf(intradayRows());
    assert.equal(r?.temporalResolution, "sub_day");
  });

  it("createDataSummary marks a pure-daily column 'day'", () => {
    const r = dateRangeOf(dailyRows());
    assert.equal(r?.temporalResolution, "day");
  });

  it("constant non-midnight time is NOT promoted to sub_day", () => {
    const r = dateRangeOf(constantTimeRows());
    assert.equal(r?.temporalResolution, "day");
  });

  it("deriveDateRangeFromRows agrees with createDataSummary (intraday)", () => {
    const derived = deriveDateRangeFromRows(intradayRows(), "Stamp");
    assert.equal(derived?.temporalResolution, "sub_day");
    assert.equal(derived?.temporalResolution, dateRangeOf(intradayRows())?.temporalResolution);
  });

  it("deriveDateRangeFromRows agrees with createDataSummary (daily)", () => {
    const derived = deriveDateRangeFromRows(dailyRows(), "Stamp");
    assert.equal(derived?.temporalResolution, "day");
    assert.equal(derived?.temporalResolution, dateRangeOf(dailyRows())?.temporalResolution);
  });
});
