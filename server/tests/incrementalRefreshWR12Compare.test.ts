/**
 * Wave WR12 (incremental refresh) · April-vs-May compare.
 *
 * Pins the pure delta math: per-chart totals matched by axis-aware identity,
 * % change, and the "no prior → not available" guard.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildRefreshCompare, chartTotal } from "../lib/refresh/compareVersions.js";
import type { ChartSpec } from "../shared/schema.js";

const chart = (over: Partial<ChartSpec>): ChartSpec =>
  ({ type: "bar", title: "Value sales", x: "Brand", y: "Sales", data: [], ...over }) as ChartSpec;

describe("WR12 · chartTotal", () => {
  it("sums the numeric y-values", () => {
    const c = chart({ data: [{ Brand: "A", Sales: 100 }, { Brand: "B", Sales: 50 }] });
    assert.equal(chartTotal(c), 150);
  });
  it("ignores non-numeric values", () => {
    const c = chart({ data: [{ Sales: 100 }, { Sales: "n/a" }] });
    assert.equal(chartTotal(c), 100);
  });
});

describe("WR12 · buildRefreshCompare", () => {
  it("diffs matched charts and computes % change", () => {
    const prior = [chart({ data: [{ Sales: 100 }, { Sales: 100 }] })]; // 200
    const current = [chart({ data: [{ Sales: 120 }, { Sales: 100 }] })]; // 220
    const out = buildRefreshCompare(prior, current, {
      priorLabel: "April",
      currentLabel: "May",
    });
    assert.equal(out.available, true);
    assert.equal(out.priorLabel, "April");
    assert.equal(out.rows.length, 1);
    assert.equal(out.rows[0]?.priorTotal, 200);
    assert.equal(out.rows[0]?.currentTotal, 220);
    assert.equal(out.rows[0]?.delta, 20);
    assert.equal(Math.round(out.rows[0]?.deltaPct ?? 0), 10);
  });

  it("skips charts present in only one version (needs both sides)", () => {
    const prior = [chart({ title: "A", seriesColumn: "X" })];
    const current = [chart({ title: "A", seriesColumn: "Y" })]; // different identity
    const out = buildRefreshCompare(prior, current);
    assert.equal(out.available, false);
    assert.equal(out.rows.length, 0);
  });

  it("deltaPct is null when prior total is 0 (undefined growth)", () => {
    const out = buildRefreshCompare(
      [chart({ data: [{ Sales: 0 }] })],
      [chart({ data: [{ Sales: 50 }] })]
    );
    assert.equal(out.rows[0]?.deltaPct, null);
    assert.equal(out.rows[0]?.delta, 50);
  });

  it("not available when there is no prior", () => {
    assert.equal(buildRefreshCompare(undefined, [chart({})]).available, false);
  });
});
