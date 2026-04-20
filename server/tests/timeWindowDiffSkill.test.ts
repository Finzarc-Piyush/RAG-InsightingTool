import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { AgentExecutionContext } from "../lib/agents/runtime/types.js";
import type { AnalysisBrief, DataSummary } from "../shared/schema.js";
import { timeWindowDiffSkill } from "../lib/agents/runtime/skills/timeWindowDiff.js";

const summary = (): DataSummary =>
  ({
    columnCount: 4,
    rowCount: 100,
    columns: [
      { name: "Month · Order Date", type: "string", sampleValues: [], nullCount: 0 },
      { name: "Region", type: "string", sampleValues: [], nullCount: 0 },
      { name: "Category", type: "string", sampleValues: [], nullCount: 0 },
      { name: "Sales", type: "number", sampleValues: [], nullCount: 0 },
    ],
    numericColumns: ["Sales"],
    dateColumns: ["Order Date"],
  }) as unknown as DataSummary;

const ctx = (): AgentExecutionContext => ({
  sessionId: "s",
  question: "compare march 2022 vs april 2025 sales",
  data: [],
  summary: summary(),
  chatHistory: [],
  mode: "analysis",
});

const compareBrief = (partial?: Partial<AnalysisBrief>): AnalysisBrief => ({
  version: 1,
  questionShape: "comparison",
  outcomeMetricColumn: "Sales",
  candidateDriverDimensions: ["Region"],
  comparisonPeriods: {
    a: [
      {
        column: "Month · Order Date",
        op: "in",
        values: ["2022-03"],
      },
    ],
    b: [
      {
        column: "Month · Order Date",
        op: "in",
        values: ["2025-04"],
      },
    ],
    aLabel: "Mar-22",
    bLabel: "Apr-25",
  },
  clarifyingQuestions: [],
  epistemicNotes: [],
  ...partial,
});

describe("timeWindowDiffSkill.appliesTo", () => {
  it("applies for comparison shape with both periods and an outcome", () => {
    assert.equal(timeWindowDiffSkill.appliesTo(compareBrief(), ctx()), true);
  });

  it("also applies for variance_diagnostic when both periods are set", () => {
    assert.equal(
      timeWindowDiffSkill.appliesTo(
        compareBrief({ questionShape: "variance_diagnostic" }),
        ctx()
      ),
      true
    );
  });

  it("does not apply without an outcome metric", () => {
    assert.equal(
      timeWindowDiffSkill.appliesTo(
        compareBrief({ outcomeMetricColumn: undefined }),
        ctx()
      ),
      false
    );
  });

  it("does not apply when comparisonPeriods is missing", () => {
    assert.equal(
      timeWindowDiffSkill.appliesTo(
        compareBrief({ comparisonPeriods: undefined }),
        ctx()
      ),
      false
    );
  });

  it("does not apply on unrelated shapes (trend, exploration)", () => {
    assert.equal(
      timeWindowDiffSkill.appliesTo(
        compareBrief({ questionShape: "trend" }),
        ctx()
      ),
      false
    );
  });
});

describe("timeWindowDiffSkill.plan", () => {
  it("emits compare + two breakdowns + bar chart when a driver is present", () => {
    const invocation = timeWindowDiffSkill.plan(compareBrief(), ctx());
    assert.ok(invocation);
    const ids = invocation!.steps.map((s) => s.id);
    assert.deepEqual(ids, [
      "twd_compare",
      "twd_breakdown_a",
      "twd_breakdown_b",
      "twd_chart",
    ]);
    assert.equal(invocation!.parallelizable, true);
    const chart = invocation!.steps.find((s) => s.id === "twd_chart");
    assert.equal(chart!.dependsOn, "twd_compare");
  });

  it("passes the right period filters into the compare step", () => {
    const invocation = timeWindowDiffSkill.plan(compareBrief(), ctx());
    const compare = invocation!.steps.find((s) => s.id === "twd_compare")!;
    const args = compare.args as {
      segment_a_filters: Array<{ values: string[] }>;
      segment_b_filters: Array<{ values: string[] }>;
      segment_a_label: string;
      segment_b_label: string;
    };
    assert.deepEqual(args.segment_a_filters[0].values, ["2022-03"]);
    assert.deepEqual(args.segment_b_filters[0].values, ["2025-04"]);
    assert.equal(args.segment_a_label, "Mar-22");
    assert.equal(args.segment_b_label, "Apr-25");
  });

  it("skips breakdown steps when no candidate drivers exist", () => {
    const invocation = timeWindowDiffSkill.plan(
      compareBrief({ candidateDriverDimensions: [] }),
      ctx()
    );
    const ids = invocation!.steps.map((s) => s.id);
    assert.deepEqual(ids, ["twd_compare", "twd_chart"]);
  });

  it("returns null when a period filter set is empty", () => {
    const invocation = timeWindowDiffSkill.plan(
      compareBrief({
        comparisonPeriods: {
          a: [],
          b: [
            {
              column: "Month · Order Date",
              op: "in",
              values: ["2025-04"],
            },
          ],
          aLabel: "Mar-22",
          bLabel: "Apr-25",
        },
      } as any),
      ctx()
    );
    assert.equal(invocation, null);
  });
});
