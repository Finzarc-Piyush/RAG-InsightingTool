import test from "node:test";
import assert from "node:assert/strict";
import {
  applyChartFilters,
  CHART_SERIES_VISIBILITY_FILTER_KEY,
  deriveChartFilterDefinitions,
  visibleSeriesKeysFromFilters,
} from "./chartFilters.ts";

test("applyChartFilters ignores series visibility key (no row column)", () => {
  const rows = [{ month: "2025-01", A: 1, B: 2 }];
  const filtered = applyChartFilters(rows, {
    [CHART_SERIES_VISIBILITY_FILTER_KEY]: {
      type: "categorical",
      values: ["A"],
    },
  });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].month, "2025-01");
});

test("forceNumeric emits only numeric filter, not date, for measure column", () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({
    Month: `2015-${String((i % 12) + 1).padStart(2, "0")}-01`,
    Furniture: 40000 + i * 100,
    Technology: 10000 + i * 50,
  }));
  const defs = deriveChartFilterDefinitions(rows, {
    forceNumericKeys: ["Furniture"],
    forceDateKeys: ["Month"],
  });
  assert.ok(defs.some((d) => d.type === "date" && d.key === "Month"));
  assert.ok(!defs.some((d) => d.type === "date" && d.key === "Furniture"));
  assert.ok(defs.some((d) => d.type === "numeric" && d.key === "Furniture"));
});

test("large sales magnitudes do not become date filters without forceNumeric", () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({
    Month: `2015-${String((i % 12) + 1).padStart(2, "0")}-01`,
    Furniture: 50000 + i * 1000,
  }));
  const defs = deriveChartFilterDefinitions(rows, { forceDateKeys: ["Month"] });
  assert.ok(!defs.some((d) => d.type === "date" && d.key === "Furniture"));
});

test("visibleSeriesKeysFromFilters respects categorical selection", () => {
  const keys = ["A", "B", "C"];
  const out = visibleSeriesKeysFromFilters(keys, {
    [CHART_SERIES_VISIBILITY_FILTER_KEY]: { type: "categorical", values: ["A"] },
  });
  assert.deepEqual(out, ["A"]);
});
