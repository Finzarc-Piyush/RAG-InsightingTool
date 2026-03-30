import type { ParsedQuery } from "../shared/queryTypes.js";
import { detectPeriodFromQuery } from "./dateUtils.js";

export type AnalyticalLintInput = {
  tool: string;
  ok: boolean;
  question: string;
  parsed?: ParsedQuery | null;
  outputRowCount?: number;
  /** Column names on aggregated output (if known) */
  outputColumns?: string[];
};

/**
 * Deterministic hints appended to agent observations so the reflector can prefer replan/continue.
 */
export function lintAfterAnalyticalTool(input: AnalyticalLintInput): string[] {
  const notes: string[] = [];
  if (!input.ok) return notes;

  const qHint = detectPeriodFromQuery(input.question);
  const period = input.parsed?.dateAggregationPeriod;

  if (
    input.tool === "execute_query_plan" &&
    qHint &&
    period &&
    qHint !== period &&
    (qHint === "year" || qHint === "half_year" || qHint === "week")
  ) {
    notes.push(
      `[SYSTEM_VALIDATION] Question suggests "${qHint}" bucketing but plan used dateAggregationPeriod=${period}. Consider replanning with dateAggregationPeriod="${qHint}" if that matches the user.`
    );
  }

  if (
    input.outputRowCount != null &&
    input.outputRowCount > 2_500 &&
    input.parsed?.aggregations?.length
  ) {
    notes.push(
      `[SYSTEM_VALIDATION] Large analytical result (${input.outputRowCount} rows). Consider coarser dateAggregationPeriod, fewer groupBy dimensions, or dimensionFilters.`
    );
  }

  // Safety net: when a plan includes groupBy + aggregations, the output should
  // contain the groupBy dimension columns (so the client can show the breakdown).
  if (
    input.parsed?.groupBy?.length &&
    input.parsed?.aggregations?.length &&
    input.outputColumns?.length
  ) {
    const missing = input.parsed.groupBy.filter((c) => !input.outputColumns!.includes(c));
    if (missing.length > 0) {
      notes.push(
        `[SYSTEM_VALIDATION] Plan included groupBy column(s) (${missing.join(
          ", "
        )}) but they were not present in the tool output columns. Verify selection/projection preserves groupBy dimensions.`
      );
    }
  }

  return notes;
}
