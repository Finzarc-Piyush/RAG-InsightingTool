/**
 * ============================================================================
 * coalescePlanSteps.ts — merges duplicate-shaped query steps into one
 * ============================================================================
 * WHAT THIS FILE DOES
 *   The planner sometimes produces several `execute_query_plan` steps that query
 *   the data in the exact same SHAPE — same groupBy, same filters, same sort,
 *   limit, date bucketing, and parallel group — but compute a different number
 *   (e.g. one step sums Sales, the next sums Units, grouped by the same Region).
 *   This pure function spots those same-shape steps and merges them into a single
 *   step whose `aggregations[]` list is the union of the originals (de-duped by
 *   column+operation+alias). DuckDB (the in-process SQL engine) can compute many
 *   aggregations in one query natively.
 *
 * WHY IT MATTERS
 *   Without merging, each step renders its own pivot card and near-identical bar
 *   chart — visually redundant and wasteful. After merging, the user gets ONE
 *   pivot card with several value columns. It also preserves provenance: every
 *   merged step's `hypothesisId` flows into a `hypothesisIds[]` array so the
 *   loop's hypothesis-resolution pass can still mark each original resolved.
 *
 * KEY PIECES
 *   - coalesceQueryPlanSteps — the merge pass over an array of PlanSteps.
 *   - isCoalesceEnabled — env kill switch (AGENT_COALESCE_SAME_SHAPE_QUERIES);
 *     defaults to ON.
 *   - queryPlanShapeSignature (internal) — stable string key of a step's shape;
 *     returns null for non-mergeable steps (wrong tool, missing plan, or has a
 *     dependsOn edge — keeping dependency order wins over merging). Cross-
 *     parallelGroup merges are rejected because the group id is in the signature.
 *
 * HOW IT CONNECTS
 *   Operates on PlanStep (types.js). Called by the planning stage of the agent
 *   loop before the steps are executed.
 */
import type { PlanStep } from "./types.js";

export function isCoalesceEnabled(): boolean {
  const raw = process.env.AGENT_COALESCE_SAME_SHAPE_QUERIES;
  if (raw === undefined || raw === "") return true;
  return String(raw).trim().toLowerCase() !== "false";
}

interface AggLike {
  column: string;
  operation: string;
  alias?: string;
}

/**
 * Stable signature of a query-plan step's "shape". Two steps with the same
 * signature can safely have their aggregations merged.
 *
 * Returns `null` for non-mergeable steps (wrong tool, missing plan, has
 * dependsOn — preserving dependency edges takes precedence over merging).
 */
function queryPlanShapeSignature(step: PlanStep): string | null {
  if (step.tool !== "execute_query_plan") return null;
  if (step.dependsOn) return null;
  const plan = step.args?.plan as Record<string, unknown> | undefined;
  if (!plan || typeof plan !== "object") return null;

  const groupBy = Array.isArray(plan.groupBy)
    ? [...(plan.groupBy as string[])].sort().join(",")
    : "";
  const dateAgg = (plan.dateAggregationPeriod ?? "") as string;
  const limit = plan.limit == null ? "" : String(plan.limit);
  const sort = Array.isArray(plan.sort)
    ? (plan.sort as { column: string; direction: string }[])
        .map((s) => `${s.column}:${s.direction}`)
        .join("|")
    : "";
  const filters = Array.isArray(plan.dimensionFilters)
    ? (plan.dimensionFilters as {
        column: string;
        op: string;
        values: string[];
        match?: string;
      }[])
        .map((f) => {
          const vals = Array.isArray(f.values)
            ? [...f.values].sort().join(",")
            : "";
          return `${f.column}:${f.op}:${vals}:${f.match ?? ""}`;
        })
        .sort()
        .join(";")
    : "";
  const pg = step.parallelGroup ?? "__none__";
  return `${pg}|gb=${groupBy}|date=${dateAgg}|limit=${limit}|sort=${sort}|filters=${filters}`;
}

function aggKey(a: AggLike): string {
  return `${a.column}::${a.operation}::${a.alias ?? ""}`;
}

/**
 * Coalesce same-shape `execute_query_plan` steps. Merged steps keep the
 * position of the first occurrence; aggregations are de-duped by
 * (column, operation, alias). All matching `hypothesisId`s flow into
 * `hypothesisIds[]` on the merged step so the loop's hypothesis-resolution
 * pass can mark every original hypothesis resolved.
 *
 * Cross-`parallelGroup` merges are rejected (the signature includes group id).
 * Steps with `dependsOn` are passed through untouched.
 */
export function coalesceQueryPlanSteps(steps: PlanStep[]): PlanStep[] {
  if (!isCoalesceEnabled()) return steps;
  if (steps.length < 2) return steps;

  const out: PlanStep[] = [];
  const sigToIdx = new Map<string, number>();

  for (const step of steps) {
    const sig = queryPlanShapeSignature(step);
    if (sig === null) {
      out.push(step);
      continue;
    }

    const existingIdx = sigToIdx.get(sig);
    if (existingIdx === undefined) {
      sigToIdx.set(sig, out.length);
      // Seed hypothesisIds so we have a uniform shape downstream.
      const seedIds: string[] = step.hypothesisId ? [step.hypothesisId] : [];
      out.push(seedIds.length > 0 ? { ...step, hypothesisIds: seedIds } : step);
      continue;
    }

    const existing = out[existingIdx]!;
    const existingPlan = existing.args.plan as Record<string, unknown>;
    const incomingPlan = step.args.plan as Record<string, unknown>;
    const existingAggs = (existingPlan.aggregations ?? []) as AggLike[];
    const incomingAggs = (incomingPlan.aggregations ?? []) as AggLike[];

    const seen = new Set(existingAggs.map(aggKey));
    const mergedAggs: AggLike[] = [...existingAggs];
    for (const a of incomingAggs) {
      const k = aggKey(a);
      if (!seen.has(k)) {
        mergedAggs.push(a);
        seen.add(k);
      }
    }

    const hids = existing.hypothesisIds
      ? [...existing.hypothesisIds]
      : existing.hypothesisId
        ? [existing.hypothesisId]
        : [];
    if (step.hypothesisId && !hids.includes(step.hypothesisId)) {
      hids.push(step.hypothesisId);
    }

    out[existingIdx] = {
      ...existing,
      args: {
        ...existing.args,
        plan: { ...existingPlan, aggregations: mergedAggs },
      },
      ...(hids.length > 0 ? { hypothesisIds: hids } : {}),
    };
  }

  return out;
}
