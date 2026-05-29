import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateChartAgainstIntent,
  chartIntentGuardEnabled,
} from "../lib/agents/runtime/chartIntentGuard.js";
import type { ChartSpec } from "../shared/schema.js";
import type { IntentEnvelope } from "../lib/agents/runtime/types.js";

const FSG_EXCLUDED: IntentEnvelope = {
  exclusions: [
    {
      column: "Products",
      values: ["FEMALE SHOWER GEL"],
      source: "rollup-peer-mode",
    },
  ],
};

function barSpec(data: Array<{ Products: string; max_value: number }>): ChartSpec {
  return {
    type: "bar",
    title: "max_value by Products",
    x: "Products",
    y: "max_value",
    aggregate: "none",
    data,
  } as unknown as ChartSpec;
}

describe("RD4 · validateChartAgainstIntent — chart-vs-intent consistency", () => {
  it("drops single-bar chart whose only value is excluded (the FSG bug)", () => {
    const spec = barSpec([
      { Products: "FEMALE SHOWER GEL", max_value: 2.55e12 },
    ]);
    const verdict = validateChartAgainstIntent(spec, FSG_EXCLUDED);
    assert.equal(verdict.ok, false);
    if (verdict.ok) return;
    assert.equal(verdict.drop, true);
    assert.equal(verdict.reason, "single_excluded_bar");
  });

  it("drops multi-bar chart whose LEADER is excluded", () => {
    const spec = barSpec([
      { Products: "FEMALE SHOWER GEL", max_value: 2.55e12 },
      { Products: "MARICO", max_value: 1.8e12 },
      { Products: "PURITE", max_value: 4.5e11 },
    ]);
    const verdict = validateChartAgainstIntent(spec, FSG_EXCLUDED);
    assert.equal(verdict.ok, false);
    if (verdict.ok) return;
    assert.equal(verdict.drop, true);
    assert.equal(verdict.reason, "excluded_leader");
    assert.deepEqual(verdict.excludedValues, ["female shower gel"]);
  });

  it("recovers (does not drop) when excluded value is present but not the leader", () => {
    const spec = barSpec([
      { Products: "MARICO", max_value: 4.5e12 },
      { Products: "FEMALE SHOWER GEL", max_value: 2.55e12 },
      { Products: "PURITE", max_value: 4.5e11 },
    ]);
    const verdict = validateChartAgainstIntent(spec, FSG_EXCLUDED);
    assert.equal(verdict.ok, false);
    if (verdict.ok) return;
    assert.equal(verdict.drop, false);
    assert.equal(verdict.reason, "filter_pollution");
    assert.ok(verdict.cleanedRows);
    assert.equal(verdict.cleanedRows!.length, 2);
    assert.equal(
      verdict.cleanedRows!.every(
        (r) => String(r.Products).toLowerCase() !== "female shower gel"
      ),
      true
    );
  });

  it("returns ok=true when chart x-column does NOT overlap with exclusion column", () => {
    const spec: ChartSpec = {
      type: "bar",
      title: "Sales by Markets",
      x: "Markets",
      y: "sum_value",
      aggregate: "none",
      data: [
        { Markets: "WEST", sum_value: 100 },
        { Markets: "EAST", sum_value: 80 },
      ],
    } as unknown as ChartSpec;
    const verdict = validateChartAgainstIntent(spec, FSG_EXCLUDED);
    assert.equal(verdict.ok, true);
  });

  it("returns ok=true when intent envelope has no exclusions", () => {
    const spec = barSpec([
      { Products: "FEMALE SHOWER GEL", max_value: 2.55e12 },
    ]);
    const verdict = validateChartAgainstIntent(spec, { exclusions: [] });
    assert.equal(verdict.ok, true);
  });

  it("returns ok=true when intent envelope is undefined (perf guarantee)", () => {
    const spec = barSpec([
      { Products: "FEMALE SHOWER GEL", max_value: 2.55e12 },
    ]);
    const verdict = validateChartAgainstIntent(spec, undefined);
    assert.equal(verdict.ok, true);
  });

  it("case-insensitive match on column name AND value", () => {
    const spec: ChartSpec = {
      type: "bar",
      title: "max by products",
      x: "products", // lowercase
      y: "max_value",
      aggregate: "none",
      data: [{ products: "female shower gel", max_value: 1 }],
    } as unknown as ChartSpec;
    const verdict = validateChartAgainstIntent(spec, FSG_EXCLUDED);
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      assert.equal(verdict.drop, true);
    }
  });

  it("empty chart data → ok=true (nothing to validate)", () => {
    const spec = barSpec([]);
    const verdict = validateChartAgainstIntent(spec, FSG_EXCLUDED);
    assert.equal(verdict.ok, true);
  });
});

describe("RD4 · chartIntentGuardEnabled kill switch", () => {
  it("returns true by default", () => {
    const prev = process.env.AGENT_CHART_INTENT_GUARD;
    delete process.env.AGENT_CHART_INTENT_GUARD;
    try {
      assert.equal(chartIntentGuardEnabled(), true);
    } finally {
      if (prev !== undefined) process.env.AGENT_CHART_INTENT_GUARD = prev;
    }
  });

  it("returns false when AGENT_CHART_INTENT_GUARD=false", () => {
    const prev = process.env.AGENT_CHART_INTENT_GUARD;
    process.env.AGENT_CHART_INTENT_GUARD = "false";
    try {
      assert.equal(chartIntentGuardEnabled(), false);
    } finally {
      if (prev === undefined) delete process.env.AGENT_CHART_INTENT_GUARD;
      else process.env.AGENT_CHART_INTENT_GUARD = prev;
    }
  });
});
