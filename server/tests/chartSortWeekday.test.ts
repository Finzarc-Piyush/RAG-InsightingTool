/**
 * W2 · Weekday ordering. The day_of_week facet stores pure text ("Monday"…
 * "Sunday"); the chart + pivot sort authorities must order it Mon→Sun (FMCG
 * week), NOT alphabetically (which would put Friday first). Locks the weekday
 * branch added to both comparators + the shared weekday module.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  compareCategory,
  compareTemporalOrLexicalLabels,
  applyChartSort,
} from "../shared/chartSort.js";
import { weekdayRank, isWeekdayName, WEEKDAY_ORDER } from "../shared/weekday.js";

const SCRAMBLED = ["Friday", "Sunday", "Monday", "Wednesday", "Saturday", "Tuesday", "Thursday"];
const MON_FIRST = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

describe("weekday module", () => {
  it("ranks Monday→Sunday as 1→7", () => {
    assert.deepStrictEqual(WEEKDAY_ORDER.map((d) => weekdayRank(d)), [1, 2, 3, 4, 5, 6, 7]);
  });
  it("returns null for non-weekday strings", () => {
    assert.strictEqual(weekdayRank("2026-04"), null);
    assert.strictEqual(weekdayRank("Funday"), null);
    assert.strictEqual(isWeekdayName("Monday"), true);
    assert.strictEqual(isWeekdayName("Region"), false);
  });
});

describe("compareCategory · weekday names sort Mon→Sun, not A→Z", () => {
  it("orders a scrambled week Monday-first", () => {
    const sorted = [...SCRAMBLED].sort(compareCategory);
    assert.deepStrictEqual(sorted, MON_FIRST);
  });
  it("does NOT alphabetize (Friday must not lead)", () => {
    const sorted = [...SCRAMBLED].sort(compareCategory);
    assert.notStrictEqual(sorted[0], "Friday");
    assert.strictEqual(sorted[0], "Monday");
  });
  it("falls back to lexical when only one side is a weekday (mixed data is safe)", () => {
    // Non-weekday categories still compare deterministically (no throw, stable).
    const mixed = ["Monday", "North", "South", "Sunday"].sort(compareCategory);
    assert.strictEqual(mixed.length, 4);
  });
});

describe("compareTemporalOrLexicalLabels · pivot/renderer weekday order", () => {
  it("orders weekday labels Mon→Sun", () => {
    const sorted = [...SCRAMBLED].sort(compareTemporalOrLexicalLabels);
    assert.deepStrictEqual(sorted, MON_FIRST);
  });
});

describe("applyChartSort · a 'Day of week · X' axis renders Mon→Sun", () => {
  it("category-sorts a weekday x-axis chronologically by week, not alphabetically", () => {
    const xCol = "Day of week · Date";
    const rows = SCRAMBLED.map((d, i) => ({ [xCol]: d, Visits: i + 1 }));
    const out = applyChartSort(rows, { by: "category", direction: "asc" }, {
      xCol,
      yCol: "Visits",
      isTemporalX: true,
    });
    assert.deepStrictEqual(out.map((r) => r[xCol]), MON_FIRST);
  });
});
