import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatWorkingMemoryBlock,
  sortPlanStepsByDependency,
} from "../lib/agents/runtime/workingMemory.js";
import type { WorkingMemoryEntry } from "../lib/agents/runtime/types.js";
import type { PlanStep } from "../lib/agents/runtime/types.js";

describe("workingMemory", () => {
  it("formatWorkingMemoryBlock is empty without entries", () => {
    assert.equal(formatWorkingMemoryBlock([]), "");
  });

  it("formatWorkingMemoryBlock includes callId tool and suggestedColumns", () => {
    const entries: WorkingMemoryEntry[] = [
      {
        callId: "a-1",
        tool: "retrieve_semantic_context",
        ok: true,
        summaryPreview: "hello world",
        suggestedColumns: ["Revenue", "Region"],
        slots: { suggested_columns: "Revenue,Region" },
      },
    ];
    const b = formatWorkingMemoryBlock(entries);
    assert.match(b, /callId=a-1/);
    assert.match(b, /suggestedColumns=\[Revenue, Region\]/);
    assert.match(b, /slots=/);
  });

  it("sortPlanStepsByDependency orders dependents after prerequisites", () => {
    const steps: PlanStep[] = [
      { id: "c", tool: "build_chart", args: { x: "a", y: "b", type: "bar" }, dependsOn: "b" },
      { id: "a", tool: "get_schema_summary", args: {} },
      { id: "b", tool: "retrieve_semantic_context", args: { query: "x" }, dependsOn: "a" },
    ];
    const sorted = sortPlanStepsByDependency(steps);
    assert.ok(sorted);
    assert.deepEqual(
      sorted!.map((s) => s.id),
      ["a", "b", "c"]
    );
  });

  it("sortPlanStepsByDependency returns null on cycle", () => {
    const steps: PlanStep[] = [
      { id: "x", tool: "get_schema_summary", args: {}, dependsOn: "y" },
      { id: "y", tool: "get_schema_summary", args: {}, dependsOn: "x" },
    ];
    assert.equal(sortPlanStepsByDependency(steps), null);
  });

  it("sortPlanStepsByDependency returns null when dependsOn missing", () => {
    const steps: PlanStep[] = [
      { id: "a", tool: "build_chart", args: {}, dependsOn: "ghost" },
    ];
    assert.equal(sortPlanStepsByDependency(steps), null);
  });
});
