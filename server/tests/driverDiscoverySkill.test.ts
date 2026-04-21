import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { AgentExecutionContext } from "../lib/agents/runtime/types.js";
import type { AnalysisBrief, DataSummary } from "../shared/schema.js";
import { driverDiscoverySkill } from "../lib/agents/runtime/skills/driverDiscovery.js";

const summary = (): DataSummary =>
  ({
    columnCount: 4,
    rowCount: 100,
    columns: [
      { name: "Region", type: "string", sampleValues: [], nullCount: 0 },
      { name: "Category", type: "string", sampleValues: [], nullCount: 0 },
      { name: "Discount", type: "number", sampleValues: [], nullCount: 0 },
      { name: "Sales", type: "number", sampleValues: [], nullCount: 0 },
    ],
    numericColumns: ["Discount", "Sales"],
    dateColumns: [],
  }) as unknown as DataSummary;

const ctx = (): AgentExecutionContext => ({
  sessionId: "s",
  question: "what impacts my sales the most",
  data: [],
  summary: summary(),
  chatHistory: [],
  mode: "analysis",
});

const driverBrief = (partial?: Partial<AnalysisBrief>): AnalysisBrief => ({
  version: 1,
  questionShape: "driver_discovery",
  outcomeMetricColumn: "Sales",
  candidateDriverDimensions: ["Region", "Category"],
  clarifyingQuestions: [],
  epistemicNotes: [],
  ...partial,
});

describe("driverDiscoverySkill.appliesTo", () => {
  it("applies for driver_discovery with an outcome metric", () => {
    assert.equal(driverDiscoverySkill.appliesTo(driverBrief(), ctx()), true);
  });

  it("does not apply to other shapes", () => {
    assert.equal(
      driverDiscoverySkill.appliesTo(
        driverBrief({ questionShape: "trend" }),
        ctx()
      ),
      false
    );
  });
});

describe("driverDiscoverySkill.plan", () => {
  it("emits correlation + two breakdowns + bar chart when everything is present", () => {
    const invocation = driverDiscoverySkill.plan(driverBrief(), ctx());
    assert.ok(invocation);
    const ids = invocation!.steps.map((s) => s.id);
    assert.deepEqual(ids, [
      "drv_correlation",
      "drv_breakdown_1",
      "drv_breakdown_2",
      "drv_chart",
    ]);
    const chart = invocation!.steps.find((s) => s.id === "drv_chart");
    assert.equal(chart!.dependsOn, "drv_breakdown_1");
    assert.equal(invocation!.parallelizable, true);
  });

  it("skips correlation when the outcome is not numeric", () => {
    const nonNumericOutcome: AgentExecutionContext = {
      ...ctx(),
      summary: {
        ...summary(),
        numericColumns: ["Discount"],
      } as unknown as DataSummary,
    };
    const invocation = driverDiscoverySkill.plan(
      driverBrief(),
      nonNumericOutcome
    );
    assert.ok(invocation);
    const ids = invocation!.steps.map((s) => s.id);
    assert.deepEqual(ids, ["drv_breakdown_1", "drv_breakdown_2", "drv_chart"]);
  });

  it("returns null when no drivers and outcome is not numeric", () => {
    const invocation = driverDiscoverySkill.plan(
      driverBrief({ candidateDriverDimensions: [] }),
      {
        ...ctx(),
        summary: {
          ...summary(),
          numericColumns: ["Discount"],
        } as unknown as DataSummary,
      }
    );
    assert.equal(invocation, null);
  });

  it("emits just correlation when no driver dimensions are listed but outcome is numeric", () => {
    const invocation = driverDiscoverySkill.plan(
      driverBrief({ candidateDriverDimensions: [] }),
      ctx()
    );
    assert.ok(invocation);
    assert.deepEqual(
      invocation!.steps.map((s) => s.id),
      ["drv_correlation"]
    );
  });
});
