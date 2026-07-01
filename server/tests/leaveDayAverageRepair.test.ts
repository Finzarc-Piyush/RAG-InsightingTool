/**
 * W-LEAVE (Wave 2) · working-day-aware per-day AVERAGES. Detects the
 * `SUM(metric) / COUNT(DISTINCT dateCol)` ratio shape on a dataset with a
 * detected structural leave-day and (on consent) injects a day-of-week
 * `not_in` filter so the average divides by WORKING days. These tests pin the
 * scope guard (fires ONLY on the per-day-average shape), the injection, the
 * consent-intent detector, and the disclosure text.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  detectLeaveDayAveragePlan,
  injectLeaveDayExclusion,
  questionRequestsLeaveDayExclusion,
  questionRequestsAllCalendarDays,
  buildLeaveDayCaveat,
  buildLeaveDayOfferCta,
  shouldBuilderExcludeLeaveDays,
} from "../lib/agents/runtime/leaveDayAverageRepair.js";

function summaryWithLeaveDay(decision: "undecided" | "exclude" | "include" = "exclude"): any {
  return {
    rowCount: 0,
    columnCount: 0,
    columns: [{ name: "Visits", type: "number" }, { name: "Date", type: "date" }, { name: "Cluster", type: "string" }],
    numericColumns: ["Visits"],
    dateColumns: ["Date"],
    leaveDayPattern: {
      offWeekdays: ["Sunday"],
      dateColumn: "Date",
      basis: { offMean: 0, workingMean: 4200, ratio: 0 },
      source: decision === "exclude" ? "user" : "auto",
      decision,
    },
  };
}

/** The canonical per-day-average ratio shape (planner PD1 / buildSynthAggregationStep). */
function perDayAveragePlan(): any {
  return {
    groupBy: ["Cluster"],
    aggregations: [
      { column: "Visits", operation: "sum", alias: "total_visits" },
      { column: "Date", operation: "count_distinct", alias: "num_distinct_date" },
    ],
    computedAggregations: [
      { alias: "avg_visits_per_date", expression: "total_visits / num_distinct_date" },
    ],
  };
}

describe("detectLeaveDayAveragePlan · scope guard", () => {
  it("detects the per-day-average ratio shape over the leave-day date column", () => {
    const hit = detectLeaveDayAveragePlan(perDayAveragePlan(), summaryWithLeaveDay());
    assert.ok(hit);
    assert.strictEqual(hit!.dateColumn, "Date");
    assert.deepStrictEqual(hit!.offWeekdays, ["Sunday"]);
  });

  it("does NOT fire on a plain SUM (no per-day ratio)", () => {
    const plan = { groupBy: ["Cluster"], aggregations: [{ column: "Visits", operation: "sum", alias: "total_visits" }] };
    assert.strictEqual(detectLeaveDayAveragePlan(plan as any, summaryWithLeaveDay()), null);
  });

  it("does NOT fire on a standalone COUNT(DISTINCT date) with no ratio (a 'how many days' question)", () => {
    const plan = {
      aggregations: [{ column: "Date", operation: "count_distinct", alias: "num_distinct_date" }],
    };
    assert.strictEqual(detectLeaveDayAveragePlan(plan as any, summaryWithLeaveDay()), null);
  });

  it("does NOT fire when count_distinct is over a DIFFERENT column", () => {
    const plan = {
      aggregations: [
        { column: "Visits", operation: "sum", alias: "total_visits" },
        { column: "Cluster", operation: "count_distinct", alias: "num_clusters" },
      ],
      computedAggregations: [{ alias: "avg", expression: "total_visits / num_clusters" }],
    };
    assert.strictEqual(detectLeaveDayAveragePlan(plan as any, summaryWithLeaveDay()), null);
  });

  it("does NOT fire when the off-day is already sliced (day-of-week in groupBy)", () => {
    const plan = perDayAveragePlan();
    plan.groupBy = ["Day of week · Date"];
    assert.strictEqual(detectLeaveDayAveragePlan(plan, summaryWithLeaveDay()), null);
  });

  it("does NOT fire when there is no detected leave-day pattern", () => {
    const s = summaryWithLeaveDay();
    delete s.leaveDayPattern;
    assert.strictEqual(detectLeaveDayAveragePlan(perDayAveragePlan(), s), null);
  });

  it("does NOT double-inject when a day-of-week filter is already present", () => {
    const plan = perDayAveragePlan();
    plan.dimensionFilters = [{ column: "Day of week · Date", op: "not_in", values: ["Sunday"] }];
    assert.strictEqual(detectLeaveDayAveragePlan(plan, summaryWithLeaveDay()), null);
  });
});

describe("injectLeaveDayExclusion", () => {
  it("appends a not_in day-of-week dimensionFilter (both numerator + denominator drop via the flat WHERE)", () => {
    const out = injectLeaveDayExclusion(perDayAveragePlan(), "Date", ["Sunday"]) as any;
    const f = out.dimensionFilters.find((x: any) => x.column === "Day of week · Date");
    assert.ok(f, "expected a Day of week filter");
    assert.strictEqual(f.op, "not_in");
    assert.deepStrictEqual(f.values, ["Sunday"]);
  });

  it("is pure — does not mutate the input plan", () => {
    const plan = perDayAveragePlan();
    injectLeaveDayExclusion(plan, "Date", ["Sunday"]);
    assert.strictEqual(plan.dimensionFilters, undefined);
  });
});

describe("questionRequestsLeaveDayExclusion · consent intent", () => {
  const off = ["Sunday"];
  it("'exclude Sundays' → true", () => assert.ok(questionRequestsLeaveDayExclusion("Please exclude Sundays from the average", off)));
  it("'average per working day' → true", () => assert.ok(questionRequestsLeaveDayExclusion("show the average visits per working day", off)));
  it("'ignore the leave day' → true", () => assert.ok(questionRequestsLeaveDayExclusion("ignore the leave day when averaging", off)));
  it("'how many visits on Sunday?' → false (no exclusion verb)", () =>
    assert.ok(!questionRequestsLeaveDayExclusion("how many visits on Sunday?", off)));
  it("'exclude Mondays' → false (not the off-day)", () =>
    assert.ok(!questionRequestsLeaveDayExclusion("exclude Mondays", off)));
  it("'what is the average per day' → false (no exclusion intent)", () =>
    assert.ok(!questionRequestsLeaveDayExclusion("what is the average visits per day", off)));
  it("empty → false", () => assert.ok(!questionRequestsLeaveDayExclusion("", off)));
});

describe("questionRequestsAllCalendarDays · reverse consent", () => {
  const off = ["Sunday"];
  it("'include Sundays in the average' → true", () =>
    assert.ok(questionRequestsAllCalendarDays("include Sundays in the daily average", off)));
  it("'stop excluding Sundays' → true", () =>
    assert.ok(questionRequestsAllCalendarDays("stop excluding Sundays", off)));
  it("'average over all calendar days' → true", () =>
    assert.ok(questionRequestsAllCalendarDays("give the average over all calendar days", off)));
  it("'count visits on Sunday' → false (not an averaging preference)", () =>
    assert.ok(!questionRequestsAllCalendarDays("count visits on Sunday", off)));
  it("'exclude Sundays from the average' → false (that is the opposite intent)", () =>
    assert.ok(!questionRequestsAllCalendarDays("exclude Sundays from the average", off)));
});

describe("disclosure text", () => {
  it("applied caveat states working-days-only and offers to revert; contains no ' or '", () => {
    const c = buildLeaveDayCaveat(true, ["Sunday"], 0, 4200);
    assert.match(c, /working days only/i);
    assert.ok(!/ or /i.test(c), "caveat must not contain the conjunction 'or'");
  });
  it("offer caveat discloses Sundays are counted and asks to exclude; no ' or '", () => {
    const c = buildLeaveDayCaveat(false, ["Sunday"], 0, 4200);
    assert.match(c, /exclude Sunday/i);
    assert.ok(!/ or /i.test(c));
  });
  it("offer CTA has no ' or '", () => {
    assert.ok(!/ or /i.test(buildLeaveDayOfferCta(["Sunday"])));
  });
});

describe("shouldBuilderExcludeLeaveDays · Wave 3 consistency gate", () => {
  const lp = { offWeekdays: ["Sunday"], decision: "exclude" };
  it("mean + consented + no explicit exclusion → true", () =>
    assert.ok(shouldBuilderExcludeLeaveDays("mean", false, lp)));
  it("sum → false (a total over all days is correct)", () =>
    assert.ok(!shouldBuilderExcludeLeaveDays("sum", false, lp)));
  it("user already set an explicit exclusion → false (respect it)", () =>
    assert.ok(!shouldBuilderExcludeLeaveDays("mean", true, lp)));
  it("decision undecided → false (don't pre-apply without consent)", () =>
    assert.ok(!shouldBuilderExcludeLeaveDays("mean", false, { offWeekdays: ["Sunday"], decision: "undecided" })));
  it("decision include → false", () =>
    assert.ok(!shouldBuilderExcludeLeaveDays("mean", false, { offWeekdays: ["Sunday"], decision: "include" })));
  it("no pattern → false", () =>
    assert.ok(!shouldBuilderExcludeLeaveDays("mean", false, undefined)));
});
