import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  patchExecuteQueryPlanTrendGrain,
  patchExecuteQueryPlanTrendCoarserGrain,
  distinctBucketsForGrain,
} from "../lib/queryPlanTemporalPatch.js";
import type { PlanStep } from "../lib/agents/runtime/types.js";

/**
 * Wave T4 · the trend-grain patch now also REFINES a coarse temporal-facet
 * group-by (e.g. "Month · Date") down to the span-appropriate finer facet
 * ("Day · Date") when the chosen grain would collapse to a single bucket — the
 * Marico single-month-daily failure. It must NOT over-refine genuinely coarse
 * datasets, must respect explicit user grain wording, and must leave non-temporal
 * group-by columns untouched.
 */

const MARICO_RANGE = {
  spanDays: 29,
  distinctDayCount: 30,
  minIso: "2026-04-01",
  maxIso: "2026-04-30",
};

function step(groupBy: string[], extra: Record<string, unknown> = {}): PlanStep {
  return {
    id: "s1",
    tool: "execute_query_plan",
    args: {
      plan: {
        groupBy,
        aggregations: [{ column: "Compliance Visit", operation: "sum", alias: "t" }],
        ...extra,
      },
    },
  };
}
const planOf = (s: PlanStep) =>
  s.args.plan as { groupBy: string[]; dateAggregationPeriod?: string };

describe("Wave T4 · distinctBucketsForGrain", () => {
  it("date grain → distinctDayCount", () => {
    assert.equal(distinctBucketsForGrain(MARICO_RANGE, "date"), 30);
  });
  it("month grain over a single month → 1 (collapses)", () => {
    assert.equal(distinctBucketsForGrain(MARICO_RANGE, "month"), 1);
  });
  it("month grain over a 3-month span → 3", () => {
    assert.equal(
      distinctBucketsForGrain(
        { spanDays: 89, distinctDayCount: 90, minIso: "2026-04-01", maxIso: "2026-06-30" },
        "month",
      ),
      3,
    );
  });
  it("missing isos → 1 (safe single-bucket answer)", () => {
    assert.equal(distinctBucketsForGrain({ spanDays: 29, distinctDayCount: 30 }, "month"), 1);
  });
});

describe("Wave T4 · facet-grain refinement", () => {
  it("refines a collapsing Month facet to Day, keeping other dimensions (Marico case)", () => {
    const s = step(["Month · Date", "Cluster Name"]);
    patchExecuteQueryPlanTrendGrain(
      s,
      "how has compliance visit trended over time?",
      ["Date"],
      new Map([["Date", MARICO_RANGE]]),
    );
    const p = planOf(s);
    assert.deepEqual(p.groupBy, ["Day · Date", "Cluster Name"]);
    assert.equal(p.dateAggregationPeriod, undefined);
  });

  it("refines a lone collapsing Month facet to Day", () => {
    const s = step(["Month · Date"]);
    patchExecuteQueryPlanTrendGrain(
      s,
      "compliance visit trend over time",
      ["Date"],
      new Map([["Date", MARICO_RANGE]]),
    );
    assert.deepEqual(planOf(s).groupBy, ["Day · Date"]);
  });

  it("does NOT over-refine a multi-year Month facet (still a valid trend)", () => {
    const s = step(["Month · Date"]);
    patchExecuteQueryPlanTrendGrain(
      s,
      "sales trend over time",
      ["Date"],
      new Map([
        ["Date", { spanDays: 365 * 3, distinctDayCount: 1000, minIso: "2023-01-01", maxIso: "2025-12-31" }],
      ]),
    );
    assert.deepEqual(planOf(s).groupBy, ["Month · Date"]);
  });

  it("does NOT refine a Month facet that already yields 2 buckets", () => {
    const s = step(["Month · Date"]);
    patchExecuteQueryPlanTrendGrain(
      s,
      "sales trend over time",
      ["Date"],
      new Map([
        ["Date", { spanDays: 60, distinctDayCount: 61, minIso: "2026-04-01", maxIso: "2026-05-31" }],
      ]),
    );
    assert.deepEqual(planOf(s).groupBy, ["Month · Date"]);
  });

  it("respects explicit grain wording (monthly) — no refinement", () => {
    const s = step(["Month · Date"]);
    patchExecuteQueryPlanTrendGrain(
      s,
      "show the monthly trend over time",
      ["Date"],
      new Map([["Date", MARICO_RANGE]]),
    );
    assert.deepEqual(planOf(s).groupBy, ["Month · Date"]);
  });

  it("respects explicit `daily` short-circuit — no change", () => {
    const s = step(["Month · Date"]);
    patchExecuteQueryPlanTrendGrain(
      s,
      "show daily compliance trend over time",
      ["Date"],
      new Map([["Date", MARICO_RANGE]]),
    );
    assert.deepEqual(planOf(s).groupBy, ["Month · Date"]);
  });

  it("leaves the facet untouched when no span metadata exists for its source", () => {
    const s = step(["Month · Date"]);
    patchExecuteQueryPlanTrendGrain(
      s,
      "compliance visit trend over time",
      ["Date"],
      new Map(), // no range for "Date"
    );
    assert.deepEqual(planOf(s).groupBy, ["Month · Date"]);
  });
});

describe("Wave T4 · raw-date behavior preserved (T2 regression via alias)", () => {
  it("alias still binds the span grain on a lone raw-date group-by", () => {
    const s = step(["Date"]);
    patchExecuteQueryPlanTrendCoarserGrain(
      s,
      "compliance visit trend over time",
      ["Date"],
      new Map([["Date", MARICO_RANGE]]),
    );
    assert.equal(planOf(s).dateAggregationPeriod, "day");
  });
});
