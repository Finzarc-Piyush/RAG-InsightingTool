/**
 * W-LEAVE (Wave 1) · structural leave/non-working-day detection. Pure,
 * data-driven (no hardcoded "Sunday"): a weekday whose daily activity sits ≤15%
 * of the other days is a non-working day. Stored inert on dataSummary; the
 * engine later discloses + asks before excluding those days from per-day
 * AVERAGES. These tests pin detection precision/recall + the user-choice guard.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  inferLeaveDayPattern,
  applyLeaveDayPatternToSummary,
  type LeaveDayPattern,
} from "../lib/inferLeaveDayPattern.js";

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * `weeks` weeks of daily rows starting Mon 2026-04-06. `onSunday`/`onWorkday`
 * give the per-row Visits value; `rowsPerDay(weekday)` controls how many rows a
 * given weekday gets (defaults to 1) so the row-count signal can be exercised.
 */
function dailyRows(opts: {
  weeks: number;
  onSunday: number;
  onWorkday: number;
  rowsPerDay?: (weekday: number) => number;
  col?: string;
}): Record<string, unknown>[] {
  const { weeks, onSunday, onWorkday, rowsPerDay = () => 1, col = "Date" } = opts;
  const rows: Record<string, unknown>[] = [];
  const start = new Date(2026, 3, 6); // Monday
  for (let i = 0; i < weeks * 7; i++) {
    const d = new Date(start.getTime());
    d.setDate(start.getDate() + i);
    const wd = d.getDay();
    const n = rowsPerDay(wd);
    for (let r = 0; r < n; r++) {
      rows.push({ [col]: iso(d), Visits: wd === 0 ? onSunday : onWorkday });
    }
  }
  return rows;
}

function summary(over: Partial<{ dateColumns: string[]; numericColumns: string[] }> = {}): any {
  return {
    rowCount: 0,
    columnCount: 0,
    columns: [],
    numericColumns: over.numericColumns ?? ["Visits"],
    dateColumns: over.dateColumns ?? ["Date"],
  };
}

describe("inferLeaveDayPattern", () => {
  it("detects Sunday from a measure that sums to ≈0 on Sundays", () => {
    const rows = dailyRows({ weeks: 4, onSunday: 0, onWorkday: 4000 });
    const pattern = inferLeaveDayPattern(summary(), rows);
    assert.ok(pattern, "expected a leave-day pattern");
    assert.deepStrictEqual(pattern!.offWeekdays, ["Sunday"]);
    assert.strictEqual(pattern!.dateColumn, "Date");
    assert.strictEqual(pattern!.source, "auto");
    assert.strictEqual(pattern!.decision, "undecided");
    assert.ok(pattern!.basis.ratio <= 0.15, `ratio ${pattern!.basis.ratio} should be ≤0.15`);
  });

  it("detects the off-day via ROW COUNT when off-day rows are sparse", () => {
    // Sundays present but with 1 row vs 20 on workdays; Visits flat (4000) so
    // the measure-total signal is NOT what fires — the row-count signal is.
    const rows = dailyRows({
      weeks: 4,
      onSunday: 4000,
      onWorkday: 4000,
      rowsPerDay: (wd) => (wd === 0 ? 1 : 20),
    });
    const pattern = inferLeaveDayPattern(summary(), rows);
    assert.ok(pattern, "expected row-count to surface the off-day");
    assert.deepStrictEqual(pattern!.offWeekdays, ["Sunday"]);
  });

  it("returns null for a flat series (no structural off-day)", () => {
    const rows = dailyRows({ weeks: 4, onSunday: 4000, onWorkday: 4000 });
    assert.strictEqual(inferLeaveDayPattern(summary(), rows), null);
  });

  it("returns null when Sunday is merely lower, not structural (ratio > 0.15)", () => {
    const rows = dailyRows({ weeks: 4, onSunday: 2000, onWorkday: 4000 }); // 50%
    assert.strictEqual(inferLeaveDayPattern(summary(), rows), null);
  });

  it("returns null when the series is too short (<10 distinct days)", () => {
    const rows = dailyRows({ weeks: 1, onSunday: 0, onWorkday: 4000 }); // 7 days
    assert.strictEqual(inferLeaveDayPattern(summary(), rows), null);
  });

  it("returns null when there are no date columns", () => {
    const rows = dailyRows({ weeks: 4, onSunday: 0, onWorkday: 4000 });
    assert.strictEqual(inferLeaveDayPattern(summary({ dateColumns: [] }), rows), null);
  });

  it("picks the date column that carries the activity series", () => {
    // Two date columns: 'Reported' is flat; 'Date' shows the Sunday dip.
    const rows = dailyRows({ weeks: 4, onSunday: 0, onWorkday: 4000 }).map((r) => ({
      ...r,
      Reported: r.Date, // same calendar but the off-day shows on the Visits/Date pairing
    }));
    const pattern = inferLeaveDayPattern(
      summary({ dateColumns: ["Date", "Reported"] }),
      rows,
    );
    assert.ok(pattern);
    assert.deepStrictEqual(pattern!.offWeekdays, ["Sunday"]);
  });
});

describe("applyLeaveDayPatternToSummary", () => {
  const auto: LeaveDayPattern = {
    offWeekdays: ["Sunday"],
    dateColumn: "Date",
    basis: { offMean: 0, workingMean: 4000, ratio: 0 },
    source: "auto",
    decision: "undecided",
  };

  it("stamps an auto pattern onto a summary", () => {
    const s = summary();
    applyLeaveDayPatternToSummary(s, auto);
    assert.deepStrictEqual(s.leaveDayPattern.offWeekdays, ["Sunday"]);
    assert.strictEqual(s.leaveDayPattern.decision, "undecided");
  });

  it("NEVER overwrites a remembered user choice (source:'user')", () => {
    const s = summary();
    s.leaveDayPattern = {
      offWeekdays: ["Sunday"],
      dateColumn: "Date",
      basis: { offMean: 0, workingMean: 4000, ratio: 0 },
      source: "user",
      decision: "exclude",
    };
    applyLeaveDayPatternToSummary(s, auto); // auto re-detection must be a no-op
    assert.strictEqual(s.leaveDayPattern.source, "user");
    assert.strictEqual(s.leaveDayPattern.decision, "exclude");
  });

  it("is a no-op when no pattern was detected (null)", () => {
    const s = summary();
    applyLeaveDayPatternToSummary(s, null);
    assert.strictEqual(s.leaveDayPattern, undefined);
  });
});
