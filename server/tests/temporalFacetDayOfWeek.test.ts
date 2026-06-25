/**
 * W1 · day_of_week temporal facet — the new materialized "Day of week · X" column
 * storing the PURE-TEXT weekday name ("Monday"…"Sunday"), derived from any date
 * column like Month/Quarter/Week. Ordering Mon→Sun is the sort authorities' job
 * (covered in the chartSort weekday test); here we lock the grain plumbing.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyTemporalFacetColumns,
  facetColumnKey,
  facetColumnInlineDuckDbExpr,
  parseTemporalFacetDisplayKey,
  isTemporalFacetColumnKey,
  temporalFacetColumnNamesForDateColumns,
} from "../lib/temporalFacetColumns.js";
import { normalizeDateToPeriod } from "../lib/dateUtils.js";

describe("day_of_week facet · key + parsing", () => {
  it("builds a canonical 'Day of week · X' column id distinct from 'Day · X'", () => {
    assert.strictEqual(facetColumnKey("Date", "day_of_week"), "Day of week · Date");
    assert.strictEqual(facetColumnKey("Date", "date"), "Day · Date");
  });

  it("is recognized as a temporal facet column", () => {
    assert.ok(isTemporalFacetColumnKey("Day of week · Date"));
  });

  it("round-trips through parseTemporalFacetDisplayKey without colliding with 'Day'", () => {
    assert.deepStrictEqual(parseTemporalFacetDisplayKey("Day of week · Order Date"), {
      sourceColumn: "Order Date",
      grain: "day_of_week",
    });
    // The calendar-day grain must still parse to `date`, not `day_of_week`.
    assert.deepStrictEqual(parseTemporalFacetDisplayKey("Day · Order Date"), {
      sourceColumn: "Order Date",
      grain: "date",
    });
  });

  it("is included in the materialized facet column set for a date column", () => {
    const names = temporalFacetColumnNamesForDateColumns(["Date"]);
    assert.ok(names.includes("Day of week · Date"), `expected weekday facet in: ${names.join(", ")}`);
  });
});

describe("day_of_week facet · normalization (pure text, no numeric prefix)", () => {
  it("stores the full weekday name as both key and label", () => {
    // 2026-04-01 is a Wednesday.
    const norm = normalizeDateToPeriod(new Date(2026, 3, 1), "day_of_week");
    assert.ok(norm !== null);
    assert.strictEqual(norm.normalizedKey, "Wednesday");
    assert.strictEqual(norm.displayLabel, "Wednesday");
  });

  it("maps Sunday correctly (the off-day in the motivating dataset)", () => {
    // 2026-04-05 is a Sunday.
    const norm = normalizeDateToPeriod(new Date(2026, 3, 5), "day_of_week");
    assert.strictEqual(norm?.normalizedKey, "Sunday");
  });
});

describe("day_of_week facet · materialization onto rows", () => {
  it("writes the weekday name onto each row alongside the other grains", () => {
    const rows = [
      { Date: "2026-04-01", Visits: 10 }, // Wed
      { Date: "2026-04-05", Visits: 0 }, // Sun
      { Date: "2026-04-06", Visits: 12 }, // Mon
    ];
    applyTemporalFacetColumns(rows, ["Date"]);
    assert.strictEqual(rows[0]!["Day of week · Date"], "Wednesday");
    assert.strictEqual(rows[1]!["Day of week · Date"], "Sunday");
    assert.strictEqual(rows[2]!["Day of week · Date"], "Monday");
    // The calendar-day grain remains the ISO date, unaffected.
    assert.strictEqual(rows[0]!["Day · Date"], "2026-04-01");
  });
});

describe("day_of_week facet · inline DuckDB expression", () => {
  const cols = new Set(["Order Date", "Sales"]);

  it("emits a full-weekday-name strftime('%A') expression", () => {
    const expr = facetColumnInlineDuckDbExpr("Day of week · Order Date", cols);
    assert.ok(expr !== null, "should return an expression");
    assert.ok(expr.includes("strftime"), `expected strftime in: ${expr}`);
    assert.ok(expr.includes("'%A'"), `expected '%A' (full weekday name) in: ${expr}`);
    assert.ok(expr.includes('"Order Date"'), `expected quoted source column in: ${expr}`);
  });

  it("returns null on a melted Period dimension (a period label has no weekday)", () => {
    const periodCols = new Set(["Period", "PeriodIso", "Value"]);
    const expr = facetColumnInlineDuckDbExpr("Day of week · Period", periodCols, {
      periodCol: "Period",
      isoCol: "PeriodIso",
    });
    assert.strictEqual(expr, null);
  });
});
