import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { breakdownRankingArgsSchema } from "../lib/agents/runtime/tools/breakdownRankingTool.js";

/**
 * Wave W3 · Pins the composite-ranking surface of `run_breakdown_ranking`.
 *
 * Pre-W3 the tool ranked by a single metricColumn + aggregation. W3 adds
 * an optional `rankBy: {metrics, expression}` field that lets the planner
 * express weighted multi-metric ranking ("rank brands by 0.6 × growth +
 * 0.4 × share"). Expression uses the same restricted arithmetic
 * mini-language as Wave QL7's `computedAggregations` (validated via
 * `parseComputedAggregationExpression`).
 *
 * Behavioural pinning is done at the schema level — the tool body
 * branches on `rankBy` and the ranking math is exercised by the
 * adjacent regression suite (`breakdownRankingTopNUnlimited`) which
 * still passes against the simple path.
 */

describe("Wave W3 · breakdownRankingArgsSchema · simple path still works", () => {
  it("accepts metricColumn + aggregation (backwards compat)", () => {
    const args = breakdownRankingArgsSchema.parse({
      metricColumn: "Sales",
      breakdownColumn: "Region",
      aggregation: "sum",
      topN: 10,
    });
    assert.equal(args.metricColumn, "Sales");
    assert.equal(args.breakdownColumn, "Region");
    assert.equal(args.aggregation, "sum");
    assert.equal(args.topN, 10);
    assert.equal(args.rankBy, undefined);
  });

  it("rejects when NEITHER metricColumn NOR rankBy is supplied", () => {
    assert.throws(() =>
      breakdownRankingArgsSchema.parse({
        breakdownColumn: "Region",
      })
    );
  });
});

describe("Wave W3 · composite path · happy paths", () => {
  it("accepts rankBy with 2 metrics + valid weighted expression", () => {
    const args = breakdownRankingArgsSchema.parse({
      breakdownColumn: "Brand",
      topN: 10,
      rankBy: {
        metrics: [
          { column: "Sales", operation: "sum", alias: "share_pct" },
          { column: "GrowthRate", operation: "mean", alias: "growth_pct" },
        ],
        expression: "(growth_pct * 0.6) + (share_pct * 0.4)",
      },
    });
    assert.equal(args.rankBy?.metrics.length, 2);
    assert.equal(args.rankBy?.expression.includes("growth_pct"), true);
  });

  it("accepts rankBy with a single metric (degenerate weighted sum)", () => {
    const args = breakdownRankingArgsSchema.parse({
      breakdownColumn: "Brand",
      rankBy: {
        metrics: [{ column: "Sales", operation: "sum", alias: "x" }],
        expression: "x * 1.0",
      },
    });
    assert.equal(args.rankBy?.metrics.length, 1);
  });

  it("accepts ratio expressions for composite ranking", () => {
    const args = breakdownRankingArgsSchema.parse({
      breakdownColumn: "Product",
      rankBy: {
        metrics: [
          { column: "Revenue", operation: "sum", alias: "rev" },
          { column: "Cost", operation: "sum", alias: "cost" },
        ],
        expression: "(rev - cost) / rev",
      },
    });
    assert.equal(args.rankBy?.expression, "(rev - cost) / rev");
  });

  it("accepts count-based composite (no column required for count)", () => {
    const args = breakdownRankingArgsSchema.parse({
      breakdownColumn: "Brand",
      rankBy: {
        metrics: [
          { column: "Order", operation: "count", alias: "order_count" },
          { column: "Revenue", operation: "sum", alias: "rev" },
        ],
        expression: "rev / order_count",
      },
    });
    assert.equal(args.rankBy?.metrics[0].operation, "count");
  });
});

describe("Wave W3 · composite path · rejections", () => {
  it("rejects expression referencing an alias not in metrics[]", () => {
    assert.throws(() =>
      breakdownRankingArgsSchema.parse({
        breakdownColumn: "Brand",
        rankBy: {
          metrics: [{ column: "Sales", operation: "sum", alias: "share" }],
          expression: "share + growth", // 'growth' not declared
        },
      })
    );
  });

  it("rejects expression with disallowed characters (SQL injection guard)", () => {
    assert.throws(() =>
      breakdownRankingArgsSchema.parse({
        breakdownColumn: "Brand",
        rankBy: {
          metrics: [{ column: "Sales", operation: "sum", alias: "x" }],
          expression: "x; DROP TABLE",
        },
      })
    );
  });

  it("rejects expression using reserved SQL keywords", () => {
    assert.throws(() =>
      breakdownRankingArgsSchema.parse({
        breakdownColumn: "Brand",
        rankBy: {
          metrics: [{ column: "Sales", operation: "sum", alias: "x" }],
          expression: "x + SELECT", // reserved
        },
      })
    );
  });

  it("rejects more than 4 metrics (the composite cap)", () => {
    assert.throws(() =>
      breakdownRankingArgsSchema.parse({
        breakdownColumn: "Brand",
        rankBy: {
          metrics: [
            { column: "A", operation: "sum", alias: "a" },
            { column: "B", operation: "sum", alias: "b" },
            { column: "C", operation: "sum", alias: "c" },
            { column: "D", operation: "sum", alias: "d" },
            { column: "E", operation: "sum", alias: "e" },
          ],
          expression: "a + b + c + d + e",
        },
      })
    );
  });

  it("rejects empty metrics array", () => {
    assert.throws(() =>
      breakdownRankingArgsSchema.parse({
        breakdownColumn: "Brand",
        rankBy: {
          metrics: [],
          expression: "1",
        },
      })
    );
  });

  it("rejects expression longer than 240 chars", () => {
    const longExpr = "x".repeat(241);
    assert.throws(() =>
      breakdownRankingArgsSchema.parse({
        breakdownColumn: "Brand",
        rankBy: {
          metrics: [{ column: "Sales", operation: "sum", alias: "x" }],
          expression: longExpr,
        },
      })
    );
  });
});
