import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildQuickAnswerFollowUps } from "../lib/agents/runtime/quickAnswerFollowUps.js";
import type { DataSummary } from "../shared/schema.js";
import type { QueryPlanBody } from "../lib/queryPlanExecutor.js";

/**
 * Wave QL1 · Deterministic follow-up generator. Pins the 3-template contract
 * for ranking, aggregate, and filter-projection shapes. Trend templates must
 * be gated on `dataSummary.dateColumns` being non-empty (no fabricated time
 * questions on a dataset without a time axis).
 */

const dimColumn = (
  name: string,
  topValuesCount: number
): DataSummary["columns"][number] => ({
  name,
  type: "string",
  sampleValues: [],
  topValues: Array.from({ length: topValuesCount }, (_, i) => ({
    value: `${name}-${i}`,
    count: 100 - i,
  })),
});

const baseSummary: DataSummary = {
  rowCount: 1000,
  columnCount: 5,
  numericColumns: ["Sales", "Units"],
  dateColumns: ["OrderDate"],
  columns: [
    dimColumn("State", 6),
    dimColumn("Category", 4),
    dimColumn("Product", 200),
    { name: "Sales", type: "number", sampleValues: [] },
    { name: "Units", type: "number", sampleValues: [] },
    { name: "OrderDate", type: "date", sampleValues: [] },
  ],
};

describe("Wave QL1 · buildQuickAnswerFollowUps", () => {
  it("ranking shape with dateColumns emits 3 follow-ups including a trend question", () => {
    const plan: QueryPlanBody = {
      groupBy: ["State"],
      aggregations: [{ column: "Sales", operation: "sum", alias: "Total Sales" }],
      sort: [{ column: "Total Sales", direction: "desc" }],
      limit: 10,
    };
    const rows = [
      { State: "California", "Total Sales": 4200000 },
      { State: "Texas", "Total Sales": 3800000 },
    ];
    const out = buildQuickAnswerFollowUps({
      plan,
      rows,
      dataSummary: baseSummary,
    });
    assert.strictEqual(out.length, 3);
    assert.ok(
      out.some((q) => /trend/i.test(q) && /California/i.test(q)),
      `expected trend follow-up referencing top value California, got: ${JSON.stringify(out)}`
    );
    assert.ok(
      out.some((q) => /gap between top and bottom State/i.test(q)),
      `expected gap follow-up, got: ${JSON.stringify(out)}`
    );
    assert.ok(
      out.some((q) => /Category/i.test(q)),
      `expected an alternate-dimension follow-up using Category, got: ${JSON.stringify(out)}`
    );
  });

  it("ranking shape WITHOUT dateColumns gates out the trend template", () => {
    const summaryNoDate: DataSummary = {
      ...baseSummary,
      dateColumns: [],
      columns: baseSummary.columns.filter((c) => c.name !== "OrderDate"),
      columnCount: 5,
    };
    const plan: QueryPlanBody = {
      groupBy: ["State"],
      aggregations: [{ column: "Sales", operation: "sum", alias: "Sales" }],
      sort: [{ column: "Sales", direction: "desc" }],
      limit: 10,
    };
    const out = buildQuickAnswerFollowUps({
      plan,
      rows: [{ State: "CA", Sales: 100 }],
      dataSummary: summaryNoDate,
    });
    assert.strictEqual(out.length, 3);
    assert.ok(
      !out.some((q) => /trend/i.test(q) || /over time/i.test(q)),
      `expected NO trend/over-time follow-up on dateless dataset, got: ${JSON.stringify(out)}`
    );
  });

  it("aggregate shape (no groupBy) emits distribution + top-N + trend (when dated)", () => {
    const plan: QueryPlanBody = {
      aggregations: [{ column: "Sales", operation: "sum", alias: "Total Sales" }],
    };
    const rows = [{ "Total Sales": 12_345_678 }];
    const out = buildQuickAnswerFollowUps({
      plan,
      rows,
      dataSummary: baseSummary,
    });
    assert.strictEqual(out.length, 3);
    assert.ok(
      out.some((q) => /distributed/i.test(q)),
      `expected a distribution follow-up, got: ${JSON.stringify(out)}`
    );
    assert.ok(
      out.some((q) => /over time/i.test(q)),
      `expected a time-trend follow-up, got: ${JSON.stringify(out)}`
    );
    assert.ok(
      out.some((q) => /top 10/i.test(q)),
      `expected a top-N follow-up, got: ${JSON.stringify(out)}`
    );
  });

  it("drops duplicates from filler templates", () => {
    // Tiny summary so the filler runs and would otherwise produce repeats.
    const summary: DataSummary = {
      rowCount: 10,
      columnCount: 2,
      numericColumns: ["X"],
      dateColumns: [],
      columns: [
        { name: "X", type: "number", sampleValues: [] },
        dimColumn("Group", 3),
      ],
    };
    const plan: QueryPlanBody = {
      groupBy: ["Group"],
      aggregations: [{ column: "X", operation: "sum", alias: "X" }],
      sort: [{ column: "X", direction: "desc" }],
      limit: 5,
    };
    const out = buildQuickAnswerFollowUps({
      plan,
      rows: [{ Group: "A", X: 10 }],
      dataSummary: summary,
    });
    const lowered = out.map((q) => q.toLowerCase());
    assert.strictEqual(
      new Set(lowered).size,
      lowered.length,
      "expected no duplicate follow-ups"
    );
  });

  it("falls back to suggestedFollowUpsFromSummary when templates can't produce 3 (single-dim dataset)", () => {
    const summary: DataSummary = {
      rowCount: 10,
      columnCount: 2,
      numericColumns: ["Sales"],
      dateColumns: [],
      columns: [
        dimColumn("Brand", 3),
        { name: "Sales", type: "number", sampleValues: [] },
      ],
    };
    const plan: QueryPlanBody = {
      groupBy: ["Brand"],
      aggregations: [{ column: "Sales", operation: "sum", alias: "Sales" }],
      sort: [{ column: "Sales", direction: "desc" }],
      limit: 3,
    };
    const out = buildQuickAnswerFollowUps({
      plan,
      rows: [{ Brand: "A", Sales: 100 }],
      dataSummary: summary,
    });
    assert.strictEqual(out.length, 3);
    // The "alternate dimension" template should be absent since the only
    // dimension is Brand (the groupBy column). Filler templates fire instead.
    assert.ok(
      !out.some((q) => /Which Brand contributes/i.test(q)),
      `expected NO alternate-dim follow-up when only one dim exists`
    );
  });
});
