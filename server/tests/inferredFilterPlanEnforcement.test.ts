import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ensureInferredFiltersOnStep,
  checkMissingInferredFilters,
} from "../lib/agents/runtime/planArgRepairs.js";
import { checkInferredFilterFidelity } from "../lib/agents/runtime/verifierHelpers.js";
import type { PlanStep, AgentExecutionContext } from "../lib/agents/runtime/types.js";
import type { InferredFilter } from "../lib/agents/utils/inferFiltersFromQuestion.js";
import type { DataSummary } from "../shared/schema.js";

const FURNITURE: InferredFilter = {
  column: "Category",
  op: "in",
  values: ["Furniture"],
  match: "case_insensitive",
  matchedTokens: ["furniture"],
};

function minimalCtx(inferred?: InferredFilter[]): AgentExecutionContext {
  const summary: DataSummary = {
    rowCount: 1,
    columnCount: 1,
    columns: [{ name: "Sales", type: "number", sampleValues: [] }],
    numericColumns: ["Sales"],
    dateColumns: [],
  };
  return {
    sessionId: "s1",
    question: "q",
    data: [],
    summary,
    chatHistory: [],
    mode: "analysis",
    inferredFilters: inferred,
  } as AgentExecutionContext;
}

describe("ensureInferredFiltersOnStep", () => {
  it("injects missing filter into execute_query_plan.plan.dimensionFilters", () => {
    const step: PlanStep = {
      id: "s1",
      tool: "execute_query_plan",
      args: {
        plan: {
          groupBy: ["Region"],
          aggregations: [{ column: "Sales", operation: "sum" }],
        },
      },
    };
    const injected = ensureInferredFiltersOnStep(step, [FURNITURE]);
    assert.deepEqual(injected, ["Category"]);
    const filters = (step.args as any).plan.dimensionFilters;
    assert.equal(filters.length, 1);
    assert.equal(filters[0].column, "Category");
    assert.deepEqual(filters[0].values, ["Furniture"]);
    assert.equal(filters[0].op, "in");
    assert.equal(filters[0].match, "case_insensitive");
  });

  it("preserves existing dimensionFilters for the same column/op", () => {
    const step: PlanStep = {
      id: "s1",
      tool: "execute_query_plan",
      args: {
        plan: {
          groupBy: ["Region"],
          aggregations: [{ column: "Sales", operation: "sum" }],
          dimensionFilters: [
            { column: "Category", op: "in", values: ["Furniture", "Technology"] },
          ],
        },
      },
    };
    const injected = ensureInferredFiltersOnStep(step, [FURNITURE]);
    assert.deepEqual(injected, []);
    const filters = (step.args as any).plan.dimensionFilters;
    assert.equal(filters.length, 1);
    assert.deepEqual(filters[0].values, ["Furniture", "Technology"]);
  });

  it("injects into top-level dimensionFilters for run_correlation", () => {
    const step: PlanStep = {
      id: "s2",
      tool: "run_correlation",
      args: { targetVariable: "Sales" },
    };
    const injected = ensureInferredFiltersOnStep(step, [FURNITURE]);
    assert.deepEqual(injected, ["Category"]);
    const filters = (step.args as any).dimensionFilters;
    assert.equal(filters.length, 1);
    assert.equal(filters[0].column, "Category");
  });

  it("is a no-op for tools without dimensionFilters support", () => {
    const step: PlanStep = {
      id: "s3",
      tool: "describe_columns",
      args: {},
    };
    const injected = ensureInferredFiltersOnStep(step, [FURNITURE]);
    assert.deepEqual(injected, []);
    assert.equal((step.args as any).dimensionFilters, undefined);
  });

  it("is a no-op when no inferred filters exist", () => {
    const step: PlanStep = {
      id: "s1",
      tool: "execute_query_plan",
      args: { plan: { groupBy: ["Region"] } },
    };
    const injected = ensureInferredFiltersOnStep(step, undefined);
    assert.deepEqual(injected, []);
    assert.equal((step.args as any).plan.dimensionFilters, undefined);
  });
});

describe("checkMissingInferredFilters", () => {
  it("reports columns that no step references", () => {
    const steps: PlanStep[] = [
      {
        id: "s1",
        tool: "execute_query_plan",
        args: {
          plan: {
            groupBy: ["Region"],
            aggregations: [{ column: "Sales", operation: "sum" }],
          },
        },
      },
    ];
    const missing = checkMissingInferredFilters(steps, [FURNITURE]);
    assert.deepEqual(missing, ["Category"]);
  });

  it("returns empty when every inferred column is filtered somewhere", () => {
    const steps: PlanStep[] = [
      {
        id: "s1",
        tool: "execute_query_plan",
        args: {
          plan: {
            groupBy: ["Region"],
            aggregations: [{ column: "Sales", operation: "sum" }],
            dimensionFilters: [
              { column: "Category", op: "in", values: ["Furniture"] },
            ],
          },
        },
      },
    ];
    const missing = checkMissingInferredFilters(steps, [FURNITURE]);
    assert.deepEqual(missing, []);
  });

  it("returns empty when no plan step is filter-capable (skip — no false positives)", () => {
    const steps: PlanStep[] = [
      { id: "s1", tool: "clarify_user", args: { prompt: "?" } },
    ];
    const missing = checkMissingInferredFilters(steps, [FURNITURE]);
    assert.deepEqual(missing, []);
  });
});

describe("checkInferredFilterFidelity (verifier backstop)", () => {
  it("emits MISSING_INFERRED_FILTER with high severity when a filter is missing", () => {
    const ctx = minimalCtx([FURNITURE]);
    const steps: PlanStep[] = [
      {
        id: "s1",
        tool: "execute_query_plan",
        args: {
          plan: {
            groupBy: ["Region"],
            aggregations: [{ column: "Sales", operation: "sum" }],
          },
        },
      },
    ];
    const issues = checkInferredFilterFidelity(ctx, steps);
    assert.equal(issues.length, 1);
    assert.equal(issues[0]!.code, "MISSING_INFERRED_FILTER");
    assert.equal(issues[0]!.severity, "high");
    assert.match(issues[0]!.description, /Category/);
    assert.match(issues[0]!.description, /Furniture/);
  });

  it("is silent when the plan applies the inferred filter", () => {
    const ctx = minimalCtx([FURNITURE]);
    const steps: PlanStep[] = [
      {
        id: "s1",
        tool: "execute_query_plan",
        args: {
          plan: {
            groupBy: ["Region"],
            dimensionFilters: [
              { column: "Category", op: "in", values: ["Furniture"] },
            ],
          },
        },
      },
    ];
    const issues = checkInferredFilterFidelity(ctx, steps);
    assert.deepEqual(issues, []);
  });

  it("is silent when inferredFilters is empty", () => {
    const ctx = minimalCtx(undefined);
    const steps: PlanStep[] = [
      {
        id: "s1",
        tool: "execute_query_plan",
        args: { plan: { groupBy: ["Region"] } },
      },
    ];
    const issues = checkInferredFilterFidelity(ctx, steps);
    assert.deepEqual(issues, []);
  });
});
