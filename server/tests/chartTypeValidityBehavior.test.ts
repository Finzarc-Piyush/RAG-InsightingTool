import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  chartTypeValidityForPivot,
  PIVOT_CHART_KINDS,
} from "../shared/pivot/chartTypeValidity.js";
import type { PivotChartRecommendationInput } from "../shared/pivot/chartRecommendation.js";
import {
  HEATMAP_MAX_COL_KEYS,
  HEATMAP_MAX_ROW_KEYS,
  PIE_MAX_CATEGORIES,
  RADAR_MAX_SPOKES,
} from "../shared/pivot/chartLimits.js";

/**
 * Behavioral coverage for the pivot "Change chart type" validity map
 * (shared/pivot/chartTypeValidity.ts). Pure function: pivot config + column
 * metadata → per-mark { valid, reason }. Exercises the minimum-shape rules,
 * the numeric-measure-count gates (scatter/bubble), and the cardinality
 * ceilings (pie/radar/heatmap) including the at/over-the-limit boundary.
 */

function baseInput(
  over: Partial<PivotChartRecommendationInput> = {},
): PivotChartRecommendationInput {
  return {
    pivotConfig: { rows: [], columns: [], values: [] },
    numericColumns: [],
    dateColumns: [],
    rowCount: 0,
    colKeyCount: 0,
    ...over,
  };
}

describe("chartTypeValidityForPivot · bar/line/area minimum (row dim + numeric measure)", () => {
  it("valid when a row dimension and a numeric measure are present", () => {
    const map = chartTypeValidityForPivot(
      baseInput({
        pivotConfig: { rows: ["Region"], columns: [], values: [{ field: "Sales" }] },
        numericColumns: ["Sales"],
        rowCount: 4,
      }),
    );
    assert.equal(map.bar.valid, true);
    assert.equal(map.line.valid, true);
    assert.equal(map.area.valid, true);
    // bar/line/area share the same MarkValidity object (same minimum rule).
    assert.equal(map.bar.reason, map.line.reason);
  });

  it("invalid (with guidance reason) when there is no numeric measure", () => {
    const map = chartTypeValidityForPivot(
      baseInput({
        pivotConfig: { rows: ["Region"], columns: [], values: [{ field: "Region" }] },
        numericColumns: [],
        rowCount: 4,
      }),
    );
    assert.equal(map.bar.valid, false);
    assert.match(map.bar.reason, /numeric measure/i);
  });
});

describe("chartTypeValidityForPivot · scatter & bubble numeric-measure gates", () => {
  it("scatter needs >=2 numeric measures; bubble needs >=3", () => {
    const twoNumeric = chartTypeValidityForPivot(
      baseInput({
        pivotConfig: { rows: ["Region"], columns: [], values: [{ field: "Sales" }] },
        numericColumns: ["Sales", "Profit"],
        rowCount: 5,
      }),
    );
    assert.equal(twoNumeric.scatter.valid, true);
    assert.equal(twoNumeric.bubble.valid, false, "two measures is not enough for bubble");

    const threeNumeric = chartTypeValidityForPivot(
      baseInput({
        pivotConfig: { rows: ["Region"], columns: [], values: [{ field: "Sales" }] },
        numericColumns: ["Sales", "Profit", "Units"],
        rowCount: 5,
      }),
    );
    assert.equal(threeNumeric.scatter.valid, true);
    assert.equal(threeNumeric.bubble.valid, true);
  });

  it("scatter invalid with a single numeric measure", () => {
    const map = chartTypeValidityForPivot(
      baseInput({
        pivotConfig: { rows: ["Region"], columns: [], values: [{ field: "Sales" }] },
        numericColumns: ["Sales"],
        rowCount: 5,
      }),
    );
    assert.equal(map.scatter.valid, false);
    assert.match(map.scatter.reason, /two numeric measures/i);
  });
});

describe("chartTypeValidityForPivot · pie/donut cardinality ceiling", () => {
  it("valid at the limit, invalid one past it (boundary)", () => {
    const atLimit = chartTypeValidityForPivot(
      baseInput({
        pivotConfig: { rows: ["Brand"], columns: [], values: [{ field: "Sales" }] },
        numericColumns: ["Sales"],
        rowCount: PIE_MAX_CATEGORIES,
      }),
    );
    assert.equal(atLimit.pie.valid, true);
    assert.equal(atLimit.donut.valid, true, "pie and donut share the rule");

    const overLimit = chartTypeValidityForPivot(
      baseInput({
        pivotConfig: { rows: ["Brand"], columns: [], values: [{ field: "Sales" }] },
        numericColumns: ["Sales"],
        rowCount: PIE_MAX_CATEGORIES + 1,
      }),
    );
    assert.equal(overLimit.pie.valid, false);
    assert.match(overLimit.pie.reason, new RegExp(`${PIE_MAX_CATEGORIES} categories`));
  });
});

describe("chartTypeValidityForPivot · radar needs >=3 numeric measures over one row dim", () => {
  it("valid with three numeric value fields within the spoke limit", () => {
    const map = chartTypeValidityForPivot(
      baseInput({
        pivotConfig: {
          rows: ["Brand"],
          columns: [],
          values: [{ field: "Sales" }, { field: "Profit" }, { field: "Units" }],
        },
        numericColumns: ["Sales", "Profit", "Units"],
        rowCount: RADAR_MAX_SPOKES,
      }),
    );
    assert.equal(map.radar.valid, true);
  });

  it("invalid when row cardinality exceeds the spoke ceiling", () => {
    const map = chartTypeValidityForPivot(
      baseInput({
        pivotConfig: {
          rows: ["Brand"],
          columns: [],
          values: [{ field: "Sales" }, { field: "Profit" }, { field: "Units" }],
        },
        numericColumns: ["Sales", "Profit", "Units"],
        rowCount: RADAR_MAX_SPOKES + 1,
      }),
    );
    assert.equal(map.radar.valid, false);
    assert.match(map.radar.reason, new RegExp(`${RADAR_MAX_SPOKES} spokes`));
  });
});

describe("chartTypeValidityForPivot · heatmap needs row+col dims and bounded cardinality", () => {
  it("valid with row dim, column dim, numeric value, within both ceilings", () => {
    const map = chartTypeValidityForPivot(
      baseInput({
        pivotConfig: { rows: ["Region"], columns: ["Month"], values: [{ field: "Sales" }] },
        numericColumns: ["Sales"],
        rowCount: HEATMAP_MAX_ROW_KEYS,
        colKeyCount: HEATMAP_MAX_COL_KEYS,
      }),
    );
    assert.equal(map.heatmap.valid, true);
  });

  it("invalid without a column dimension (reason names the missing column dim)", () => {
    const map = chartTypeValidityForPivot(
      baseInput({
        pivotConfig: { rows: ["Region"], columns: [], values: [{ field: "Sales" }] },
        numericColumns: ["Sales"],
        rowCount: 5,
        colKeyCount: 0,
      }),
    );
    assert.equal(map.heatmap.valid, false);
    assert.match(map.heatmap.reason, /column dimension/i);
  });

  it("invalid when column cardinality exceeds the heatmap ceiling", () => {
    const map = chartTypeValidityForPivot(
      baseInput({
        pivotConfig: { rows: ["Region"], columns: ["Day"], values: [{ field: "Sales" }] },
        numericColumns: ["Sales"],
        rowCount: 5,
        colKeyCount: HEATMAP_MAX_COL_KEYS + 1,
      }),
    );
    assert.equal(map.heatmap.valid, false);
    assert.match(map.heatmap.reason, /cardinality/i);
  });
});

describe("chartTypeValidityForPivot · map shape", () => {
  it("returns a MarkValidity for every declared pivot chart kind", () => {
    const map = chartTypeValidityForPivot(baseInput());
    for (const kind of PIVOT_CHART_KINDS) {
      const entry = map[kind];
      assert.equal(typeof entry.valid, "boolean", `${kind} must carry a boolean valid`);
      assert.equal(typeof entry.reason, "string", `${kind} must carry a reason string`);
      assert.ok(entry.reason.length > 0, `${kind} reason must be non-empty`);
    }
  });
});
