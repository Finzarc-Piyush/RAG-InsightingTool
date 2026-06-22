import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveLeaderboardPlan,
  buildQuickAnswerChart,
  aggregationOutputAlias,
  QUICK_ANSWER_CHART_ROW_CAP,
} from "../lib/agents/runtime/quickAnswerChart.js";
import type { QueryPlanBody } from "../lib/queryPlanExecutor.js";
import type { DataSummary } from "../shared/schema.js";

function makeSummary(overrides: Partial<DataSummary> = {}): DataSummary {
  const base: DataSummary = {
    rowCount: 100,
    columns: [],
    columnCount: 0,
    numericColumns: [],
    dateColumns: [],
    categoricalColumns: [],
    sampleRows: [],
  };
  return { ...base, ...overrides } as DataSummary;
}

// ── aggregationOutputAlias (mirrors the executor's outputAliasForAgg) ─────────

test("aggregationOutputAlias: plain op → `${col}_${op}`", () => {
  assert.equal(
    aggregationOutputAlias({ column: "Sales", operation: "sum" }),
    "Sales_sum"
  );
});

test("aggregationOutputAlias: explicit alias wins", () => {
  assert.equal(
    aggregationOutputAlias({ column: "Sales", operation: "sum", alias: "Total Sales" }),
    "Total Sales"
  );
});

test("aggregationOutputAlias: perDimension suffix is identifier-safe", () => {
  assert.equal(
    aggregationOutputAlias({
      column: "Visits",
      operation: "mean",
      perDimension: "Day · Date",
    }),
    "Visits_mean_per_Day_Date"
  );
});

// ── deriveLeaderboardPlan ────────────────────────────────────────────────────

test("deriveLeaderboardPlan: strips limit, pins alias, sorts desc by the measure", () => {
  const plan: QueryPlanBody = {
    groupBy: ["TSOE"],
    aggregations: [{ column: "Compliance Visit", operation: "sum" }],
    limit: 1,
  };
  const out = deriveLeaderboardPlan(plan);
  assert.notEqual(out, null);
  assert.equal(out!.measureAlias, "Compliance Visit_sum");
  assert.equal(out!.plan.limit, QUICK_ANSWER_CHART_ROW_CAP);
  assert.deepEqual(out!.plan.sort, [
    { column: "Compliance Visit_sum", direction: "desc" },
  ]);
  // The alias is pinned on the aggregation so the output column name is fixed.
  assert.equal(out!.plan.aggregations![0]!.alias, "Compliance Visit_sum");
  // Pure: the original plan is not mutated.
  assert.equal(plan.limit, 1);
  assert.equal(plan.aggregations![0]!.alias, undefined);
});

test("deriveLeaderboardPlan: preserves an explicit aggregation alias", () => {
  const plan: QueryPlanBody = {
    groupBy: ["Region"],
    aggregations: [{ column: "Sales", operation: "sum", alias: "Total Sales" }],
    limit: 5,
  };
  const out = deriveLeaderboardPlan(plan);
  assert.equal(out!.measureAlias, "Total Sales");
  assert.deepEqual(out!.plan.sort, [{ column: "Total Sales", direction: "desc" }]);
});

test("deriveLeaderboardPlan: inherits the original sort direction (lowest/bottom asks)", () => {
  const plan: QueryPlanBody = {
    groupBy: ["Region"],
    aggregations: [{ column: "Sales", operation: "sum" }],
    sort: [{ column: "Sales_sum", direction: "asc" }],
    limit: 1,
  };
  const out = deriveLeaderboardPlan(plan);
  assert.equal(out!.plan.sort![0]!.direction, "asc");
});

test("deriveLeaderboardPlan: computed-only plan sorts by the final computed alias", () => {
  const plan: QueryPlanBody = {
    groupBy: ["Region"],
    computedAggregations: [{ alias: "adherence_rate", expression: "matching / total" }],
  };
  const out = deriveLeaderboardPlan(plan);
  assert.equal(out!.measureAlias, "adherence_rate");
  assert.deepEqual(out!.plan.sort, [
    { column: "adherence_rate", direction: "desc" },
  ]);
});

test("deriveLeaderboardPlan: null when no groupBy (pure scalar)", () => {
  const plan: QueryPlanBody = {
    aggregations: [{ column: "Sales", operation: "sum" }],
  };
  assert.equal(deriveLeaderboardPlan(plan), null);
});

test("deriveLeaderboardPlan: null when groupBy but no measure", () => {
  const plan: QueryPlanBody = { groupBy: ["Region"] };
  assert.equal(deriveLeaderboardPlan(plan), null);
});

// ── buildQuickAnswerChart ────────────────────────────────────────────────────

const SALES_PLAN: QueryPlanBody = {
  groupBy: ["Category"],
  aggregations: [{ column: "Sales", operation: "sum" }],
};

test("buildQuickAnswerChart: rows ≥ 2 → bar chart from the answer rows", () => {
  const out = buildQuickAnswerChart({
    rows: [
      { Category: "Technology", Sales_sum: 827_455 },
      { Category: "Furniture", Sales_sum: 728_658 },
      { Category: "Office Supplies", Sales_sum: 705_415 },
    ],
    leaderboardRows: null,
    plan: SALES_PLAN,
    summary: makeSummary({ numericColumns: ["Sales_sum"] }),
    question: "top categories by sales",
  });
  assert.notEqual(out, null);
  assert.equal(out!.type, "bar");
  assert.equal(out!.x, "Category");
  assert.equal(out!.y, "Sales_sum");
});

test("buildQuickAnswerChart: single-winner rows + leaderboard → chart from leaderboard", () => {
  const out = buildQuickAnswerChart({
    rows: [{ Region: "East", Sales_sum: 999 }],
    leaderboardRows: [
      { Region: "East", Sales_sum: 999 },
      { Region: "West", Sales_sum: 800 },
      { Region: "South", Sales_sum: 700 },
    ],
    plan: { groupBy: ["Region"], aggregations: [{ column: "Sales", operation: "sum" }] },
    summary: makeSummary({ numericColumns: ["Sales_sum"] }),
    question: "who is the top performing region?",
  });
  assert.notEqual(out, null);
  assert.equal(out!.x, "Region");
  assert.equal(out!.y, "Sales_sum");
});

test("buildQuickAnswerChart: null for a pure scalar plan (no groupBy)", () => {
  const out = buildQuickAnswerChart({
    rows: [{ total_sales: 12_345 }],
    leaderboardRows: null,
    plan: { aggregations: [{ column: "Sales", operation: "sum" }] },
    summary: makeSummary({ numericColumns: ["total_sales"] }),
    question: "what is total sales?",
  });
  assert.equal(out, null);
});

test("buildQuickAnswerChart: null for single-winner rows with no leaderboard", () => {
  const out = buildQuickAnswerChart({
    rows: [{ Region: "East", Sales_sum: 999 }],
    leaderboardRows: null,
    plan: { groupBy: ["Region"], aggregations: [{ column: "Sales", operation: "sum" }] },
    summary: makeSummary({ numericColumns: ["Sales_sum"] }),
    question: "who is the top performing region?",
  });
  assert.equal(out, null);
});

test("buildQuickAnswerChart: high-cardinality leaderboard is capped → chart still builds", () => {
  // 100 distinct entities would blow chartFromTable's 60-cardinality cap; the
  // measure-ordered cap to QUICK_ANSWER_CHART_ROW_CAP keeps the top-N readable.
  const leaderboardRows = Array.from({ length: 100 }, (_, i) => ({
    Store: `store_${i}`,
    Visits_sum: i,
  }));
  const out = buildQuickAnswerChart({
    rows: [{ Store: "store_99", Visits_sum: 99 }],
    leaderboardRows,
    plan: { groupBy: ["Store"], aggregations: [{ column: "Visits", operation: "sum" }] },
    summary: makeSummary({ numericColumns: ["Visits_sum"] }),
    question: "who is the top performing store?",
  });
  assert.notEqual(out, null);
  assert.equal(out!.x, "Store");
  assert.ok(
    QUICK_ANSWER_CHART_ROW_CAP <= 60,
    "cap must stay under chartFromTable's cardinality ceiling"
  );
});
