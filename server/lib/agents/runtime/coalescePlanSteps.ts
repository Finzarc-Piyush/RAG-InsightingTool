/**
 * Merge consecutive `execute_query_plan` steps with identical query shape
 * (groupBy / dimensionFilters / sort / limit / dateAggregationPeriod /
 * parallelGroup) into a single step whose `aggregations[]` is the union of
 * theirs. The DuckDB executor already handles multi-aggregation natively, so
 * the merged step produces ONE pivot card with N value columns instead of
 * N separate cards rendering nearly-identical bar charts.
 *
 * Pure function — no side effects.
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
