import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  groupSortedStepsForExecution,
  sortPlanStepsByDependency,
} from "../lib/agents/runtime/workingMemory.js";
import type { PlanStep } from "../lib/agents/runtime/types.js";

function step(id: string, opts: Partial<PlanStep> = {}): PlanStep {
  return { id, tool: "t", args: {}, ...opts };
}

describe("groupSortedStepsForExecution", () => {
  it("returns empty array for empty input", () => {
    assert.deepStrictEqual(groupSortedStepsForExecution([]), []);
  });

  it("each singleton step becomes its own group", () => {
    const steps = [step("a"), step("b"), step("c")];
    const groups = groupSortedStepsForExecution(steps);
    assert.strictEqual(groups.length, 3);
    assert.strictEqual(groups[0][0].id, "a");
    assert.strictEqual(groups[1][0].id, "b");
    assert.strictEqual(groups[2][0].id, "c");
  });

  it("consecutive steps with same parallelGroup are grouped together", () => {
    const steps = [
      step("a", { parallelGroup: "pg1" }),
      step("b", { parallelGroup: "pg1" }),
      step("c", { parallelGroup: "pg1" }),
    ];
    const groups = groupSortedStepsForExecution(steps);
    assert.strictEqual(groups.length, 1);
    assert.strictEqual(groups[0].length, 3);
    assert.deepStrictEqual(groups[0].map((s) => s.id), ["a", "b", "c"]);
  });

  it("non-consecutive same parallelGroup do NOT merge", () => {
    const steps = [
      step("a", { parallelGroup: "pg1" }),
      step("b"),
      step("c", { parallelGroup: "pg1" }),
    ];
    const groups = groupSortedStepsForExecution(steps);
    assert.strictEqual(groups.length, 3);
    assert.strictEqual(groups[0].length, 1);
    assert.strictEqual(groups[1].length, 1);
    assert.strictEqual(groups[2].length, 1);
  });

  it("mixed: one parallel group flanked by singletons", () => {
    const steps = [
      step("a"),
      step("b", { parallelGroup: "pg1" }),
      step("c", { parallelGroup: "pg1" }),
      step("d"),
    ];
    const groups = groupSortedStepsForExecution(steps);
    assert.strictEqual(groups.length, 3);
    assert.deepStrictEqual(groups[0].map((s) => s.id), ["a"]);
    assert.deepStrictEqual(groups[1].map((s) => s.id), ["b", "c"]);
    assert.deepStrictEqual(groups[2].map((s) => s.id), ["d"]);
  });

  it("two separate parallel groups", () => {
    const steps = [
      step("a", { parallelGroup: "pg1" }),
      step("b", { parallelGroup: "pg1" }),
      step("c", { parallelGroup: "pg2" }),
      step("d", { parallelGroup: "pg2" }),
    ];
    const groups = groupSortedStepsForExecution(steps);
    assert.strictEqual(groups.length, 2);
    assert.deepStrictEqual(groups[0].map((s) => s.id), ["a", "b"]);
    assert.deepStrictEqual(groups[1].map((s) => s.id), ["c", "d"]);
  });

  it("single step with parallelGroup is its own group", () => {
    const steps = [step("a", { parallelGroup: "pg1" })];
    const groups = groupSortedStepsForExecution(steps);
    assert.strictEqual(groups.length, 1);
    assert.strictEqual(groups[0].length, 1);
  });
});

describe("sortPlanStepsByDependency with parallelGroup", () => {
  it("parallel group steps (no dependsOn) preserve original order", () => {
    const steps = [
      step("a", { parallelGroup: "pg1" }),
      step("b", { parallelGroup: "pg1" }),
      step("c"),
    ];
    const sorted = sortPlanStepsByDependency(steps);
    assert.ok(sorted !== null);
    assert.deepStrictEqual(sorted!.map((s) => s.id), ["a", "b", "c"]);
  });

  it("dependency across parallel groups respected", () => {
    const steps = [
      step("a", { parallelGroup: "pg1" }),
      step("b", { parallelGroup: "pg1" }),
      step("c", { dependsOn: "a" }),
    ];
    const sorted = sortPlanStepsByDependency(steps);
    assert.ok(sorted !== null);
    const ids = sorted!.map((s) => s.id);
    assert.ok(ids.indexOf("a") < ids.indexOf("c"));
  });

  it("parallelGroup is preserved on sorted output steps", () => {
    const steps = [
      step("a", { parallelGroup: "pg1" }),
      step("b", { parallelGroup: "pg1" }),
    ];
    const sorted = sortPlanStepsByDependency(steps);
    assert.ok(sorted !== null);
    assert.strictEqual(sorted![0].parallelGroup, "pg1");
    assert.strictEqual(sorted![1].parallelGroup, "pg1");
  });
});

describe("O2: hypothesisId round-trips through PlanStep", () => {
  it("hypothesisId is preserved when set", () => {
    const s = step("s1", { hypothesisId: "h1" });
    assert.strictEqual(s.hypothesisId, "h1");
    const sorted = sortPlanStepsByDependency([s]);
    assert.ok(sorted !== null);
    assert.strictEqual(sorted![0].hypothesisId, "h1");
  });

  it("hypothesisId is undefined when omitted", () => {
    const s = step("s1");
    assert.strictEqual(s.hypothesisId, undefined);
  });

  it("multiple steps can carry different hypothesisIds", () => {
    const steps = [
      step("a", { parallelGroup: "pg1", hypothesisId: "h1" }),
      step("b", { parallelGroup: "pg1", hypothesisId: "h2" }),
    ];
    const sorted = sortPlanStepsByDependency(steps);
    assert.ok(sorted !== null);
    assert.strictEqual(sorted![0].hypothesisId, "h1");
    assert.strictEqual(sorted![1].hypothesisId, "h2");
  });
});
