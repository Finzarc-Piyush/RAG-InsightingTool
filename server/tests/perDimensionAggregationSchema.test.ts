/**
 * Wave PD1 · `aggregationEntrySchema` extension — `perDimension` and
 * `innerOperation` fields, plus `.superRefine` rejections for incompatible
 * combinations. The schema is the contract between planner LLM output and
 * the executor; this test pins what the executor will and won't accept.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeQueryPlanArgsSchema } from "../lib/queryPlanExecutor.js";

function plan(aggregations: unknown[]): unknown {
  return {
    plan: {
      groupBy: ["Cluster Name"],
      aggregations,
    },
  };
}

describe("Wave PD1 · aggregationEntrySchema with perDimension + innerOperation", () => {
  it("accepts perDimension + innerOperation=sum (the canonical mean-per-day shape)", () => {
    const parsed = executeQueryPlanArgsSchema.safeParse(
      plan([
        {
          column: "Compliance Visit",
          operation: "mean",
          perDimension: "Day · TSOE-Date Combo",
          innerOperation: "sum",
        },
      ])
    );
    assert.equal(parsed.success, true);
  });

  it("accepts perDimension without explicit innerOperation (executor defaults to sum)", () => {
    const parsed = executeQueryPlanArgsSchema.safeParse(
      plan([
        {
          column: "Compliance Visit",
          operation: "mean",
          perDimension: "Day · TSOE-Date Combo",
        },
      ])
    );
    assert.equal(parsed.success, true);
  });

  it("rejects perDimension + operation:percent_change (incompatible)", () => {
    const parsed = executeQueryPlanArgsSchema.safeParse(
      plan([
        {
          column: "Sales",
          operation: "percent_change",
          perDimension: "Day · OrderDate",
        },
      ])
    );
    assert.equal(parsed.success, false);
  });

  it("rejects perDimension + predicate (predicates filter raw rows, use plan.dimensionFilters)", () => {
    const parsed = executeQueryPlanArgsSchema.safeParse(
      plan([
        {
          column: "Sales",
          operation: "mean",
          perDimension: "Day · OrderDate",
          predicate: [
            { column: "Region", op: "in", values: ["West"] },
          ],
        },
      ])
    );
    assert.equal(parsed.success, false);
  });

  it("rejects innerOperation:countIf / sumIf (conditional inner ops disallowed)", () => {
    for (const innerOp of ["countIf", "sumIf"]) {
      const parsed = executeQueryPlanArgsSchema.safeParse(
        plan([
          {
            column: "Sales",
            operation: "mean",
            perDimension: "Day · OrderDate",
            innerOperation: innerOp,
          },
        ])
      );
      assert.equal(
        parsed.success,
        false,
        `innerOperation=${innerOp} should be rejected`
      );
    }
  });

  it("rejects innerOperation:percent_change (nested percent change ill-defined)", () => {
    const parsed = executeQueryPlanArgsSchema.safeParse(
      plan([
        {
          column: "Sales",
          operation: "mean",
          perDimension: "Day · OrderDate",
          innerOperation: "percent_change",
        },
      ])
    );
    assert.equal(parsed.success, false);
  });

  it("still accepts the pre-PD1 single-pass aggregation shape (regression — no perDimension)", () => {
    const parsed = executeQueryPlanArgsSchema.safeParse(
      plan([{ column: "Sales", operation: "sum" }])
    );
    assert.equal(parsed.success, true);
  });
});
