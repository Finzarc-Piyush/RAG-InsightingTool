import type { PlanStep } from "./types.js";

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

