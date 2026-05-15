/**
 * Wave PD2 · The injector's "already-decomposed" check is now semantic
 * (not literal). When the planner emits a groupBy that contains the
 * source date column OR any temporal facet over that source, the
 * decomposition is semantically equivalent to bucketing by perDimension —
 * so PD1 must NOT rewrite the plan (the redundant inner subquery would
 * reference a possibly-unmaterialized facet column and DuckDB would throw).
 *
 * Closes the Marico failure: question "average compliance visits per day
 * per cluster" → planner emits groupBy [Cluster Name, Date] → PD1 used
 * to inject perDimension="Day · Date" → SQL referenced unmaterialized
 * "Day · Date" → "I couldn't complete this analysis" fallback.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  injectPerDimensionForRateIntent,
  semanticDecompositionAliases,
  type PerXIntent,
} from "../lib/agents/runtime/planArgRepairs.js";
import type { PlanStep } from "../lib/agents/runtime/types.js";

const TEMPORAL_DAY_INTENT: PerXIntent = {
  outerOp: "mean",
  perDimension: "Day · Date",
  perDimensionKind: "temporal",
  rawCapture: "day",
  sourceColumn: "Date",
};

const TEMPORAL_DAY_INTENT_OTHER_SOURCE: PerXIntent = {
  ...TEMPORAL_DAY_INTENT,
  perDimension: "Day · OrderDate",
  sourceColumn: "OrderDate",
};

const NON_TEMPORAL_REGION_INTENT: PerXIntent = {
  outerOp: "sum",
  perDimension: "Region",
  perDimensionKind: "dimension",
  rawCapture: "region",
};

function planStep(
  groupBy: string[],
  aggregations: Array<Record<string, unknown>>
): PlanStep {
  return {
    id: "s1",
    tool: "execute_query_plan",
    args: {
      plan: {
        groupBy,
        aggregations,
      },
    },
  } as PlanStep;
}

describe("Wave PD2 · semantic already-decomposed skip", () => {
  it("(a) Marico failure scenario — groupBy includes RAW date column → skip semantically", () => {
    const step = planStep(
      ["Cluster Name", "Date"],
      [{ column: "Compliance Visit", operation: "mean" }]
    );
    const result = injectPerDimensionForRateIntent(step, TEMPORAL_DAY_INTENT);
    assert.equal(result.rewrittenAggColumns.length, 0);
    assert.equal(result.skipReason, "already_decomposed_semantically");
    // Plan unchanged
    const plan = step.args.plan as { aggregations: Array<Record<string, unknown>> };
    assert.equal(plan.aggregations[0]!.perDimension, undefined);
  });

  it("(b) groupBy includes a DIFFERENT temporal facet (Week · Date) → skip semantically", () => {
    const step = planStep(
      ["Cluster Name", "Week · Date"],
      [{ column: "Compliance Visit", operation: "mean" }]
    );
    const result = injectPerDimensionForRateIntent(step, TEMPORAL_DAY_INTENT);
    assert.equal(result.skipReason, "already_decomposed_semantically");
  });

  it("(c) groupBy includes the LITERAL perDimension (Day · Date) → skip (PD1 invariant)", () => {
    const step = planStep(
      ["Cluster Name", "Day · Date"],
      [{ column: "Compliance Visit", operation: "mean" }]
    );
    const result = injectPerDimensionForRateIntent(step, TEMPORAL_DAY_INTENT);
    assert.equal(result.skipReason, "already_in_group_by");
  });

  it("(d) groupBy has no temporal column → REWRITE (PD1 still fires)", () => {
    const step = planStep(
      ["Cluster Name"],
      [{ column: "Compliance Visit", operation: "mean" }]
    );
    const result = injectPerDimensionForRateIntent(step, TEMPORAL_DAY_INTENT);
    assert.deepEqual(result.rewrittenAggColumns, ["Compliance Visit"]);
    const plan = step.args.plan as { aggregations: Array<Record<string, unknown>> };
    assert.equal(plan.aggregations[0]!.perDimension, "Day · Date");
    assert.equal(plan.aggregations[0]!.innerOperation, "sum");
  });

  it("(e) non-temporal intent — groupBy includes the literal perDimension → skip literal match", () => {
    const step = planStep(
      ["Cluster Name", "Region"],
      [{ column: "Sales", operation: "sum" }]
    );
    const result = injectPerDimensionForRateIntent(
      step,
      NON_TEMPORAL_REGION_INTENT
    );
    assert.equal(result.skipReason, "already_in_group_by");
  });

  it("(f) non-temporal intent — groupBy has an UNRELATED dimension → REWRITE", () => {
    const step = planStep(
      ["Cluster Name", "Cluster Code"],
      [{ column: "Sales", operation: "sum" }]
    );
    const result = injectPerDimensionForRateIntent(
      step,
      NON_TEMPORAL_REGION_INTENT
    );
    assert.deepEqual(result.rewrittenAggColumns, ["Sales"]);
    const plan = step.args.plan as { aggregations: Array<Record<string, unknown>> };
    assert.equal(plan.aggregations[0]!.perDimension, "Region");
  });

  it("(g) temporal intent with DIFFERENT source date column → REWRITE", () => {
    // Intent's sourceColumn is "Date"; groupBy includes "Day · OrderDate"
    // which is over a DIFFERENT date axis. PD1 should still fire because
    // the planner hasn't decomposed by the intent's axis.
    const step = planStep(
      ["Cluster Name", "Day · OrderDate"],
      [{ column: "Compliance Visit", operation: "mean" }]
    );
    const result = injectPerDimensionForRateIntent(step, TEMPORAL_DAY_INTENT);
    assert.deepEqual(result.rewrittenAggColumns, ["Compliance Visit"]);
  });

  it("(h) idempotent — already-nested aggregations stay nested (PD1 invariant)", () => {
    const step = planStep(
      ["Cluster Name"],
      [
        {
          column: "Compliance Visit",
          operation: "mean",
          perDimension: "Day · Date",
          innerOperation: "sum",
        },
      ]
    );
    const result = injectPerDimensionForRateIntent(step, TEMPORAL_DAY_INTENT);
    assert.equal(result.skipReason, "already_nested");
  });
});

describe("Wave PD2 · semanticDecompositionAliases helper", () => {
  it("temporal intent yields the source column + all 6 facets", () => {
    const aliases = semanticDecompositionAliases(TEMPORAL_DAY_INTENT);
    assert.ok(aliases.has("Day · Date"));
    assert.ok(aliases.has("Date"));
    assert.ok(aliases.has("Week · Date"));
    assert.ok(aliases.has("Month · Date"));
    assert.ok(aliases.has("Quarter · Date"));
    assert.ok(aliases.has("Half-year · Date"));
    assert.ok(aliases.has("Year · Date"));
  });

  it("non-temporal intent yields just the perDimension", () => {
    const aliases = semanticDecompositionAliases(NON_TEMPORAL_REGION_INTENT);
    assert.equal(aliases.size, 1);
    assert.ok(aliases.has("Region"));
  });

  it("temporal intent without sourceColumn falls back to perDimension-only", () => {
    const aliases = semanticDecompositionAliases({
      ...TEMPORAL_DAY_INTENT,
      sourceColumn: undefined,
    });
    assert.equal(aliases.size, 1);
    assert.ok(aliases.has("Day · Date"));
  });
});
