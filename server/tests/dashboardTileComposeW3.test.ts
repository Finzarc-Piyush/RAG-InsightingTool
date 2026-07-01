import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DataSummary, DashboardCardDefinition } from "../shared/schema.js";
import {
  resolveAllowedAggregations,
  resolveMeasureAdditivity,
  compileCardSpecToPlan,
  runComposePlan,
} from "../lib/dashboardTileCompose.js";

/**
 * Wave W3 (data-bound cards) · the compose spine. Pins the two things that
 * make the guided builder trustworthy: (1) the aggregation GUARDRAIL — you
 * can SUM net revenue but you canNOT sum a percentage; (2) a composed
 * "NR × agg × filter" runs to the hand-computed value over real rows.
 */

const summary: DataSummary = {
  columns: [
    {
      name: "NR",
      type: "numeric",
      uniqueValues: 6,
      additivity: "additive",
      semantics: { semanticType: "measure_additive", aggregation: "sum", displayKind: "numeric", source: "auto" },
    } as any,
    {
      name: "GC%",
      type: "numeric",
      uniqueValues: 6,
      additivity: "non_additive",
      additivityKind: "ratio_percent",
      semantics: { semanticType: "measure_ratio_percent", aggregation: "avg", displayKind: "numeric", source: "auto" },
    } as any,
    { name: "Channel", type: "text", uniqueValues: 2 } as any,
    { name: "BrandCode", type: "text", uniqueValues: 3 } as any,
  ],
  numericColumns: ["NR", "GC%"],
  dateColumns: [],
  totalRows: 6,
  sampleRows: [],
} as any;

const ROWS = [
  { Channel: "GT", BrandCode: "B1", NR: 100, "GC%": 30 },
  { Channel: "GT", BrandCode: "B2", NR: 200, "GC%": 40 },
  { Channel: "GT", BrandCode: "B1", NR: 300, "GC%": 20 },
  { Channel: "MT", BrandCode: "B1", NR: 50, "GC%": 10 },
  { Channel: "MT", BrandCode: "B2", NR: 70, "GC%": 25 },
  { Channel: "MT", BrandCode: "B1", NR: 80, "GC%": 15 },
];

function cardDef(over: Partial<DashboardCardDefinition>): DashboardCardDefinition {
  return {
    cardType: "scorecard",
    measure: { kind: "column", ref: "NR", label: "Net Revenue" },
    aggregation: "sum",
    ...over,
  } as DashboardCardDefinition;
}

describe("W3 · aggregation guardrail (resolveAllowedAggregations)", () => {
  it("additive measure (NR) allows sum, defaults to sum", () => {
    const g = resolveAllowedAggregations("NR", summary);
    assert.equal(resolveMeasureAdditivity("NR", summary), "additive");
    assert.ok(g.allowed.includes("sum"));
    assert.equal(g.defaultAggregation, "sum");
  });

  it("ratio measure (GC%) FORBIDS sum, allows only avg", () => {
    const g = resolveAllowedAggregations("GC%", summary);
    assert.equal(resolveMeasureAdditivity("GC%", summary), "non_additive");
    assert.deepEqual(g.allowed, ["avg"]);
    assert.equal(g.defaultAggregation, "avg");
    assert.ok(!g.allowed.includes("sum"), "must never allow summing a percentage");
  });
});

describe("W3 · compileCardSpecToPlan", () => {
  it("'NR Sum for GT channel' → correct plan", () => {
    const r = compileCardSpecToPlan(
      cardDef({ aggregation: "sum", filters: [{ column: "Channel", op: "in", values: ["GT"] }] }),
      summary
    );
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.deepEqual(r.plan.aggregations, [{ column: "NR", operation: "sum", alias: "NR" }]);
    assert.deepEqual(r.plan.dimensionFilters, [{ column: "Channel", op: "in", values: ["GT"] }]);
  });

  it("'NR Sum for BrandCode B1 in MT' → chained filters", () => {
    const r = compileCardSpecToPlan(
      cardDef({
        aggregation: "sum",
        filters: [
          { column: "Channel", op: "in", values: ["MT"] },
          { column: "BrandCode", op: "in", values: ["B1"] },
        ],
      }),
      summary
    );
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.plan.dimensionFilters?.length, 2);
  });

  it("rejects SUM on a ratio measure with cannot_sum_non_additive + allowed", () => {
    const r = compileCardSpecToPlan(
      cardDef({ measure: { kind: "column", ref: "GC%", label: "GC%" }, aggregation: "sum" }),
      summary
    );
    assert.ok(!r.ok);
    if (r.ok) return;
    assert.equal(r.error, "cannot_sum_non_additive");
    assert.deepEqual(r.allowed, ["avg"]);
  });
});

describe("W3 · runComposePlan (in-memory execute over real rows)", () => {
  const loadRows = async () => ROWS;

  it("'NR Avg for GT channel' = mean(100,200,300) = 200", async () => {
    const c = compileCardSpecToPlan(
      cardDef({ aggregation: "avg", filters: [{ column: "Channel", op: "in", values: ["GT"] }] }),
      summary
    );
    assert.ok(c.ok);
    if (!c.ok) return;
    const res = await runComposePlan({ summary, plan: c.plan, loadRows });
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.rows.length, 1);
    assert.equal(res.rows[0][c.alias], 200);
  });

  it("'NR Sum for BrandCode B1 in MT' = 50 + 80 = 130", async () => {
    const c = compileCardSpecToPlan(
      cardDef({
        aggregation: "sum",
        filters: [
          { column: "Channel", op: "in", values: ["MT"] },
          { column: "BrandCode", op: "in", values: ["B1"] },
        ],
      }),
      summary
    );
    assert.ok(c.ok);
    if (!c.ok) return;
    const res = await runComposePlan({ summary, plan: c.plan, loadRows });
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.rows[0][c.alias], 130);
  });
});
