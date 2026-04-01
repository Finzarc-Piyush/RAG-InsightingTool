import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildLegacyToDisplayFacetMap,
  facetColumnKey,
  facetColumnLegacyMachineKey,
} from "../lib/temporalFacetColumns.js";
import { normalizeLegacyTemporalFacetKeysInPlan } from "../lib/queryPlanExecutor.js";

describe("buildLegacyToDisplayFacetMap", () => {
  it("maps legacy machine keys and persisted legacy meta.name to display ids", () => {
    const summary = {
      dateColumns: ["Order Date"],
      temporalFacetColumns: [
        {
          name: "__tf_month__Order_Date",
          sourceColumn: "Order Date",
          grain: "month" as const,
        },
      ],
    };
    const map = buildLegacyToDisplayFacetMap(summary);
    const display = facetColumnKey("Order Date", "month");
    assert.equal(map.get("__tf_month__Order_Date"), display);
    assert.equal(map.get(facetColumnLegacyMachineKey("Order Date", "month")), display);
  });
});

describe("normalizeLegacyTemporalFacetKeysInPlan", () => {
  it("rewrites legacy facet ids to display ids (passthrough for display)", () => {
    const summary = {
      rowCount: 1,
      columnCount: 2,
      columns: [
        { name: "Sales", type: "number", sampleValues: [] },
        { name: "Order Date", type: "date", sampleValues: [] },
      ],
      numericColumns: ["Sales"],
      dateColumns: ["Order Date"],
    };
    const display = facetColumnKey("Order Date", "month");
    const planIn = {
      groupBy: ["__tf_month__Order_Date"],
      aggregations: [{ column: "Sales", operation: "sum" as const }],
      sort: [{ column: "__tf_month__Order_Date", direction: "asc" as const }],
    };
    const out = normalizeLegacyTemporalFacetKeysInPlan(planIn, summary);
    assert.deepEqual(out.groupBy, [display]);
    assert.deepEqual(out.sort, [{ column: display, direction: "asc" }]);

    const planDisplay = {
      groupBy: [display],
      aggregations: [{ column: "Sales", operation: "sum" as const }],
    };
    const out2 = normalizeLegacyTemporalFacetKeysInPlan(planDisplay, summary);
    assert.deepEqual(out2.groupBy, [display]);
  });
});
