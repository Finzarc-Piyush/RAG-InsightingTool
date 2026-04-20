/**
 * PR 1.E — pre-resolve the independent steps of a parallelizable skill
 * invocation.
 *
 * "Independent" = has no `dependsOn`. We run up to `maxParallel` such steps
 * concurrently via Promise.all and collect their `ToolResult`s into a map
 * keyed by `step.id`. The agent step loop then consumes the map before
 * falling through to `registry.execute`, so the expensive tool call
 * happens once per step even though the per-step reflector / verifier
 * pipeline stays serial.
 *
 * Failures are contained per step: an error in one step becomes a
 * `{ ok: false, summary }` result in the map, never a thrown rejection.
 */
import type { PlanStep } from "../types.js";
import type { ToolResult } from "../toolRegistry.js";
import type { SkillInvocation } from "./types.js";

export type ExecuteStep = (step: PlanStep) => Promise<ToolResult>;

export interface ParallelResolveResult {
  /** step.id → ToolResult for each step that was pre-resolved. */
  resolved: Map<string, ToolResult>;
  /** step.id list actually executed in parallel (≤ maxParallel). */
  stepIds: string[];
  /** Wall-clock time of the Promise.all call. */
  elapsedMs: number;
}

export async function preResolveParallelSteps(
  invocation: SkillInvocation,
  execute: ExecuteStep,
  maxParallel: number
): Promise<ParallelResolveResult> {
  const resolved = new Map<string, ToolResult>();
  if (invocation.parallelizable !== true) {
    return { resolved, stepIds: [], elapsedMs: 0 };
  }
  const independent = invocation.steps
    .filter((s) => !s.dependsOn)
    .slice(0, Math.max(1, maxParallel));
  if (independent.length < 2) {
    return { resolved, stepIds: [], elapsedMs: 0 };
  }
  const started = Date.now();
  const settled = await Promise.all(
    independent.map(async (step) => {
      try {
        const r = await execute(step);
        return { step, result: r };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          step,
          result: {
            ok: false,
            summary: `Pre-resolve error: ${msg}`,
          } as ToolResult,
        };
      }
    })
  );
  for (const { step, result } of settled) {
    resolved.set(step.id, result);
  }
  return {
    resolved,
    stepIds: independent.map((s) => s.id),
    elapsedMs: Date.now() - started,
  };
}
