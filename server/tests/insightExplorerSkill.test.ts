import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { AgentExecutionContext } from "../lib/agents/runtime/types.js";
import type { AnalysisBrief, DataSummary } from "../shared/schema.js";
import { insightExplorerSkill } from "../lib/agents/runtime/skills/insightExplorer.js";

const summary = (overrides: Partial<DataSummary> = {}): DataSummary =>
  ({
    columnCount: 4,
    rowCount: 100,
    columns: [
      { name: "OrderID", type: "string", sampleValues: [], nullCount: 0 },
      { name: "Category", type: "string", sampleValues: [], nullCount: 0 },
      { name: "Region", type: "string", sampleValues: [], nullCount: 0 },
      { name: "Sales", type: "number", sampleValues: [], nullCount: 0 },
    ],
    numericColumns: ["Sales"],
    dateColumns: [],
    ...overrides,
  }) as unknown as DataSummary;

const ctx = (overrides: Partial<DataSummary> = {}): AgentExecutionContext => ({
  sessionId: "s",
  question: "show me something interesting",
  data: [],
  summary: summary(overrides),
  chatHistory: [],
  mode: "analysis",
});

const explorationBrief: AnalysisBrief = {
  version: 1,
  questionShape: "exploration",
  clarifyingQuestions: [],
  epistemicNotes: [],
};

describe("insightExplorerSkill", () => {
  it("applies only for questionShape=exploration with usable columns", () => {
    assert.equal(insightExplorerSkill.appliesTo(explorationBrief, ctx()), true);
    assert.equal(
      insightExplorerSkill.appliesTo(
        { ...explorationBrief, questionShape: "trend" },
        ctx()
      ),
      false
    );
  });

  it("emits schema + correlation + breakdown + chart when a numeric + categorical exist", () => {
    const invocation = insightExplorerSkill.plan(explorationBrief, ctx());
    assert.ok(invocation);
    assert.deepEqual(
      invocation!.steps.map((s) => s.id),
      ["ins_schema", "ins_correlation", "ins_breakdown", "ins_chart"]
    );
    assert.equal(invocation!.parallelizable, true);
    const chart = invocation!.steps.find((s) => s.id === "ins_chart");
    assert.equal(chart!.dependsOn, "ins_breakdown");
  });

  it("skips ID-like column names when picking a categorical dimension", () => {
    const invocation = insightExplorerSkill.plan(
      explorationBrief,
      ctx({
        columns: [
          { name: "order_id", type: "string", sampleValues: [], nullCount: 0 },
          { name: "Category", type: "string", sampleValues: [], nullCount: 0 },
          { name: "Sales", type: "number", sampleValues: [], nullCount: 0 },
        ],
        numericColumns: ["Sales"],
      } as Partial<DataSummary>)
    );
    assert.ok(invocation);
    const breakdown = invocation!.steps.find((s) => s.id === "ins_breakdown");
    assert.equal(
      (breakdown!.args as { breakdownColumn: string }).breakdownColumn,
      "Category"
    );
  });

  it("skips the breakdown+chart when no categorical dimension is available", () => {
    const invocation = insightExplorerSkill.plan(
      explorationBrief,
      ctx({
        columns: [
          { name: "order_id", type: "string", sampleValues: [], nullCount: 0 },
          { name: "Sales", type: "number", sampleValues: [], nullCount: 0 },
        ],
        numericColumns: ["Sales"],
      } as Partial<DataSummary>)
    );
    assert.ok(invocation);
    assert.deepEqual(
      invocation!.steps.map((s) => s.id),
      ["ins_schema", "ins_correlation"]
    );
  });

  it("returns null when only schema would be emitted", () => {
    const invocation = insightExplorerSkill.plan(explorationBrief, {
      ...ctx(),
      summary: {
        columnCount: 1,
        rowCount: 10,
        columns: [
          { name: "order_id", type: "string", sampleValues: [], nullCount: 0 },
        ],
        numericColumns: [],
        dateColumns: [],
      } as unknown as DataSummary,
    });
    assert.equal(invocation, null);
  });
});
