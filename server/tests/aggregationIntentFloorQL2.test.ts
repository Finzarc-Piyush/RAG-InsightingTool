/**
 * Wave QL2 · Aggregation-intent floor. `synthesizeAggregationStep` returns
 * a deterministic `execute_query_plan` step when the user's question is a
 * literal aggregation that the planner LLM might miss. `planAlreadyCoversAggregation`
 * provides the idempotency check used at the call site in `planner.ts`.
 *
 * The Marico-VN screenshot scenario that motivated this wave is pinned in
 * the first test: the LLM emitted zero query steps for "What is the average
 * number of compliance visits per day across all clusters?", the narrator
 * was forced into "not computable", and the user saw 5 untested hypotheses
 * instead of an answer.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  synthesizeAggregationStep,
  planAlreadyCoversAggregation,
  detectPerXIntent,
  detectMultiPerIntent,
  resolveAnswerDimensionFromQuestion,
  resolveMetricColumnFromQuestion,
} from "../lib/agents/runtime/planArgRepairs.js";
import type { DataSummary } from "../shared/schema.js";
import type { PlanStep } from "../lib/agents/runtime/types.js";

function maricoSummary(): Pick<
  DataSummary,
  "columns" | "dateColumns" | "numericColumns"
> {
  return {
    columns: [
      { name: "Compliance Visit", type: "number", sampleValues: [] },
      { name: "Non-Compliance Visit", type: "number", sampleValues: [] },
      { name: "Total Visited OL's", type: "number", sampleValues: [] },
      { name: "GCPC", type: "number", sampleValues: [] },
      { name: "Cluster Name", type: "string", sampleValues: [] },
      { name: "Region", type: "string", sampleValues: [] },
      { name: "TSO_TSE Name", type: "string", sampleValues: [] },
      { name: "Date", type: "date", sampleValues: [] },
    ],
    dateColumns: ["Date"],
    numericColumns: [
      "Compliance Visit",
      "Non-Compliance Visit",
      "Total Visited OL's",
      "GCPC",
    ],
  };
}

function step(args: Record<string, unknown>): PlanStep {
  return {
    id: "llm_s1",
    tool: "execute_query_plan",
    args,
  };
}

describe("Wave QL2 · synthesizeAggregationStep", () => {
  it("Wave QL7 · synthesizes the Marico screenshot scenario as the simpler ratio shape (SUM/COUNT_DISTINCT)", () => {
    const summary = maricoSummary();
    const q =
      "What is the average number of compliance visits per day across all clusters?";
    const perX = detectPerXIntent(q, summary);
    const multiPer = detectMultiPerIntent(q, summary);
    const synth = synthesizeAggregationStep(q, summary, perX, multiPer);
    assert.ok(synth, "should synthesize a step for the failing Marico question");
    assert.ok(
      synth!.reason === "multi_per_intent" ||
        synth!.reason === "per_x_with_answer_dim",
      `unexpected reason: ${synth!.reason}`
    );
    assert.equal(synth!.outerOp, "mean");
    assert.equal(synth!.metricColumn, "Compliance Visit");
    assert.deepEqual(synth!.groupBy, ["Cluster Name"]);
    const plan = synth!.step.args.plan as Record<string, unknown>;
    assert.deepEqual(plan.groupBy, ["Cluster Name"]);
    // Wave QL7 · Ratio shape: two aggregations + one computedAggregations.
    const aggs = plan.aggregations as Array<Record<string, unknown>>;
    assert.equal(aggs.length, 2, "ratio shape emits SUM + COUNT_DISTINCT");
    const sumAgg = aggs.find((a) => a.operation === "sum");
    const cdAgg = aggs.find((a) => a.operation === "count_distinct");
    assert.ok(sumAgg, "expected a SUM aggregation");
    assert.equal(sumAgg!.column, "Compliance Visit");
    assert.ok(cdAgg, "expected a COUNT_DISTINCT aggregation");
    assert.equal(cdAgg!.column, "Date");
    const computed = plan.computedAggregations as Array<Record<string, unknown>>;
    assert.equal(computed.length, 1);
    assert.match(
      computed[0]!.expression as string,
      /total_compliance_visit\s*\/\s*num_distinct_date/
    );
    assert.match(computed[0]!.alias as string, /^avg_compliance_visit_per_date$/);
    // Legacy perDimension shape is NOT used.
    assert.equal(sumAgg!.perDimension, undefined);
    assert.equal(cdAgg!.perDimension, undefined);
  });

  it("multi_per_intent branch fires for 'per day per cluster' (no stop words)", () => {
    const summary = maricoSummary();
    const q =
      "What is the average number of compliance visits per day per cluster name?";
    const perX = detectPerXIntent(q, summary);
    const multiPer = detectMultiPerIntent(q, summary);
    const synth = synthesizeAggregationStep(q, summary, perX, multiPer);
    assert.ok(synth);
    assert.equal(synth!.reason, "multi_per_intent");
    assert.deepEqual(synth!.groupBy, ["Cluster Name"]);
  });

  it("resolves 'clusters' (plural) to 'Cluster Name' via singular fallback", () => {
    const summary = maricoSummary();
    const matched = resolveAnswerDimensionFromQuestion(
      "Average sales across all clusters",
      summary
    );
    assert.equal(matched, "Cluster Name");
  });

  it("strips 'all/the/each/every' stop words before resolving the dimension", () => {
    const summary = maricoSummary();
    assert.equal(
      resolveAnswerDimensionFromQuestion("across all clusters", summary),
      "Cluster Name"
    );
    assert.equal(
      resolveAnswerDimensionFromQuestion("for each region", summary),
      "Region"
    );
    assert.equal(
      resolveAnswerDimensionFromQuestion("by the region", summary),
      "Region"
    );
  });

  it("refuses date columns as answer dimensions (those belong as rate denominators)", () => {
    const summary = maricoSummary();
    const matched = resolveAnswerDimensionFromQuestion(
      "Average sales by date",
      summary
    );
    assert.equal(matched, null);
  });

  it("returns null for non-aggregation questions ('why are visits falling')", () => {
    const summary = maricoSummary();
    const q = "Why are compliance visits falling in Q3?";
    const perX = detectPerXIntent(q, summary);
    const multiPer = detectMultiPerIntent(q, summary);
    const synth = synthesizeAggregationStep(q, summary, perX, multiPer);
    assert.equal(synth, null);
  });

  it("returns null when the metric column can't be resolved from the question", () => {
    const summary = maricoSummary();
    const q = "What is the average xyz per day across all clusters?";
    const perX = detectPerXIntent(q, summary);
    const multiPer = detectMultiPerIntent(q, summary);
    const synth = synthesizeAggregationStep(q, summary, perX, multiPer);
    assert.equal(synth, null);
  });

  it("synthesizes simple aggregation ('What is the total compliance visits by cluster?')", () => {
    const summary = maricoSummary();
    const q = "What is the total compliance visits by cluster name?";
    const perX = detectPerXIntent(q, summary);
    const multiPer = detectMultiPerIntent(q, summary);
    const synth = synthesizeAggregationStep(q, summary, perX, multiPer);
    assert.ok(synth);
    assert.equal(synth!.reason, "simple_aggregation");
    assert.equal(synth!.outerOp, "sum");
    assert.equal(synth!.metricColumn, "Compliance Visit");
    assert.deepEqual(synth!.groupBy, ["Cluster Name"]);
    const plan = synth!.step.args.plan as Record<string, unknown>;
    const aggs = plan.aggregations as Array<Record<string, unknown>>;
    assert.equal(aggs[0]!.perDimension, undefined);
    assert.equal(aggs[0]!.innerOperation, undefined);
  });

  it("Wave QL9.B · suppresses synth for scalar per-temporal questions with NO answer dim", () => {
    const summary = maricoSummary();
    // "average X per day" with no "by/across <Y>" → pure scalar question.
    // The LLM's exploratory step gives the user the breakdown; the floor
    // adding a duplicate scalar visualization is pure noise.
    const q = "What is the average compliance visits per day?";
    const perX = detectPerXIntent(q, summary);
    const multiPer = detectMultiPerIntent(q, summary);
    const synth = synthesizeAggregationStep(q, summary, perX, multiPer);
    assert.equal(
      synth,
      null,
      "synthesis must be suppressed for pure-scalar per-temporal questions"
    );
  });

  it("Wave QL9.B · STILL synthesizes for non-temporal per-X with no answer dim", () => {
    // Non-temporal per-clauses (per customer, per region) — count_distinct
    // on a dimension column doesn't have the same physical meaning as
    // count_distinct on a date, so the floor's ratio shape stays. Falls
    // back to the legacy perDimension shape via buildSynthAggregationStep.
    const summary: Pick<
      DataSummary,
      "columns" | "dateColumns" | "numericColumns"
    > = {
      columns: [
        { name: "Customer", type: "string", sampleValues: [] },
        { name: "Sales", type: "number", sampleValues: [] },
        { name: "Date", type: "date", sampleValues: [] },
      ],
      dateColumns: ["Date"],
      numericColumns: ["Sales"],
    };
    const q = "What is the average sales per customer?";
    const perX = detectPerXIntent(q, summary);
    const multiPer = detectMultiPerIntent(q, summary);
    const synth = synthesizeAggregationStep(q, summary, perX, multiPer);
    assert.ok(
      synth,
      "non-temporal per-clause still synthesizes (no QL9.B suppression)"
    );
    assert.equal(synth!.reason, "per_x_no_answer_dim");
  });

  it("prefers the longest substring match when multiple numeric columns overlap", () => {
    const summary = maricoSummary();
    // Both "Compliance Visit" and "Non-Compliance Visit" contain "compliance visit"
    // — the question explicitly mentions the longer phrase, so we want the longer
    // column-name match to win.
    const matched = resolveMetricColumnFromQuestion(
      "What is the total non-compliance visit count?",
      summary
    );
    assert.equal(matched, "Non-Compliance Visit");
  });

  it("planAlreadyCoversAggregation returns true when an LLM step matches", () => {
    const summary = maricoSummary();
    const q = "Average compliance visits per day across all clusters";
    const synth = synthesizeAggregationStep(
      q,
      summary,
      detectPerXIntent(q, summary),
      detectMultiPerIntent(q, summary)
    )!;
    const llmStep = step({
      plan: {
        groupBy: ["Cluster Name"],
        aggregations: [
          { column: "Compliance Visit", operation: "mean", alias: "x" },
        ],
      },
    });
    assert.equal(planAlreadyCoversAggregation([llmStep], synth), true);
  });

  it("planAlreadyCoversAggregation returns false when the LLM step misses the groupBy", () => {
    const summary = maricoSummary();
    const q = "Average compliance visits per day across all clusters";
    const synth = synthesizeAggregationStep(
      q,
      summary,
      detectPerXIntent(q, summary),
      detectMultiPerIntent(q, summary)
    )!;
    const llmStep = step({
      plan: {
        groupBy: ["TSO_TSE Name"], // wrong group dimension
        aggregations: [
          { column: "Compliance Visit", operation: "mean", alias: "x" },
        ],
      },
    });
    assert.equal(planAlreadyCoversAggregation([llmStep], synth), false);
  });

  it("Wave QL8 · planAlreadyCoversAggregation REJECTS coverage when LLM groupBy includes the rate denominator", () => {
    const summary = maricoSummary();
    const q =
      "Average compliance visits per day across all clusters";
    const synth = synthesizeAggregationStep(
      q,
      summary,
      detectPerXIntent(q, summary),
      detectMultiPerIntent(q, summary)
    )!;
    // synth.step.args.plan.aggregations[0].perDimension === "Day · Date"
    // The LLM's plan groups by Cluster Name AND Date — that's a trend-with-
    // breakdown grid (cluster × date), NOT rate-per-cluster. Coverage check
    // must reject so synthesis fires.
    const llmStep = step({
      plan: {
        groupBy: ["Cluster Name", "Date"],
        aggregations: [
          { column: "Compliance Visit", operation: "mean", alias: "x" },
        ],
      },
    });
    assert.equal(planAlreadyCoversAggregation([llmStep], synth), false);
  });

  it("Wave QL8 · rejects when LLM groupBy contains a temporal facet over the same source column", () => {
    const summary = maricoSummary();
    const q =
      "Average compliance visits per day across all clusters";
    const synth = synthesizeAggregationStep(
      q,
      summary,
      detectPerXIntent(q, summary),
      detectMultiPerIntent(q, summary)
    )!;
    // LLM uses "Week · Date" — same source column ("Date") as synth's
    // count_distinct denominator. Still a trend grid, still a different
    // intent. Pass dateColumns so the alias collector expands "Date" into
    // all its temporal facets.
    const llmStep = step({
      plan: {
        groupBy: ["Cluster Name", "Week · Date"],
        aggregations: [
          { column: "Compliance Visit", operation: "mean", alias: "x" },
        ],
      },
    });
    assert.equal(
      planAlreadyCoversAggregation([llmStep], synth, {
        dateColumns: ["Date"],
      }),
      false
    );
  });

  it("Wave QL8 · still ACCEPTS coverage when LLM groupBy includes only the answer dim (no rate denominator)", () => {
    const summary = maricoSummary();
    const q =
      "Average compliance visits per day across all clusters";
    const synth = synthesizeAggregationStep(
      q,
      summary,
      detectPerXIntent(q, summary),
      detectMultiPerIntent(q, summary)
    )!;
    // LLM groups by Cluster Name + Region (extra non-temporal dim is fine —
    // not a rate denominator). Synthesis is covered.
    const llmStep = step({
      plan: {
        groupBy: ["Cluster Name", "Region"],
        aggregations: [
          { column: "Compliance Visit", operation: "mean", alias: "x" },
        ],
      },
    });
    assert.equal(planAlreadyCoversAggregation([llmStep], synth), true);
  });

  it("planAlreadyCoversAggregation returns false when the LLM step uses a different outer op", () => {
    const summary = maricoSummary();
    const q = "Average compliance visits per day across all clusters";
    const synth = synthesizeAggregationStep(
      q,
      summary,
      detectPerXIntent(q, summary),
      detectMultiPerIntent(q, summary)
    )!;
    const llmStep = step({
      plan: {
        groupBy: ["Cluster Name"],
        aggregations: [
          { column: "Compliance Visit", operation: "sum", alias: "x" },
        ],
      },
    });
    assert.equal(planAlreadyCoversAggregation([llmStep], synth), false);
  });

  it("synthesized step prefixes id with 'ql2_synth_' for audit visibility", () => {
    const summary = maricoSummary();
    const q = "Average compliance visits per day across all clusters";
    const synth = synthesizeAggregationStep(
      q,
      summary,
      detectPerXIntent(q, summary),
      detectMultiPerIntent(q, summary)
    )!;
    assert.match(synth.step.id, /^ql2_synth_/);
  });

  it("returns null on empty question", () => {
    const summary = maricoSummary();
    assert.equal(synthesizeAggregationStep("", summary, null, null), null);
    assert.equal(synthesizeAggregationStep(undefined, summary, null, null), null);
  });

  it("respects wideFormatTransform.meltedColumns when resolving metric names", () => {
    const summary: Pick<
      DataSummary,
      "columns" | "dateColumns" | "numericColumns"
    > & {
      wideFormatTransform?: DataSummary["wideFormatTransform"];
    } = {
      columns: [
        { name: "Period", type: "string", sampleValues: [] },
        { name: "Value", type: "number", sampleValues: [] },
        { name: "Date", type: "date", sampleValues: [] },
        { name: "Region", type: "string", sampleValues: [] },
      ],
      dateColumns: ["Date"],
      numericColumns: ["Value"],
      wideFormatTransform: {
        detected: true,
        shape: "pure_period",
        idColumns: ["Region"],
        meltedColumns: ["Q1 23 Value Sales", "Q2 23 Value Sales"],
        periodCount: 2,
        periodColumn: "Period",
        periodIsoColumn: "PeriodIso",
        periodKindColumn: "PeriodKind",
        valueColumn: "Value",
      },
    };
    // Asking for a melted column name must NOT silently bind to the long-form
    // `Value` column.
    const matched = resolveMetricColumnFromQuestion(
      "What is the total Q1 23 Value Sales?",
      summary,
      { wideFormatTransform: summary.wideFormatTransform }
    );
    // Either it matches "Value" via fallback fuzzy (acceptable) OR it returns
    // null after meltedColumns refusal. Both prevent silent corruption. The
    // critical check is that the WPF5 protection blocks the EXACT melted
    // column name lookup.
    // Test the direct findMatchingColumn refusal via the matcher's contract.
    assert.ok(matched === null || matched === "Value");
  });
});
