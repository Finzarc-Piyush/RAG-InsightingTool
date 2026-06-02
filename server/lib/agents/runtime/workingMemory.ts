/**
 * ============================================================================
 * workingMemory.ts — format past steps + order plan steps for execution
 * ============================================================================
 * WHAT THIS FILE DOES
 *   Two jobs for the agent loop. (1) Format "working memory" — the recent tool
 *   calls and their results — into a compact text block the planner can read, so
 *   it knows what's already been tried. (2) Order the planner's steps for safe
 *   execution: sort them so every step runs after the steps it depends on, and
 *   group steps that are allowed to run in parallel.
 *
 * WHY IT MATTERS
 *   The planner emits steps that can reference each other ("step B needs step A
 *   first") and can mark some as parallelizable. This file turns that flat list
 *   into a correct, partly-parallel execution order — and detects impossible
 *   plans (missing or circular dependencies) so the loop can reject them.
 *
 * KEY PIECES
 *   - formatWorkingMemoryBlock(entries) — compact recap of the last 12 steps.
 *   - sortPlanStepsByDependency(steps) — topological sort; returns null on a
 *     missing or cyclic dependency.
 *   - groupSortedStepsForExecution(sorted) — bucket consecutive same-group steps
 *     into parallel batches (call AFTER sorting).
 *
 * HOW IT CONNECTS
 *   Reads WorkingMemoryEntry / PlanStep from types.js. Re-exported via index.ts;
 *   used by the act loop to schedule and recap steps. Pure functions, no I/O.
 */
import type { WorkingMemoryEntry } from "./types.js";
import type { PlanStep } from "./types.js";

const MAX_ENTRIES = 12;
const SUMMARY_PREVIEW = 1_500;

/**
 * Compact block for the planner: ids, tools, ok, suggested columns, slots, summary preview.
 */
export function formatWorkingMemoryBlock(entries: WorkingMemoryEntry[]): string {
  const slice = entries.slice(-MAX_ENTRIES);
  if (slice.length === 0) {
    return "";
  }
  const lines: string[] = [];
  let i = 1;
  for (const e of slice) {
    const cols =
      e.suggestedColumns?.length ? ` suggestedColumns=[${e.suggestedColumns.join(", ")}]` : "";
    const slots =
      e.slots && Object.keys(e.slots).length
        ? ` slots=${JSON.stringify(e.slots).slice(0, 1600)}`
        : "";
    const sum = e.summaryPreview.replace(/\s+/g, " ").slice(0, SUMMARY_PREVIEW);
    lines.push(
      `${i}. callId=${e.callId} tool=${e.tool} ok=${e.ok}${cols}${slots} summary="${sum}"`
    );
    i++;
  }
  return lines.join("\n");
}

/**
 * Converts a dependency-sorted flat step list into execution groups.
 * Consecutive steps that share the same parallelGroup run concurrently;
 * steps without a parallelGroup are singletons. Call after sortPlanStepsByDependency.
 */
export function groupSortedStepsForExecution(sorted: PlanStep[]): PlanStep[][] {
  if (sorted.length === 0) return [];
  const groups: PlanStep[][] = [];
  let current: PlanStep[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const step = sorted[i];
    const prev = sorted[i - 1];
    if (step.parallelGroup && prev.parallelGroup === step.parallelGroup) {
      current.push(step);
    } else {
      groups.push(current);
      current = [step];
    }
  }
  groups.push(current);
  return groups;
}

/**
 * Topological order: if step B has dependsOn=A, A runs before B. Missing/cyclic deps → null.
 */
export function sortPlanStepsByDependency(steps: PlanStep[]): PlanStep[] | null {
  if (steps.length === 0) {
    return steps;
  }
  const idSet = new Set(steps.map((s) => s.id));
  for (const s of steps) {
    if (s.dependsOn && !idSet.has(s.dependsOn)) {
      return null;
    }
  }

  const inDegree = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const s of steps) {
    inDegree.set(s.id, 0);
  }
  for (const s of steps) {
    if (s.dependsOn) {
      inDegree.set(s.id, (inDegree.get(s.id) || 0) + 1);
      const ch = children.get(s.dependsOn) || [];
      ch.push(s.id);
      children.set(s.dependsOn, ch);
    }
  }

  const queue: string[] = [];
  for (const s of steps) {
    if ((inDegree.get(s.id) || 0) === 0) {
      queue.push(s.id);
    }
  }

  const orderedIds: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    orderedIds.push(id);
    for (const child of children.get(id) || []) {
      const next = (inDegree.get(child) || 0) - 1;
      inDegree.set(child, next);
      if (next === 0) {
        queue.push(child);
      }
    }
  }

  if (orderedIds.length !== steps.length) {
    return null;
  }

  const byId = new Map(steps.map((s) => [s.id, s]));
  return orderedIds.map((id) => byId.get(id)!);
}
