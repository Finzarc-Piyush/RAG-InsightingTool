/**
 * booleanIndicatorRateRepair.ts — fail-forward repair for "rate of a boolean
 * indicator" query plans.
 *
 * THE BUG IT FIXES. For a question like "build dashboard for PJP Adherence" the
 * planner often emits a multi-step plan that computes an `adherence_rate` and
 * then references it as a COLUMN in later breakdown steps
 * (`aggregations: [{ column: "adherence_rate", operation: "avg" }]`). But
 * `adherence_rate` is not a real column — `PJP Adherence` is a BOOLEAN INDICATOR.
 * The planner's column validator rejects `invalid_column_ref:adherence_rate`,
 * and after a retry the whole turn aborts with "I couldn't complete this
 * analysis" — no charts, no answer.
 *
 * THE FIX. This rewrites an INVALID `<x>_rate`-style aggregation column into the
 * correct, storage-agnostic boolean-rate shape — the same countIf-ratio the
 * planner prompt's PCT1 rule documents:
 *   aggregations: [
 *     { operation: "countIf", column: "*", predicate: [{column: <indicator>, op: "in", values: <positive>}], alias: "<base>__matching" },
 *     { operation: "countIf", column: "*", predicate: [{column: <indicator>, op: "in", values: <positive ∪ negative>}], alias: "<base>__total" },
 *   ],
 *   computedAggregations: [{ alias: "<original name>", expression: "<base>__matching / <base>__total" }]
 * — preserving the planner's groupBy, so a per-cluster / per-type breakdown
 * yields a real adherence rate per group instead of aborting.
 *
 * SAFETY (fail-forward). It only touches an aggregation whose column is NOT in
 * the schema (i.e. one that would otherwise be rejected and abort the turn) AND
 * that token-matches a boolean indicator carrying explicit positive values. It
 * never rewrites a valid plan, so the worst case is unchanged (still rejected);
 * the best case turns an abort into a correct rate.
 */
import type { DataSummary } from "../../../shared/schema.js";
import type { QueryPlanBody } from "../../queryPlanExecutor.js";

/** Tokens that name the *metric kind* (rate/share/…) rather than the subject. */
const GENERIC_RATE_TOKENS = new Set([
  "rate", "pct", "percent", "percentage", "ratio", "share",
  "avg", "average", "mean", "of", "per", "the", "a",
]);

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** Subject tokens of a name (drops the generic metric-kind words). */
function subjectTokens(s: string): Set<string> {
  return new Set(tokenize(s).filter((t) => !GENERIC_RATE_TOKENS.has(t)));
}

type BooleanIndicator = {
  name: string;
  tokens: Set<string>;
  positives: string[];
  negatives: string[];
  sentinels: string[];
};

function collectBooleanIndicators(summary: DataSummary): BooleanIndicator[] {
  const out: BooleanIndicator[] = [];
  for (const c of summary.columns ?? []) {
    const ind = (c as { indicator?: {
      kind?: string;
      positiveValues?: string[];
      negativeValues?: string[];
      sentinelValues?: string[];
    } }).indicator;
    if (ind?.kind !== "boolean") continue;
    const positives = ind.positiveValues ?? [];
    if (positives.length === 0) continue; // can't build a correct predicate
    out.push({
      name: c.name,
      tokens: subjectTokens(c.name),
      positives,
      negatives: ind.negativeValues ?? [],
      sentinels: ind.sentinelValues ?? [],
    });
  }
  return out;
}

/** Best token-overlap match for a missing column among boolean indicators. */
function matchIndicator(
  missingColumn: string,
  indicators: BooleanIndicator[]
): BooleanIndicator | null {
  const miss = subjectTokens(missingColumn);
  if (miss.size === 0) return null;
  let best: BooleanIndicator | null = null;
  let bestScore = 0;
  for (const ind of indicators) {
    let score = 0;
    for (const t of miss) if (ind.tokens.has(t)) score++;
    if (score > bestScore) {
      bestScore = score;
      best = ind;
    }
  }
  return bestScore > 0 ? best : null;
}

type Agg = {
  column?: string;
  operation?: string;
  alias?: string;
  predicate?: unknown[];
  perDimension?: string;
};

/**
 * Rewrite invalid boolean-indicator-rate aggregation refs into the countIf-ratio
 * shape. Returns the (possibly) repaired plan and whether anything changed.
 * Pure — does not mutate the input plan.
 */
export function repairBooleanIndicatorRatePlan(
  plan: QueryPlanBody,
  summary: DataSummary
): { plan: QueryPlanBody; repaired: boolean } {
  const aggs = (plan?.aggregations as Agg[] | undefined) ?? [];
  if (aggs.length === 0) return { plan, repaired: false };

  const schemaCols = new Set((summary.columns ?? []).map((c) => c.name));
  const indicators = collectBooleanIndicators(summary);
  if (indicators.length === 0) return { plan, repaired: false };

  const newAggs: Agg[] = [];
  const newComputed: Array<{ alias: string; expression: string }> = [
    ...((plan.computedAggregations as Array<{ alias: string; expression: string }> | undefined) ?? []),
  ];
  let repaired = false;

  for (const agg of aggs) {
    const col = agg.column;
    const isConditional = agg.operation === "countIf" || agg.operation === "sumIf";
    const isInvalid =
      typeof col === "string" && col !== "*" && !schemaCols.has(col);
    // Only rebind otherwise-invalid, non-conditional, non-nested aggregations.
    if (!isInvalid || isConditional || agg.perDimension) {
      newAggs.push(agg);
      continue;
    }
    const ind = matchIndicator(col as string, indicators);
    if (!ind) {
      newAggs.push(agg);
      continue;
    }
    const base = (agg.alias && agg.alias.trim()) || (col as string);
    const matchAlias = `${base}__matching`;
    const totalAlias = `${base}__total`;
    const denom = Array.from(new Set([...ind.positives, ...ind.negatives])).filter(
      (v) => !ind.sentinels.includes(v)
    );
    const denomValues = denom.length > 0 ? denom : ind.positives;
    newAggs.push({
      operation: "countIf",
      column: "*",
      predicate: [{ column: ind.name, op: "in", values: ind.positives }],
      alias: matchAlias,
    });
    newAggs.push({
      operation: "countIf",
      column: "*",
      predicate: [{ column: ind.name, op: "in", values: denomValues }],
      alias: totalAlias,
    });
    // Preserve the name the planner referenced as the computed-ratio alias so
    // any sort / downstream reference to it still resolves.
    newComputed.push({ alias: col as string, expression: `${matchAlias} / ${totalAlias}` });
    repaired = true;
  }

  if (!repaired) return { plan, repaired: false };
  return {
    plan: {
      ...plan,
      aggregations: newAggs as QueryPlanBody["aggregations"],
      computedAggregations: newComputed as QueryPlanBody["computedAggregations"],
    },
    repaired: true,
  };
}
