import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { PlanStep } from "../lib/agents/runtime/types.js";
import type { ToolResult } from "../lib/agents/runtime/toolRegistry.js";
import type { SkillInvocation } from "../lib/agents/runtime/skills/index.js";
import { preResolveParallelSteps } from "../lib/agents/runtime/skills/parallelResolve.js";

const okResult = (summary: string): ToolResult => ({ ok: true, summary });

const step = (id: string, opts: Partial<PlanStep> = {}): PlanStep => ({
  id,
  tool: "noop",
  args: {},
  ...opts,
});

const invocation = (
  steps: PlanStep[],
  parallelizable: boolean
): SkillInvocation => ({
  id: "inv-test",
  label: "test",
  steps,
  parallelizable,
});

describe("preResolveParallelSteps", () => {
  it("is a no-op when parallelizable is false", async () => {
    const invoc = invocation([step("a"), step("b")], false);
    let calls = 0;
    const out = await preResolveParallelSteps(
      invoc,
      async () => {
        calls++;
        return okResult("x");
      },
      3
    );
    assert.equal(out.resolved.size, 0);
    assert.equal(calls, 0);
  });

  it("is a no-op when fewer than 2 independent steps are available", async () => {
    const invoc = invocation(
      [step("a", { dependsOn: "x" }), step("b", { dependsOn: "y" })],
      true
    );
    const out = await preResolveParallelSteps(
      invoc,
      async () => okResult("x"),
      3
    );
    assert.equal(out.resolved.size, 0);
  });

  it("runs independent steps concurrently and records their results", async () => {
    const invoc = invocation(
      [step("a"), step("b"), step("c")],
      true
    );
    let inflight = 0;
    let peak = 0;
    const execute = async (s: PlanStep) => {
      inflight++;
      peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 10));
      inflight--;
      return okResult(`ran ${s.id}`);
    };
    const out = await preResolveParallelSteps(invoc, execute, 3);
    assert.equal(out.resolved.size, 3);
    assert.equal(out.stepIds.length, 3);
    assert.ok(peak >= 2, `expected concurrent execution, peak=${peak}`);
    assert.equal(out.resolved.get("a")?.ok, true);
  });

  it("respects the maxParallel cap when more independent steps exist", async () => {
    const invoc = invocation(
      [step("a"), step("b"), step("c"), step("d"), step("e")],
      true
    );
    const out = await preResolveParallelSteps(
      invoc,
      async (s) => okResult(s.id),
      2
    );
    assert.equal(out.stepIds.length, 2);
    assert.equal(out.resolved.size, 2);
    // First two independent steps should be chosen, in order.
    assert.deepEqual(out.stepIds, ["a", "b"]);
  });

  it("excludes steps with dependsOn from the parallel batch", async () => {
    const invoc = invocation(
      [step("a"), step("b", { dependsOn: "a" }), step("c")],
      true
    );
    const ran: string[] = [];
    const out = await preResolveParallelSteps(
      invoc,
      async (s) => {
        ran.push(s.id);
        return okResult(s.id);
      },
      3
    );
    assert.deepEqual(out.stepIds.sort(), ["a", "c"]);
    assert.ok(!ran.includes("b"), "dependent step must not run in the batch");
  });

  it("captures per-step failures as ok:false results", async () => {
    const invoc = invocation([step("a"), step("b")], true);
    const out = await preResolveParallelSteps(
      invoc,
      async (s) => {
        if (s.id === "b") throw new Error("boom");
        return okResult("ok");
      },
      3
    );
    assert.equal(out.resolved.get("a")?.ok, true);
    const b = out.resolved.get("b");
    assert.ok(b);
    assert.equal(b!.ok, false);
    assert.ok(b!.summary.includes("Pre-resolve error"));
  });
});
