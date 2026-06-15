/**
 * ============================================================================
 * parallelResolve.ts — run a skill's independent steps concurrently, up front
 * ============================================================================
 * WHAT THIS FILE DOES
 *   When a skill's plan is marked parallelizable, this helper runs its
 *   "independent" steps at the same time and caches the results. "Independent"
 *   means a step has no `dependsOn` (it does not need any other step's output
 *   first). It fires up to `maxParallel` of those steps together with
 *   Promise.all and returns a map of step.id -> ToolResult. The agent's main
 *   loop later checks this map first, so each tool runs exactly once even
 *   though the slower per-step reflection/verification passes still happen one
 *   at a time.
 *
 * WHY IT MATTERS
 *   Skills often emit several read-only data queries that don't depend on each
 *   other (e.g. a correlation and two breakdowns). Running them serially wastes
 *   time; doing them concurrently up front cuts latency on multi-step answers
 *   without changing the serial reasoning that follows.
 *
 * KEY PIECES
 *   - ExecuteStep — function type that actually runs one step into a ToolResult.
 *   - ParallelResolveResult — { resolved map, stepIds executed, elapsedMs }.
 *   - preResolveParallelSteps — the worker. Returns empty (no-op) unless the
 *     invocation is parallelizable AND has at least 2 independent steps. Each
 *     step's failure is contained: an error becomes a { ok:false, summary }
 *     result in the map rather than rejecting the whole batch.
 *
 * HOW IT CONNECTS
 *   Called by the agent step loop after a skill is expanded (SkillInvocation
 *   from ./types.js). PlanStep and ToolResult types come from ../types.js and
 *   ../toolRegistry.js; the actual per-step execution is delegated back through
 *   the passed-in `execute` callback (the registry's executor).
 */
import type { PlanStep } from "../types.js";
import type { ToolResult } from "../toolRegistry.js";
import type { SkillInvocation } from "./types.js";
import { errorMessage } from "../../../../utils/errorMessage.js";

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
        const msg = errorMessage(err);
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
