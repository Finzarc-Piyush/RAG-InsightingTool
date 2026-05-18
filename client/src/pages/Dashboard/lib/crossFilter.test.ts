import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { ActiveChartFilters } from "../../../lib/chartFilters";
import {
  CROSS_FILTER_EVENT,
  applyCrossFilter,
  clearCrossFilter,
  dispatchCrossFilter,
  isCrossFilterActive,
  listActiveCrossFilters,
  removeCrossFilter,
  toFilterValue,
} from "./crossFilter.js";

describe("WD2 · toFilterValue — value coercion", () => {
  it("passes strings through unchanged", () => {
    assert.equal(toFilterValue("North"), "North");
  });
  it("stringifies numbers", () => {
    assert.equal(toFilterValue(42), "42");
    assert.equal(toFilterValue(0), "0");
    assert.equal(toFilterValue(-3.14), "-3.14");
  });
  it("stringifies booleans", () => {
    assert.equal(toFilterValue(true), "true");
    assert.equal(toFilterValue(false), "false");
  });
  it("maps null and undefined to the literal 'null'", () => {
    assert.equal(toFilterValue(null), "null");
    assert.equal(toFilterValue(undefined), "null");
  });
});

describe("WD2 · isCrossFilterActive", () => {
  it("returns false on an empty global map", () => {
    assert.equal(isCrossFilterActive({}, "region", "North"), false);
  });

  it("returns true when the value is present in the column's categorical selection", () => {
    const g: ActiveChartFilters = {
      region: { type: "categorical", values: ["North", "South"] },
    };
    assert.equal(isCrossFilterActive(g, "region", "North"), true);
    assert.equal(isCrossFilterActive(g, "region", "South"), true);
  });

  it("returns false when the value is absent", () => {
    const g: ActiveChartFilters = {
      region: { type: "categorical", values: ["North"] },
    };
    assert.equal(isCrossFilterActive(g, "region", "East"), false);
  });

  it("returns false for non-categorical selections on the column (date / numeric)", () => {
    const g: ActiveChartFilters = {
      date: { type: "date", start: "2024-01-01", end: "2024-12-31" },
      value: { type: "numeric", min: 0, max: 100 },
    };
    assert.equal(isCrossFilterActive(g, "date", "2024-06-15"), false);
    assert.equal(isCrossFilterActive(g, "value", 50), false);
  });

  it("coerces numeric / null clicks to string before comparison", () => {
    const g: ActiveChartFilters = {
      year: { type: "categorical", values: ["2024", "null"] },
    };
    assert.equal(isCrossFilterActive(g, "year", 2024), true);
    assert.equal(isCrossFilterActive(g, "year", null), true);
  });
});

describe("WD2 · applyCrossFilter — toggle on empty / categorical column", () => {
  it("installs a fresh categorical selection on a column with no existing filter", () => {
    const out = applyCrossFilter({}, { column: "region", value: "North" });
    assert.deepEqual(out, {
      region: { type: "categorical", values: ["North"] },
    });
  });

  it("appends the value when the column already has a categorical selection that lacks it", () => {
    const before: ActiveChartFilters = {
      region: { type: "categorical", values: ["North"] },
    };
    const out = applyCrossFilter(before, { column: "region", value: "South" });
    assert.deepEqual(out.region, {
      type: "categorical",
      values: ["North", "South"],
    });
  });

  it("removes the value (toggle off) when it is already in the selection", () => {
    const before: ActiveChartFilters = {
      region: { type: "categorical", values: ["North", "South"] },
    };
    const out = applyCrossFilter(before, { column: "region", value: "North" });
    assert.deepEqual(out.region, {
      type: "categorical",
      values: ["South"],
    });
  });

  it("drops the column entirely when the last value is removed", () => {
    const before: ActiveChartFilters = {
      region: { type: "categorical", values: ["North"] },
    };
    const out = applyCrossFilter(before, { column: "region", value: "North" });
    assert.equal(out.region, undefined);
    assert.equal(Object.keys(out).length, 0);
  });
});

describe("WD2 · applyCrossFilter — non-categorical column", () => {
  it("replaces a date selection with a fresh categorical selection", () => {
    const before: ActiveChartFilters = {
      date: { type: "date", start: "2024-01-01", end: "2024-12-31" },
    };
    const out = applyCrossFilter(before, { column: "date", value: "2024-06-15" });
    assert.deepEqual(out.date, {
      type: "categorical",
      values: ["2024-06-15"],
    });
  });

  it("replaces a numeric selection with a fresh categorical selection", () => {
    const before: ActiveChartFilters = {
      value: { type: "numeric", min: 0, max: 100 },
    };
    const out = applyCrossFilter(before, { column: "value", value: 42 });
    assert.deepEqual(out.value, {
      type: "categorical",
      values: ["42"],
    });
  });
});

describe("WD2 · applyCrossFilter — purity (input not mutated)", () => {
  it("does not mutate the input global map", () => {
    const before: ActiveChartFilters = {
      region: { type: "categorical", values: ["North"] },
    };
    const snapshot = JSON.parse(JSON.stringify(before));
    applyCrossFilter(before, { column: "region", value: "South" });
    applyCrossFilter(before, { column: "channel", value: "MT" });
    assert.deepEqual(before, snapshot);
  });
});

describe("WD2 · applyCrossFilter — value coercion", () => {
  it("coerces null clicks to the literal 'null' value", () => {
    const out = applyCrossFilter({}, { column: "brand", value: null });
    assert.deepEqual(out.brand, {
      type: "categorical",
      values: ["null"],
    });
  });

  it("coerces numeric clicks to their string form", () => {
    const out = applyCrossFilter({}, { column: "year", value: 2024 });
    assert.deepEqual(out.year, {
      type: "categorical",
      values: ["2024"],
    });
  });
});

describe("WD2 · removeCrossFilter", () => {
  it("removes the value and keeps other values intact", () => {
    const before: ActiveChartFilters = {
      region: { type: "categorical", values: ["North", "South", "East"] },
    };
    const out = removeCrossFilter(before, "region", "South");
    assert.deepEqual(out.region, {
      type: "categorical",
      values: ["North", "East"],
    });
  });

  it("drops the column when the last value is removed", () => {
    const before: ActiveChartFilters = {
      region: { type: "categorical", values: ["North"] },
    };
    const out = removeCrossFilter(before, "region", "North");
    assert.equal(out.region, undefined);
  });

  it("is a no-op when the value is not in the selection (returns identity)", () => {
    const before: ActiveChartFilters = {
      region: { type: "categorical", values: ["North"] },
    };
    const out = removeCrossFilter(before, "region", "East");
    assert.equal(out, before);
  });

  it("is a no-op when the column has a non-categorical selection", () => {
    const before: ActiveChartFilters = {
      date: { type: "date", start: "2024-01-01" },
    };
    const out = removeCrossFilter(before, "date", "2024-06-15");
    assert.equal(out, before);
  });
});

describe("WD2 · clearCrossFilter", () => {
  it("removes the entire column from the global map", () => {
    const before: ActiveChartFilters = {
      region: { type: "categorical", values: ["North", "South"] },
      channel: { type: "categorical", values: ["MT"] },
    };
    const out = clearCrossFilter(before, "region");
    assert.equal(out.region, undefined);
    assert.deepEqual(out.channel, { type: "categorical", values: ["MT"] });
  });

  it("is a no-op when the column has no selection (returns identity)", () => {
    const before: ActiveChartFilters = {
      region: { type: "categorical", values: ["North"] },
    };
    const out = clearCrossFilter(before, "channel");
    assert.equal(out, before);
  });
});

describe("WD2 · listActiveCrossFilters — flat enumeration", () => {
  it("returns an empty list for an empty map", () => {
    assert.deepEqual(listActiveCrossFilters({}), []);
  });

  it("flattens categorical columns into (column, value) pairs in column-sorted order", () => {
    const g: ActiveChartFilters = {
      region: { type: "categorical", values: ["South", "North"] },
      channel: { type: "categorical", values: ["GT", "MT"] },
    };
    const out = listActiveCrossFilters(g);
    assert.deepEqual(out, [
      { column: "channel", value: "GT" },
      { column: "channel", value: "MT" },
      { column: "region", value: "North" },
      { column: "region", value: "South" },
    ]);
  });

  it("skips non-categorical selections", () => {
    const g: ActiveChartFilters = {
      region: { type: "categorical", values: ["North"] },
      date: { type: "date", start: "2024-01-01" },
      value: { type: "numeric", min: 0, max: 100 },
    };
    const out = listActiveCrossFilters(g);
    assert.deepEqual(out, [{ column: "region", value: "North" }]);
  });
});

describe("WD2 · dispatchCrossFilter — runtime behaviour", () => {
  it("returns false in a non-browser environment (no window)", () => {
    // node:test runs without a DOM by default → `window` should be undefined.
    assert.equal(typeof window, "undefined");
    const ok = dispatchCrossFilter({ column: "region", value: "North" });
    assert.equal(ok, false);
  });

  it("exposes the canonical event name", () => {
    assert.equal(CROSS_FILTER_EVENT, "marico:cross-filter");
  });
});
