import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseFlexibleDate } from "../lib/dateUtils.js";
import { applyTemporalFacetColumns } from "../lib/temporalFacetColumns.js";

/**
 * Wave A · `parseFlexibleDate` recognises wide-format `PeriodIso` labels
 * with a fixed calendar anchor. Comparative-only / rolling shapes (`L12M`,
 * `L12M-YA`, `MAT-YA`, `YTD-TY`, `XXXX-Q1`) intentionally remain
 * unparseable: they are anchored to "now", not a fixed calendar date.
 *
 * The end-to-end value: when the dataset profile pass adds `PeriodIso` to
 * `dataSummary.dateColumns`, `applyTemporalFacetColumns` can now derive
 * non-null `Year ·` / `Quarter ·` / `Month ·` buckets for calendar rows
 * (the "some temporal columns just seem empty" complaint).
 */

describe("parseFlexibleDate · ISO period anchors", () => {
  test("YYYY-Qn → first day of quarter", () => {
    const d = parseFlexibleDate("2023-Q1");
    assert.ok(d, "Q1 should parse");
    assert.strictEqual(d!.getFullYear(), 2023);
    assert.strictEqual(d!.getMonth(), 0);

    const d2 = parseFlexibleDate("2024-Q3");
    assert.ok(d2);
    assert.strictEqual(d2!.getMonth(), 6);
  });

  test("YYYY-Hn → first day of half", () => {
    const h1 = parseFlexibleDate("2023-H1");
    assert.ok(h1);
    assert.strictEqual(h1!.getFullYear(), 2023);
    assert.strictEqual(h1!.getMonth(), 0);

    const h2 = parseFlexibleDate("2023-H2");
    assert.ok(h2);
    assert.strictEqual(h2!.getMonth(), 6);
  });

  test("YYYY-Wnn → Monday of that ISO week", () => {
    // 2023-W01 contains Jan 4 (a Wednesday) → Monday = Jan 2, 2023
    const w1 = parseFlexibleDate("2023-W01");
    assert.ok(w1);
    assert.strictEqual(w1!.getFullYear(), 2023);
    assert.strictEqual(w1!.getMonth(), 0);
    assert.strictEqual(w1!.getDate(), 2);
  });

  test("FYYYYY / CYYYYY → Jan 1 of that year", () => {
    const fy = parseFlexibleDate("FY2024");
    assert.ok(fy);
    assert.strictEqual(fy!.getFullYear(), 2024);
    assert.strictEqual(fy!.getMonth(), 0);
    assert.strictEqual(fy!.getDate(), 1);

    const cy = parseFlexibleDate("CY2025");
    assert.ok(cy);
    assert.strictEqual(cy!.getFullYear(), 2025);
  });

  test("WE-YYYY-MM-DD (week-ending) → exact date", () => {
    const we = parseFlexibleDate("WE-2024-03-17");
    assert.ok(we);
    assert.strictEqual(we!.getFullYear(), 2024);
    assert.strictEqual(we!.getMonth(), 2);
    assert.strictEqual(we!.getDate(), 17);
  });

  test("MAT-YYYY-MM (Moving Annual Total) → first day of anchor month", () => {
    const mat = parseFlexibleDate("MAT-2024-12");
    assert.ok(mat);
    assert.strictEqual(mat!.getFullYear(), 2024);
    assert.strictEqual(mat!.getMonth(), 11);
    assert.strictEqual(mat!.getDate(), 1);
  });

  test("YTD-YYYY-MM and YTD-YYYY → respective anchor dates", () => {
    const ytdMonth = parseFlexibleDate("YTD-2024-06");
    assert.ok(ytdMonth);
    assert.strictEqual(ytdMonth!.getMonth(), 5);

    const ytdYear = parseFlexibleDate("YTD-2024");
    assert.ok(ytdYear);
    assert.strictEqual(ytdYear!.getFullYear(), 2024);
    assert.strictEqual(ytdYear!.getMonth(), 0);
  });

  test("Comparative qualifiers (-YA / -2YA / -TY) are stripped before anchor lookup", () => {
    // The qualifier doesn't shift the anchor — it modifies the meaning
    // of the value, not the time bucket. Year is already in the label.
    const ya = parseFlexibleDate("MAT-2024-12-YA");
    assert.ok(ya);
    assert.strictEqual(ya!.getFullYear(), 2024);
    assert.strictEqual(ya!.getMonth(), 11);

    const twoYa = parseFlexibleDate("YTD-2023-06-2YA");
    assert.ok(twoYa);
    assert.strictEqual(twoYa!.getFullYear(), 2023);
    assert.strictEqual(twoYa!.getMonth(), 5);
  });

  test("Rolling / latest_n / bare comparatives stay unparseable (no fixed anchor)", () => {
    // These are anchored to "now"; without a dataset reference date we
    // intentionally refuse to invent one.
    assert.strictEqual(parseFlexibleDate("L12M"), null);
    assert.strictEqual(parseFlexibleDate("L12M-YA"), null);
    assert.strictEqual(parseFlexibleDate("L12M-2YA"), null);
    assert.strictEqual(parseFlexibleDate("L52W"), null);
    assert.strictEqual(parseFlexibleDate("L4W-YA"), null);
    assert.strictEqual(parseFlexibleDate("L1Y"), null);
    assert.strictEqual(parseFlexibleDate("MAT-TY"), null);
    assert.strictEqual(parseFlexibleDate("MAT-YA"), null);
    assert.strictEqual(parseFlexibleDate("YTD-TY"), null);
    assert.strictEqual(parseFlexibleDate("YTD-YA"), null);
    assert.strictEqual(parseFlexibleDate("YTD-2YA"), null);
    assert.strictEqual(parseFlexibleDate("MTD-YA"), null);
    // X-prefixed unknown years (matchBareMonth / matchQuarter low-confidence
    // outputs) shouldn't suddenly resolve to a real anchor either.
    assert.strictEqual(parseFlexibleDate("XXXX-Q1"), null);
    assert.strictEqual(parseFlexibleDate("XXXX-W12"), null);
  });

  test("Out-of-range components return null", () => {
    assert.strictEqual(parseFlexibleDate("1800-Q1"), null);
    assert.strictEqual(parseFlexibleDate("2024-Q5"), null);
    assert.strictEqual(parseFlexibleDate("2024-H3"), null);
    assert.strictEqual(parseFlexibleDate("2024-W54"), null);
    assert.strictEqual(parseFlexibleDate("MAT-2024-13"), null);
  });
});

describe("applyTemporalFacetColumns · ISO period rows now produce non-null facets", () => {
  test("PeriodIso column with mixed calendar + latest_n values yields non-null facets only on calendar rows", () => {
    const rows: Record<string, any>[] = [
      { PeriodIso: "2023-Q1", Value: 100 },
      { PeriodIso: "2023-Q2", Value: 200 },
      { PeriodIso: "2024-Q1", Value: 150 },
      { PeriodIso: "L12M-2YA", Value: 999 }, // intentionally null facets
    ];
    applyTemporalFacetColumns(rows, ["PeriodIso"]);

    const yearKey = "Year · PeriodIso";
    const quarterKey = "Quarter · PeriodIso";
    // Calendar rows now have non-null facets (the empty-temporal-columns fix)
    assert.strictEqual(rows[0][yearKey], "2023");
    assert.strictEqual(rows[0][quarterKey], "2023-Q1");
    assert.strictEqual(rows[1][yearKey], "2023");
    assert.strictEqual(rows[1][quarterKey], "2023-Q2");
    assert.strictEqual(rows[2][yearKey], "2024");
    // Rolling row stays null — that's the documented out-of-scope case
    assert.strictEqual(rows[3][yearKey] ?? null, null);
    assert.strictEqual(rows[3][quarterKey] ?? null, null);
  });
});
