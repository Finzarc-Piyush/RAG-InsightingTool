/**
 * deriveWeekdayPattern — deterministic day-of-week grounding for date-axis trends.
 *
 * Pins: a recurring near-zero weekday is detected as an OFF-DAY (derived from the
 * data, not hardcoded), the off dates are surfaced, and series with no weekly
 * rhythm / too few points return null (so charts are never polluted).
 *
 * Uses Date objects for x so weekday detection is timezone-deterministic (the
 * production string path — ISO "2026-04-05" — is exercised end-to-end).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveWeekdayPattern } from "../lib/insightGenerator/weekdayPattern.js";

/** `days` consecutive Date-keyed rows from 2026-04-01; `value(weekday)` sets y. */
function series(days: number, value: (weekday: number) => number) {
  const out: Record<string, any>[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(2026, 3, 1 + i); // local — getDay matches the helper's
    out.push({ "Day · Date": d, visits: value(d.getDay()) });
  }
  return out;
}

describe("deriveWeekdayPattern", () => {
  it("detects a recurring Sunday off-day (Sundays ≈ 0)", () => {
    const rows = series(30, (wd) => (wd === 0 ? 0 : 5000));
    const p = deriveWeekdayPattern(rows, "Day · Date", "visits");
    assert.ok(p, "pattern detected");
    assert.deepEqual(p!.offWeekdays, ["Sunday"]);
    // April 2026 has 4 Sundays (5, 12, 19, 26).
    assert.equal(p!.offDates.length, 4);
    assert.match(p!.block, /TEMPORAL CALENDAR/);
    assert.match(p!.block, /Sunday/);
  });

  it("detects a two-day weekend (Sat + Sun off)", () => {
    const rows = series(30, (wd) => (wd === 0 || wd === 6 ? 1 : 4000));
    const p = deriveWeekdayPattern(rows, "Day · Date", "visits");
    assert.ok(p);
    assert.deepEqual([...p!.offWeekdays].sort(), ["Saturday", "Sunday"]);
  });

  it("returns null for a smooth series with no off-day", () => {
    const rows = series(30, () => 5000 + Math.round(Math.sin(1) * 10));
    assert.equal(deriveWeekdayPattern(rows, "Day · Date", "visits"), null);
  });

  it("returns null for a too-short series (no weekly structure)", () => {
    const rows = series(5, (wd) => (wd === 0 ? 0 : 5000));
    assert.equal(deriveWeekdayPattern(rows, "Day · Date", "visits"), null);
  });

  it("uses the supplied formatter for the by-weekday averages", () => {
    const rows = series(30, (wd) => (wd === 0 ? 0 : 5000));
    const p = deriveWeekdayPattern(
      rows,
      "Day · Date",
      "visits",
      (n) => `${Math.round(n / 1000)}K`
    );
    assert.ok(p);
    assert.match(p!.block, /Mon 5K/);
  });
});
