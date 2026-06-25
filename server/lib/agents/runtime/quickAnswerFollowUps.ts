/**
 * ============================================================================
 * quickAnswerFollowUps.ts — suggests next-question chips after a quick lookup
 * ============================================================================
 * WHAT THIS FILE DOES
 *   For simple "quick-lookup" questions, the system answers fast without the full
 *   agentic loop. This pure function then proposes up to 3 follow-up question
 *   "chips" the user can click to dig deeper (e.g. "How has X trended over
 *   time?", "How does Y split by Z?"). It builds them from what the lookup
 *   actually did: the query's groupBy dimension, its measure, the top result row,
 *   and a sensible alternate dimension to break the data down by.
 *
 * WHY IT MATTERS
 *   It turns a one-shot lookup into a guided path toward real analysis without
 *   making the user phrase the next question themselves. Crucially it's safe: it
 *   only suggests trend questions when the dataset actually HAS a date column, so
 *   it never proposes "trend over time" on data with no time axis.
 *
 * KEY PIECES
 *   - buildQuickAnswerFollowUps — the entry point; branches on whether the plan
 *     had groupBy and/or a measure, fills templates, then tops up from the shared
 *     summary-based suggester if it has fewer than 3.
 *   - pickAlternateDimension (internal) — chooses a low-cardinality categorical
 *     column (Category before SKU) to break results down by, skipping numeric,
 *     date, identifier-shaped, and already-used columns.
 *
 * HOW IT CONNECTS
 *   Uses suggestedFollowUpsFromDataSummary (../../suggestedFollowUpsFromSummary.js)
 *   as filler, isLikelyIdentifierColumnName (../../columnIdHeuristics.js) to skip
 *   id-like columns, and types DataSummary (shared/schema.js) + QueryPlanBody
 *   (../../queryPlanExecutor.js). No LLM calls — fully deterministic.
 */

import { suggestedFollowUpsFromDataSummary } from "../../suggestedFollowUpsFromSummary.js";
import { hasDisjunctiveOr } from "../../suggestedQuestionGuard.js";
import { isLikelyIdentifierColumnName } from "../../columnIdHeuristics.js";
import type { DataSummary } from "../../../shared/schema.js";
import type { QueryPlanBody } from "../../queryPlanExecutor.js";

const MAX_FOLLOW_UPS = 3;

interface FollowUpInputs {
  plan: QueryPlanBody;
  rows: Record<string, unknown>[];
  dataSummary: DataSummary;
}

/** Surface the first non-empty string value in the top row for the given column. */
function readTopValue(rows: Record<string, unknown>[], column: string): string | undefined {
  if (rows.length === 0) return undefined;
  const v = rows[0]![column];
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return undefined;
}

/**
 * Pick a "different" dimension to suggest the user break the result down by.
 * Prefers low-cardinality categorical columns (Category before SKU) since
 * those produce useful aggregates. Skips columns already in the plan's
 * groupBy and identifier-shaped columns ("id", "sku id", uuid-ish).
 */
function pickAlternateDimension(
  dataSummary: DataSummary,
  excludeCols: string[]
): string | undefined {
  const excludeSet = new Set(excludeCols.map((c) => c.toLowerCase()));
  const numericSet = new Set(dataSummary.numericColumns ?? []);
  const dateSet = new Set(dataSummary.dateColumns ?? []);
  const candidates = (dataSummary.columns ?? [])
    .filter((c) => !numericSet.has(c.name))
    .filter((c) => !dateSet.has(c.name))
    .filter((c) => !excludeSet.has(c.name.toLowerCase()))
    .filter((c) => !isLikelyIdentifierColumnName(c.name));
  if (candidates.length === 0) return undefined;

  // Prefer lower cardinality (Category before Product) so the resulting
  // aggregate is reviewable in a single screen.
  const withCardinality = candidates.map((c) => ({
    name: c.name,
    // `topValues` captures the dominant distinct values from upload-time
    // profiling. A shorter list is a rough proxy for "this column has a
    // small set of repeated values" — exactly the shape that aggregates
    // cleanly. Columns without `topValues` get pushed to the end.
    distinct: Array.isArray(c.topValues)
      ? c.topValues.length
      : Number.POSITIVE_INFINITY,
  }));
  withCardinality.sort((a, b) => a.distinct - b.distinct);
  return withCardinality[0]?.name;
}

/** Friendly-but-stable label for an aggregation. `sum(Sales)` → `Sales`. */
function measureLabel(plan: QueryPlanBody): string | undefined {
  const agg = plan.aggregations?.[0];
  if (!agg) return undefined;
  const alias = typeof agg.alias === "string" ? agg.alias.trim() : "";
  if (alias) return alias;
  return agg.column;
}

function pushIfNew(out: string[], q: string): void {
  const norm = q.trim();
  if (!norm) return;
  // Product rule: a suggested question must never contain the ambiguous "or".
  if (hasDisjunctiveOr(norm)) return;
  if (out.some((x) => x.toLowerCase() === norm.toLowerCase())) return;
  out.push(norm);
}

export function buildQuickAnswerFollowUps({
  plan,
  rows,
  dataSummary,
}: FollowUpInputs): string[] {
  const out: string[] = [];

  const groupBy = (plan.groupBy ?? []).filter(
    (g) => typeof g === "string" && g.trim()
  );
  const measure = measureLabel(plan);
  const dateCols = dataSummary.dateColumns ?? [];
  const hasTime = dateCols.length > 0;

  if (groupBy.length > 0 && measure) {
    // Ranking shape: top-N <dim> by <measure>.
    const dim = groupBy[0]!;
    const topValue = readTopValue(rows, dim);

    pushIfNew(out, `What's driving the gap between top and bottom ${dim}?`);

    if (hasTime && topValue) {
      pushIfNew(out, `How has ${topValue}'s ${measure} trended over time?`);
    } else if (hasTime) {
      pushIfNew(out, `How has ${measure} trended over time across ${dim}?`);
    }

    const alt = pickAlternateDimension(dataSummary, [...groupBy]);
    if (alt && topValue) {
      pushIfNew(out, `Which ${alt} contributes most to ${topValue}'s ${measure}?`);
    } else if (alt) {
      pushIfNew(out, `How does ${measure} split by ${alt}?`);
    }
  } else if (measure) {
    // Aggregate shape: single number, no groupBy.
    const topDim = pickAlternateDimension(dataSummary, []);
    if (topDim) {
      pushIfNew(out, `How is ${measure} distributed across ${topDim}?`);
    }
    if (hasTime) {
      pushIfNew(out, `How has ${measure} changed over time?`);
    }
    if (topDim) {
      pushIfNew(out, `What are the top 10 ${topDim} by ${measure}?`);
    }
  } else if (groupBy.length > 0) {
    // Filter-projection shape (rows-only, no aggregation).
    const dim = groupBy[0];
    pushIfNew(out, `What drives the differences across ${dim}?`);
    const numeric = (dataSummary.numericColumns ?? [])[0];
    if (numeric) {
      pushIfNew(out, `Which ${dim} has the highest ${numeric}?`);
    }
    if (hasTime && numeric) {
      pushIfNew(out, `How has ${numeric} trended for these ${dim}?`);
    }
  }

  // Top up from the deterministic summary helper if our templates didn't
  // produce 3 suggestions (e.g. one-dimension dataset). Filters out any
  // duplicate phrasings.
  if (out.length < MAX_FOLLOW_UPS) {
    const filler = suggestedFollowUpsFromDataSummary(dataSummary);
    for (const q of filler) {
      pushIfNew(out, q);
      if (out.length >= MAX_FOLLOW_UPS) break;
    }
  }

  return out.slice(0, MAX_FOLLOW_UPS);
}
