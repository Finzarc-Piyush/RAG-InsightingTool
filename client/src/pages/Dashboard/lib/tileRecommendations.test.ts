/**
 * Wave WI5 · behavioural tests for the tile recommendation helper.
 *
 * Mirrors [`explainSlice.test.ts`](./explainSlice.test.ts) and
 * [`drillThrough.test.ts`](./drillThrough.test.ts) — actual import +
 * runtime assertions, not source-inspection (the helper is a pure
 * function with no React / DOM dependency, so we exercise it directly).
 *
 * Coverage:
 *   - Constants pinned (MAX_TILE_RECOMMENDATIONS, FILTER_BOTTOM_RATIO,
 *     FILTER_TOP_RATIO) so renames break loudly.
 *   - Empty rows → empty list.
 *   - Balanced data → empty list (no rule fires).
 *   - One low value < median × 0.5 → filter-bottom rec.
 *   - One high value > median × 2.0 → filter-top rec.
 *   - Both low and high → both recs.
 *   - Non-categorical chart types (line / area / scatter / heatmap) →
 *     no filter-bottom / filter-top recs.
 *   - <3 buckets → no filter-bottom / filter-top recs.
 *   - Already-filtered categorical value → not re-surfaced.
 *   - Active filters present → clear-filters rec appears.
 *   - Active filters absent → no clear-filters rec.
 *   - MAX cap enforced when more than 3 recs would otherwise fire.
 *   - Aggregator skips nullish / empty-string x and non-numeric y rows.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  FILTER_BOTTOM_RATIO,
  FILTER_TOP_RATIO,
  MAX_TILE_RECOMMENDATIONS,
  deriveTileRecommendations,
  type TileRecommendation,
  type TileRecommendationRow,
  type TileRecommendationSpec,
} from "./tileRecommendations.js";

const BAR_SPEC: TileRecommendationSpec = { type: "bar", x: "region", y: "sales" };

describe("WI5 · pinned constants", () => {
  it("MAX_TILE_RECOMMENDATIONS = 3 (chip-row stays single-line)", () => {
    assert.equal(MAX_TILE_RECOMMENDATIONS, 3);
  });
  it("FILTER_BOTTOM_RATIO = 0.5 (loud-enough threshold)", () => {
    assert.equal(FILTER_BOTTOM_RATIO, 0.5);
  });
  it("FILTER_TOP_RATIO = 2.0 (mirror of bottom)", () => {
    assert.equal(FILTER_TOP_RATIO, 2.0);
  });
});

describe("WI5 · empty input", () => {
  it("returns [] for zero rows", () => {
    const recs = deriveTileRecommendations(BAR_SPEC, [], {});
    assert.deepEqual(recs, []);
  });
  it("returns [] for empty activeFilters + balanced rows", () => {
    const rows: TileRecommendationRow[] = [
      { region: "A", sales: 100 },
      { region: "B", sales: 105 },
      { region: "C", sales: 95 },
    ];
    const recs = deriveTileRecommendations(BAR_SPEC, rows, {});
    assert.deepEqual(recs, []);
  });
});

describe("WI5 · filter-bottom rule", () => {
  it("fires when lowest bucket < median × 0.5", () => {
    // Median of [10, 100, 110, 120] is 105. 10 < 105 × 0.5 = 52.5.
    const rows: TileRecommendationRow[] = [
      { region: "A", sales: 10 },
      { region: "B", sales: 100 },
      { region: "C", sales: 110 },
      { region: "D", sales: 120 },
    ];
    const recs = deriveTileRecommendations(BAR_SPEC, rows, {});
    const rec = recs.find((r): r is Extract<TileRecommendation, { kind: "filter-bottom" }> => r.kind === "filter-bottom");
    assert.ok(rec, "filter-bottom rec missing");
    assert.equal(rec.column, "region");
    assert.equal(rec.value, "A");
    assert.match(rec.label, /lowest.*A/i);
  });
  it("does NOT fire when lowest bucket is within the median × 0.5 threshold", () => {
    // Median of [60, 80, 100, 120] is 90. 60 >= 90 × 0.5 = 45 → no fire.
    const rows: TileRecommendationRow[] = [
      { region: "A", sales: 60 },
      { region: "B", sales: 80 },
      { region: "C", sales: 100 },
      { region: "D", sales: 120 },
    ];
    const recs = deriveTileRecommendations(BAR_SPEC, rows, {});
    assert.equal(recs.filter((r) => r.kind === "filter-bottom").length, 0);
  });
});

describe("WI5 · filter-top rule", () => {
  it("fires when highest bucket > median × 2.0", () => {
    // Median of [10, 12, 14, 100] is 13. 100 > 13 × 2.0 = 26.
    const rows: TileRecommendationRow[] = [
      { region: "A", sales: 10 },
      { region: "B", sales: 12 },
      { region: "C", sales: 14 },
      { region: "D", sales: 100 },
    ];
    const recs = deriveTileRecommendations(BAR_SPEC, rows, {});
    const rec = recs.find((r): r is Extract<TileRecommendation, { kind: "filter-top" }> => r.kind === "filter-top");
    assert.ok(rec, "filter-top rec missing");
    assert.equal(rec.column, "region");
    assert.equal(rec.value, "D");
    assert.match(rec.label, /highest.*D/i);
  });
  it("does NOT fire when highest bucket is within the median × 2.0 threshold", () => {
    // Median of [80, 90, 100, 150] is 95. 150 < 95 × 2.0 = 190 → no fire.
    const rows: TileRecommendationRow[] = [
      { region: "A", sales: 80 },
      { region: "B", sales: 90 },
      { region: "C", sales: 100 },
      { region: "D", sales: 150 },
    ];
    const recs = deriveTileRecommendations(BAR_SPEC, rows, {});
    assert.equal(recs.filter((r) => r.kind === "filter-top").length, 0);
  });
});

describe("WI5 · both extremes fire together", () => {
  it("emits filter-bottom AND filter-top when both ends cross thresholds", () => {
    // Median of [5, 50, 60, 200] is 55. 5 < 27.5 → bottom fires.
    // 200 > 110 → top fires.
    const rows: TileRecommendationRow[] = [
      { region: "A", sales: 5 },
      { region: "B", sales: 50 },
      { region: "C", sales: 60 },
      { region: "D", sales: 200 },
    ];
    const recs = deriveTileRecommendations(BAR_SPEC, rows, {});
    const kinds = recs.map((r) => r.kind);
    assert.ok(kinds.includes("filter-bottom"), "filter-bottom missing");
    assert.ok(kinds.includes("filter-top"), "filter-top missing");
  });
});

describe("WI5 · chart-type gating", () => {
  it("bar fires filter rules", () => {
    const rows: TileRecommendationRow[] = [
      { region: "A", sales: 10 },
      { region: "B", sales: 100 },
      { region: "C", sales: 110 },
    ];
    const recs = deriveTileRecommendations({ type: "bar", x: "region", y: "sales" }, rows, {});
    assert.ok(recs.some((r) => r.kind === "filter-bottom"));
  });
  it("pie fires filter rules", () => {
    const rows: TileRecommendationRow[] = [
      { region: "A", sales: 10 },
      { region: "B", sales: 100 },
      { region: "C", sales: 110 },
    ];
    const recs = deriveTileRecommendations({ type: "pie", x: "region", y: "sales" }, rows, {});
    assert.ok(recs.some((r) => r.kind === "filter-bottom"));
  });
  it("line does NOT fire filter rules (continuous x)", () => {
    const rows: TileRecommendationRow[] = [
      { region: "A", sales: 10 },
      { region: "B", sales: 100 },
      { region: "C", sales: 110 },
    ];
    const recs = deriveTileRecommendations({ type: "line", x: "region", y: "sales" }, rows, {});
    assert.equal(recs.filter((r) => r.kind === "filter-bottom" || r.kind === "filter-top").length, 0);
  });
  it("area does NOT fire filter rules", () => {
    const rows: TileRecommendationRow[] = [
      { region: "A", sales: 10 },
      { region: "B", sales: 100 },
      { region: "C", sales: 110 },
    ];
    const recs = deriveTileRecommendations({ type: "area", x: "region", y: "sales" }, rows, {});
    assert.equal(recs.filter((r) => r.kind === "filter-bottom" || r.kind === "filter-top").length, 0);
  });
  it("scatter does NOT fire filter rules (2D continuous)", () => {
    const rows: TileRecommendationRow[] = [
      { region: "A", sales: 10 },
      { region: "B", sales: 100 },
      { region: "C", sales: 110 },
    ];
    const recs = deriveTileRecommendations({ type: "scatter", x: "region", y: "sales" }, rows, {});
    assert.equal(recs.filter((r) => r.kind === "filter-bottom" || r.kind === "filter-top").length, 0);
  });
  it("heatmap does NOT fire filter rules (2D)", () => {
    const rows: TileRecommendationRow[] = [
      { region: "A", sales: 10 },
      { region: "B", sales: 100 },
      { region: "C", sales: 110 },
    ];
    const recs = deriveTileRecommendations({ type: "heatmap", x: "region", y: "sales" }, rows, {});
    assert.equal(recs.filter((r) => r.kind === "filter-bottom" || r.kind === "filter-top").length, 0);
  });
});

describe("WI5 · insufficient buckets", () => {
  it("returns no filter recs for <3 distinct x values", () => {
    const rows: TileRecommendationRow[] = [
      { region: "A", sales: 10 },
      { region: "B", sales: 100 },
    ];
    const recs = deriveTileRecommendations(BAR_SPEC, rows, {});
    assert.equal(recs.filter((r) => r.kind === "filter-bottom" || r.kind === "filter-top").length, 0);
  });
  it("returns no filter recs when all rows share the same x value", () => {
    const rows: TileRecommendationRow[] = [
      { region: "A", sales: 10 },
      { region: "A", sales: 100 },
      { region: "A", sales: 110 },
    ];
    const recs = deriveTileRecommendations(BAR_SPEC, rows, {});
    assert.equal(recs.filter((r) => r.kind === "filter-bottom" || r.kind === "filter-top").length, 0);
  });
});

describe("WI5 · already-filtered values are not re-surfaced", () => {
  it("filter-bottom skips when lowest is already in the active categorical filter", () => {
    const rows: TileRecommendationRow[] = [
      { region: "A", sales: 10 },
      { region: "B", sales: 100 },
      { region: "C", sales: 110 },
      { region: "D", sales: 120 },
    ];
    const recs = deriveTileRecommendations(BAR_SPEC, rows, {
      region: { type: "categorical", values: ["A"] },
    });
    assert.equal(recs.filter((r) => r.kind === "filter-bottom").length, 0);
  });
  it("filter-top skips when highest is already in the active categorical filter", () => {
    const rows: TileRecommendationRow[] = [
      { region: "A", sales: 10 },
      { region: "B", sales: 12 },
      { region: "C", sales: 14 },
      { region: "D", sales: 100 },
    ];
    const recs = deriveTileRecommendations(BAR_SPEC, rows, {
      region: { type: "categorical", values: ["D"] },
    });
    assert.equal(recs.filter((r) => r.kind === "filter-top").length, 0);
  });
  it("date / numeric filter on the same column does NOT count as pinning", () => {
    const rows: TileRecommendationRow[] = [
      { region: "A", sales: 10 },
      { region: "B", sales: 100 },
      { region: "C", sales: 110 },
      { region: "D", sales: 120 },
    ];
    const recs = deriveTileRecommendations(BAR_SPEC, rows, {
      region: { type: "numeric", min: 0, max: 200 },
    });
    assert.ok(recs.some((r) => r.kind === "filter-bottom"));
  });
});

describe("WI5 · clear-filters rec", () => {
  it("appears when at least one filter is active", () => {
    const recs = deriveTileRecommendations(BAR_SPEC, [], {
      brand: { type: "categorical", values: ["X"] },
    });
    assert.ok(recs.some((r) => r.kind === "clear-filters"));
  });
  it("does NOT appear when activeFilters is empty", () => {
    const recs = deriveTileRecommendations(BAR_SPEC, [], {});
    assert.equal(recs.filter((r) => r.kind === "clear-filters").length, 0);
  });
  it("does NOT appear when activeFilters has only undefined values", () => {
    // `Record<string, ChartFilterSelection | undefined>` can carry
    // dangling keys whose value is `undefined` (e.g. after a filter is
    // cleared without deleting the key). Don't fire clear-filters in
    // that case — there's nothing to clear.
    const recs = deriveTileRecommendations(BAR_SPEC, [], {
      brand: undefined,
      region: undefined,
    });
    assert.equal(recs.filter((r) => r.kind === "clear-filters").length, 0);
  });
  it("appears LAST in the recommendation list (value-driven recs first)", () => {
    const rows: TileRecommendationRow[] = [
      { region: "A", sales: 5 },
      { region: "B", sales: 50 },
      { region: "C", sales: 60 },
      { region: "D", sales: 200 },
    ];
    const recs = deriveTileRecommendations(BAR_SPEC, rows, {
      brand: { type: "categorical", values: ["X"] },
    });
    assert.ok(recs.length >= 2);
    assert.equal(recs[recs.length - 1].kind, "clear-filters");
  });
});

describe("WI5 · MAX cap", () => {
  it("never returns more than MAX_TILE_RECOMMENDATIONS recs", () => {
    // Set up a payload that would yield filter-bottom + filter-top +
    // clear-filters = 3 (already at the cap). If a 4th rule were ever
    // added that fires concurrently, the slice keeps the count at 3.
    const rows: TileRecommendationRow[] = [
      { region: "A", sales: 5 },
      { region: "B", sales: 50 },
      { region: "C", sales: 60 },
      { region: "D", sales: 200 },
    ];
    const recs = deriveTileRecommendations(BAR_SPEC, rows, {
      brand: { type: "categorical", values: ["X"] },
    });
    assert.ok(recs.length <= MAX_TILE_RECOMMENDATIONS);
  });
});

describe("WI5 · aggregator hygiene", () => {
  it("skips rows with nullish / empty-string x", () => {
    // Without the skip, `null` and `""` would each create a phantom
    // bucket and shift the median. With the skip, the median is
    // computed only over the three real buckets.
    const rows: TileRecommendationRow[] = [
      { region: null, sales: 99999 },
      { region: "", sales: 99999 },
      { region: "A", sales: 10 },
      { region: "B", sales: 100 },
      { region: "C", sales: 110 },
      { region: "D", sales: 120 },
    ];
    const recs = deriveTileRecommendations(BAR_SPEC, rows, {});
    // If skip works, median = median([10, 100, 110, 120]) = 105, and
    // the filter-bottom rule fires on "A" (10 < 52.5).
    assert.ok(
      recs.some((r) => r.kind === "filter-bottom" && r.value === "A"),
      "filter-bottom on A should fire after null/empty x rows are skipped",
    );
  });
  it("skips rows whose y is non-numeric (NaN / undefined)", () => {
    // Median of [10, 100, 110, 120] is 105. If "non-numeric" rows
    // contributed 0, the median would shift down and the rule might
    // fire spuriously on a higher value.
    const rows: TileRecommendationRow[] = [
      { region: "A", sales: 10 },
      { region: "B", sales: 100 },
      { region: "C", sales: 110 },
      { region: "D", sales: 120 },
      { region: "E", sales: "not-a-number" as unknown as number },
      { region: "F", sales: null },
    ];
    const recs = deriveTileRecommendations(BAR_SPEC, rows, {});
    assert.ok(recs.some((r) => r.kind === "filter-bottom" && r.value === "A"));
    // "E" and "F" must not appear in the recs.
    assert.ok(!recs.some((r) => (r.kind === "filter-bottom" || r.kind === "filter-top") && (r.value === "E" || r.value === "F")));
  });
  it("aggregates duplicate x values by summing y (matches sum-aggregator semantics)", () => {
    // Two rows for "A" with y = 5 each → aggregated total = 10.
    // Without the sum, the buckets would have separate values and the
    // distinct-count check would still pass, but the totals would be
    // wrong. Pin the sum semantic so a future change to e.g. count
    // breaks loudly.
    const rows: TileRecommendationRow[] = [
      { region: "A", sales: 5 },
      { region: "A", sales: 5 },
      { region: "B", sales: 100 },
      { region: "C", sales: 110 },
      { region: "D", sales: 120 },
    ];
    const recs = deriveTileRecommendations(BAR_SPEC, rows, {});
    // Median of summed totals [10, 100, 110, 120] = 105; 10 < 52.5 → fires on "A".
    const rec = recs.find((r) => r.kind === "filter-bottom");
    assert.ok(rec, "filter-bottom should fire");
    assert.equal((rec as { value: string }).value, "A");
  });
});

describe("WI5 · rec id stability + uniqueness", () => {
  it("ids encode kind + column + value so two recs on the same tile never collide", () => {
    const rows: TileRecommendationRow[] = [
      { region: "A", sales: 5 },
      { region: "B", sales: 50 },
      { region: "C", sales: 60 },
      { region: "D", sales: 200 },
    ];
    const recs = deriveTileRecommendations(BAR_SPEC, rows, {});
    const ids = recs.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length, "rec ids must be unique");
    // Specific id shapes — load-bearing for the React `key` and any
    // future analytics dedup.
    assert.ok(ids.includes("filter-bottom:region:A"));
    assert.ok(ids.includes("filter-top:region:D"));
  });
});
