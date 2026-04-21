import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";

import type { AgentExecutionContext } from "../lib/agents/runtime/types.js";
import type { AnalysisBrief, DataSummary } from "../shared/schema.js";
import { varianceDecomposerSkill } from "../lib/agents/runtime/skills/varianceDecomposer.js";

const summary = (): DataSummary =>
  ({
    columnCount: 5,
    rowCount: 100,
    columns: [
      { name: "Order Date", type: "date", sampleValues: [], nullCount: 0 },
      { name: "Region", type: "string", sampleValues: [], nullCount: 0 },
      { name: "Category", type: "string", sampleValues: [], nullCount: 0 },
      { name: "Channel", type: "string", sampleValues: [], nullCount: 0 },
      { name: "Sales", type: "number", sampleValues: [], nullCount: 0 },
    ],
    numericColumns: ["Sales"],
    dateColumns: ["Order Date"],
  }) as unknown as DataSummary;

const ctx = (): AgentExecutionContext => ({
  sessionId: "s",
  question: "why did east-region tech sales fall in 2024",
  data: [],
  summary: summary(),
  chatHistory: [],
  mode: "analysis",
});

const varianceBrief = (partial?: Partial<AnalysisBrief>): AnalysisBrief => ({
  version: 1,
  questionShape: "variance_diagnostic",
  outcomeMetricColumn: "Sales",
  candidateDriverDimensions: ["Category", "Channel"],
  filters: [{ column: "Region", op: "in", values: ["East"] }],
  timeWindow: { description: "2024", grainPreference: "monthly" },
  clarifyingQuestions: [],
  epistemicNotes: [],
  ...partial,
});

describe("varianceDecomposerSkill.appliesTo", () => {
  it("applies when shape is variance_diagnostic with an outcome metric", () => {
    assert.equal(
      varianceDecomposerSkill.appliesTo(varianceBrief(), ctx()),
      true
    );
  });

  it("does not apply without an outcome metric", () => {
    assert.equal(
      varianceDecomposerSkill.appliesTo(
        varianceBrief({ outcomeMetricColumn: undefined }),
        ctx()
      ),
      false
    );
  });

  it("does not apply to other question shapes", () => {
    assert.equal(
      varianceDecomposerSkill.appliesTo(
        varianceBrief({ questionShape: "trend" }),
        ctx()
      ),
      false
    );
  });
});

describe("varianceDecomposerSkill.plan", () => {
  it("emits a time-series + 2 breakdowns + a chart when two drivers are present", () => {
    const invocation = varianceDecomposerSkill.plan(varianceBrief(), ctx());
    assert.ok(invocation);
    const ids = invocation!.steps.map((s) => s.id);
    assert.deepEqual(ids, [
      "var_timeseries",
      "var_breakdown_1",
      "var_breakdown_2",
      "var_chart",
    ]);
    // Time-series step carries the filters and monthly grain.
    const ts = invocation!.steps.find((s) => s.id === "var_timeseries");
    const plan = (ts!.args as { plan: any }).plan;
    assert.equal(plan.dateAggregationPeriod, "month");
    assert.deepEqual(plan.groupBy, ["Order Date"]);
    assert.ok(plan.dimensionFilters?.length === 1);
    // Chart depends on the time-series step.
    const chart = invocation!.steps.find((s) => s.id === "var_chart");
    assert.equal(chart!.dependsOn, "var_timeseries");
    assert.equal((chart!.args as { type: string }).type, "line");
  });

  it("omits breakdown steps when no candidate drivers are listed", () => {
    const invocation = varianceDecomposerSkill.plan(
      varianceBrief({ candidateDriverDimensions: [] }),
      ctx()
    );
    assert.ok(invocation);
    assert.deepEqual(
      invocation!.steps.map((s) => s.id),
      ["var_timeseries", "var_chart"]
    );
  });

  it("returns null when the dataset has no date column", () => {
    const noDates: AgentExecutionContext = {
      ...ctx(),
      summary: {
        ...summary(),
        dateColumns: [],
      } as unknown as DataSummary,
    };
    assert.equal(varianceDecomposerSkill.plan(varianceBrief(), noDates), null);
  });
});
