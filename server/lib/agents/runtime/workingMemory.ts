import type { WorkingMemoryEntry } from "./types.js";
import type { PlanStep } from "./types.js";

const MAX_ENTRIES = 12;
const SUMMARY_PREVIEW = 480;

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
        ? ` slots=${JSON.stringify(e.slots).slice(0, 400)}`
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
