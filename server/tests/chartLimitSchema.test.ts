import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chartLimitSpecSchema,
  chartSpecSchema,
  createReportDashboardRequestSchema,
} from "../shared/schema.js";

/**
 * Wave 1 (bar-chart limit) · the durable `limit` field is the persisted sibling
 * of the ephemeral client ChartLimit. These tests pin two contracts:
 *  1. `chartSpecSchema` round-trips `limit:{mode,n}` (it is a declared field, so
 *     it is NOT stripped as an unknown key).
 *  2. `limit` propagates to a by-value nester (createReportDashboardRequestSchema
 *     embeds `chartSpecSchema` directly), proving no mirror is needed — the same
 *     property `sort` relies on (lesson L-021).
 */
describe("chartLimitSpecSchema", () => {
  it("accepts a valid top/bottom selection", () => {
    assert.deepEqual(
      chartLimitSpecSchema.parse({ mode: "top", n: 15 }),
      { mode: "top", n: 15 },
    );
    assert.deepEqual(
      chartLimitSpecSchema.parse({ mode: "bottom", n: 10 }),
      { mode: "bottom", n: 10 },
    );
  });

  it("rejects an unknown mode, zero/negative n, and non-integer n", () => {
    assert.equal(chartLimitSpecSchema.safeParse({ mode: "middle", n: 5 }).success, false);
    assert.equal(chartLimitSpecSchema.safeParse({ mode: "top", n: 0 }).success, false);
    assert.equal(chartLimitSpecSchema.safeParse({ mode: "top", n: -3 }).success, false);
    assert.equal(chartLimitSpecSchema.safeParse({ mode: "top", n: 2.5 }).success, false);
  });
});

describe("chartSpecSchema · durable limit field", () => {
  it("round-trips a baked limit on a bar chart spec", () => {
    const spec = chartSpecSchema.parse({
      type: "bar",
      title: "NR by P3 Brand: Code",
      x: "P3 Brand: Code",
      y: "NR_mean",
      sort: { by: "value", direction: "desc" },
      limit: { mode: "top", n: 15 },
    });
    assert.deepEqual(spec.limit, { mode: "top", n: 15 });
    // limit is decoupled from sort/maxRows — sort survives independently.
    assert.deepEqual(spec.sort, { by: "value", direction: "desc" });
    assert.equal(spec.maxRows, undefined);
  });

  it("omits limit when absent (no default injected)", () => {
    const spec = chartSpecSchema.parse({
      type: "bar",
      title: "t",
      x: "x",
      y: "y",
    });
    assert.equal(spec.limit, undefined);
  });
});

describe("limit propagates to a by-value nester (no mirror)", () => {
  it("survives a createReportDashboardRequestSchema parse", () => {
    const parsed = createReportDashboardRequestSchema.parse({
      name: "Finance Dashboard",
      summaryBody: "x",
      charts: [
        {
          type: "bar",
          title: "NR by P3 Brand: Code",
          x: "P3 Brand: Code",
          y: "NR_mean",
          limit: { mode: "bottom", n: 8 },
        },
      ],
    });
    assert.deepEqual(parsed.charts[0].limit, { mode: "bottom", n: 8 });
  });
});
