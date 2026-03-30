import { detectPeriodFromQuery } from "./dateUtils.js";

/**
 * Policy helpers used by tool verifiers to decide when it is safe to return a
 * near-full, non-aggregated analytical frame.
 *
 * Goal: when a user asks for an "over time / trend" style question but does not
 * ask for an explicit time grain (year/month/etc.) or an explicit breakdown,
 * we allow ordered rows instead of forcing "sum by year".
 */

export function hasExplicitTimeGrain(question: string): boolean {
  return detectPeriodFromQuery(question) != null;
}

export function hasExplicitBreakdownOrGrain(question: string): boolean {
  // Time grain counts as explicit grain/bucketing.
  if (hasExplicitTimeGrain(question)) return true;

  const q = question.toLowerCase();

  // Explicit breakdown patterns: by/per/group by/breakdown.
  // We keep this intentionally narrow to avoid blocking "over time" questions
  // that only mention a time intent without a breakdown.
  if (/\b(group\s+by|breakdown)\b/i.test(q)) return true;
  if (/\b(by|per)\b/i.test(q)) return true;

  return false;
}

/**
 * "Vague temporal trend" means the question asks about time evolution, but does
 * not request an explicit time grain (year/month/etc.).
 *
 * Note: this does NOT consider breakdown dimensions; that is handled separately
 * via `hasExplicitBreakdownOrGrain`.
 */
export function vagueTemporalTrendQuestion(question: string): boolean {
  const q = question.toLowerCase();

  const timeIntent = /\b(over\s*time|overtime|trend|trends|evolution|change|changes|growth|decline|develop)\b/i.test(
    q
  );
  if (!timeIntent) return false;

  // If the question already implies an explicit grain (year/month/...), we
  // should not allow wide non-aggregated responses.
  if (hasExplicitTimeGrain(question)) return false;

  return true;
}

export function shouldAllowWideWithoutAggRejection(question: string): boolean {
  // Plan rule:
  // - Skip rejection when `vagueTemporalTrendQuestion(question) && !explicitBreakdownOrGrainQuestion(question)`
  return vagueTemporalTrendQuestion(question) && !hasExplicitBreakdownOrGrain(question);
}

export function wideWithoutAggCondition(
  inputRowCount: number,
  outputRowCount: number,
  appliedAggregation: boolean
): boolean {
  if (appliedAggregation) return false;
  return (
    (inputRowCount >= 50 && outputRowCount === inputRowCount) ||
    (inputRowCount >= 500 && outputRowCount / inputRowCount >= 0.97)
  );
}

export function shouldRejectWideWithoutAgg(args: {
  question: string;
  inputRowCount: number;
  outputRowCount: number;
  appliedAggregation: boolean;
}): boolean {
  const wide = wideWithoutAggCondition(
    args.inputRowCount,
    args.outputRowCount,
    args.appliedAggregation
  );
  if (!wide) return false;

  // If we want to allow ordered time series without aggregation, do not reject.
  return !shouldAllowWideWithoutAggRejection(args.question);
}

