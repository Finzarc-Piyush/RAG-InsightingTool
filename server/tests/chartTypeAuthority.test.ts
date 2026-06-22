import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isTemporalChartX,
  resolveChartType,
} from "../lib/chartTypeAuthority.js";

test("chartTypeAuthority: raw date column is temporal → line", () => {
  const input = { dateColumns: ["Order Date"] as const };
  assert.equal(isTemporalChartX("Order Date", input), true);
  assert.equal(resolveChartType("Order Date", input), "line");
});

test("chartTypeAuthority: temporal facet display keys are temporal → line", () => {
  const input = { dateColumns: ["Date"] as const };
  // Facet keys live in summary.columns (type "string"), NOT in dateColumns —
  // they must still resolve as temporal. This is the core regression.
  for (const facet of [
    "Day · Date",
    "Week · Date",
    "Month · Order Date",
    "Quarter · Date",
    "Half-year · Date",
    "Year · Date",
  ]) {
    assert.equal(isTemporalChartX(facet, input), true, facet);
    assert.equal(resolveChartType(facet, input), "line", facet);
  }
});

test("chartTypeAuthority: legacy __tf_* facet keys are temporal → line", () => {
  const input = { dateColumns: ["Date"] as const };
  assert.equal(isTemporalChartX("__tf_month__Date", input), true);
  assert.equal(resolveChartType("__tf_month__Date", input), "line");
});

test("chartTypeAuthority: periodAxisPicked forces temporal → line", () => {
  const input = { dateColumns: [] as const, periodAxisPicked: true };
  assert.equal(isTemporalChartX("Period", input), true);
  assert.equal(resolveChartType("Period", input), "line");
});

test("chartTypeAuthority: plain categorical column → bar", () => {
  const input = { dateColumns: ["Date"] as const };
  assert.equal(isTemporalChartX("Region", input), false);
  assert.equal(resolveChartType("Region", input), "bar");
});

test("chartTypeAuthority: facet near-miss must NOT match (anchored regex)", () => {
  const input = { dateColumns: ["Date"] as const };
  // Not a "<Grain> · <col>" header — must stay categorical.
  assert.equal(isTemporalChartX("Daylight · Region", input), false);
  assert.equal(resolveChartType("Daylight · Region", input), "bar");
});
