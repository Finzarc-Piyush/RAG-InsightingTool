import type { PlanStep } from "./types.js";
import type { InferredFilter } from "../utils/inferFiltersFromQuestion.js";

/** Tools that accept `dimensionFilters` at args[plan].dimensionFilters. */
const NESTED_PLAN_TOOLS = new Set(["execute_query_plan"]);
/** Tools that accept `dimensionFilters` at the top level of args. */
const TOP_LEVEL_FILTER_TOOLS = new Set([
  "run_correlation",
  "run_segment_driver_analysis",
  "breakdown_ranking",
  "run_two_segment_compare",
]);

function dimensionFilterHost(step: PlanStep): Record<string, unknown> | null {
  if (NESTED_PLAN_TOOLS.has(step.tool)) {
    const plan = step.args?.plan;
    return plan && typeof plan === "object" ? (plan as Record<string, unknown>) : null;
  }
  if (TOP_LEVEL_FILTER_TOOLS.has(step.tool)) {
    return (step.args as Record<string, unknown>) ?? null;
  }
  return null;
}

/**
 * Inject inferred filters into any step that accepts dimensionFilters but
 * didn't emit one for an inferred column. Brief-emitted or planner-emitted
 * filters for the same (column, op) are preserved — this only fills gaps.
 * Returns the list of columns that were injected (for logging / tests).
 */
export function ensureInferredFiltersOnStep(
  step: PlanStep,
  inferredFilters: InferredFilter[] | undefined
): string[] {
  if (!inferredFilters?.length) return [];
  const host = dimensionFilterHost(step);
  if (!host) return [];

  const existing = Array.isArray(host.dimensionFilters)
    ? (host.dimensionFilters as Array<Record<string, unknown>>)
    : [];
  const injected: string[] = [];
  const seen = new Set<string>();
  for (const f of existing) {
    if (!f || typeof f !== "object") continue;
    const col = typeof f.column === "string" ? f.column : null;
    const op = typeof f.op === "string" ? f.op : "in";
    if (col) seen.add(`${col}|${op}`);
  }
  const next = [...existing];
  for (const f of inferredFilters) {
    const key = `${f.column}|${f.op}`;
    if (seen.has(key)) continue;
    next.push({
      column: f.column,
      op: f.op,
      values: f.values,
      match: f.match,
    });
    injected.push(f.column);
  }
  if (injected.length) host.dimensionFilters = next;
  return injected;
}

/**
 * Pure check used by the verifier backstop: returns the names of inferred
 * filter columns that are absent from every step that could accept them.
 * Empty array means all inferred filters are represented somewhere in the
 * plan (or no inferred filters exist).
 */
export function checkMissingInferredFilters(
  steps: PlanStep[],
  inferredFilters: InferredFilter[] | undefined
): string[] {
  if (!inferredFilters?.length) return [];
  const covered = new Set<string>();
  const applicableStepCount = steps.reduce(
    (n, s) => n + (dimensionFilterHost(s) ? 1 : 0),
    0
  );
  if (applicableStepCount === 0) return [];
  for (const s of steps) {
    const host = dimensionFilterHost(s);
    if (!host) continue;
    const filters = Array.isArray(host.dimensionFilters)
      ? (host.dimensionFilters as Array<Record<string, unknown>>)
      : [];
    for (const f of filters) {
      if (!f || typeof f !== "object") continue;
      if (typeof f.column === "string") covered.add(f.column);
    }
  }
  return inferredFilters
    .map((f) => f.column)
    .filter((col) => !covered.has(col));
}

/**
 * Repairs common planner schema drift for execute_query_plan.
 *
 * Current observed failure:
 * - dimensionFilters: [{ column: "...", values: ["..."] }]
 * - missing required field: dimensionFilters[].op ("in" | "not_in")
 *
 * We default op to "in" when it's missing/undefined so the plan can pass
 * Zod validation and reach tool execution.
 */
export function repairExecuteQueryPlanDimensionFilters(step: PlanStep): void {
  if (step.tool !== "execute_query_plan") return;

  const plan = step.args?.plan;
  if (!plan || typeof plan !== "object") return;

  const dimensionFilters = (plan as any).dimensionFilters;
  if (!Array.isArray(dimensionFilters)) return;

  for (const d of dimensionFilters) {
    if (!d || typeof d !== "object") continue;

    const op = (d as any).op;
    const operator = (d as any).operator;
    if (op == null && typeof operator === "string") {
      // LLM sometimes uses operator instead of op.
      (d as any).op = operator;
    }

    if (typeof (d as any).op !== "string") {
      // Schema requires op, so choose a conservative default.
      (d as any).op = "in";
    } else if ((d as any).op !== "in" && (d as any).op !== "not_in") {
      // Invalid enum => default to "in" to avoid rejecting whole plan.
      (d as any).op = "in";
    }

    const values = (d as any).values;
    if (!Array.isArray(values)) {
      if (typeof values === "string") (d as any).values = [values];
      else if (values == null) (d as any).values = [];
      else (d as any).values = [String(values)];
    } else {
      (d as any).values = values.map((v: unknown) => (typeof v === "string" ? v : String(v)));
    }
  }
}

/**
 * Repairs execute_query_plan.sort schema drift.
 *
 * Observed failures:
 * - sort: [{ column: "..." }] (missing direction)
 * - sort: [{ field: "...", order: "ascending" }] (alias keys/values)
 *
 * Behavior:
 * - Normalize aliases (`field` -> `column`, `order` -> `direction`)
 * - Default/normalize direction to "asc" when missing or invalid
 * - Drop entries that still do not have a valid non-empty column name
 */
export function repairExecuteQueryPlanSort(step: PlanStep): void {
  if (step.tool !== "execute_query_plan") return;

  const plan = step.args?.plan;
  if (!plan || typeof plan !== "object") return;

  const sort = (plan as any).sort;
  if (!Array.isArray(sort)) return;

  const normalized: Array<{ column: string; direction: "asc" | "desc" }> = [];
  for (const raw of sort) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;

    const candidateColumn =
      (typeof item.column === "string" && item.column) ||
      (typeof item.field === "string" && item.field) ||
      "";
    const column = candidateColumn.trim();
    if (!column) continue;

    const rawDir =
      (typeof item.direction === "string" && item.direction) ||
      (typeof item.order === "string" && item.order) ||
      "";
    const dir = rawDir.trim().toLowerCase();
    const direction: "asc" | "desc" =
      dir === "desc" || dir === "descending" ? "desc" : "asc";

    normalized.push({ column, direction });
  }

  (plan as any).sort = normalized;
}

