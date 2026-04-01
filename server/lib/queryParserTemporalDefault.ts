import type { DataSummary } from "../shared/schema.js";
import type { ParsedQuery } from "../shared/queryTypes.js";
import {
  hasExplicitBreakdownOrGrain,
  vagueTemporalTrendQuestion,
} from "./questionAggregationPolicy.js";

const TEMPORAL_GROUP_BY_RE = /^__tf_(date|week|month|quarter|half_year|year)__/;

type ParsedWithAgg = ParsedQuery & {
  rawQuestion?: string;
  confidence?: number;
};

/**
 * When the user asks a vague trend/over-time question with aggregations but no explicit grain,
 * default to monthly bucketing on a single date dimension (aligned with execute_query_plan patch).
 */
export function applyVagueTrendDefaultAggregation(
  parsed: ParsedWithAgg,
  question: string,
  summary?: DataSummary
): void {
  if (!summary?.dateColumns?.length) return;
  if (parsed.dateAggregationPeriod) return;
  const q = question.trim();
  if (!q) return;
  if (!vagueTemporalTrendQuestion(q)) return;
  if (hasExplicitBreakdownOrGrain(q)) return;
  if (/\b(daily|per\s+day|each\s+day|day\s+by\s+day)\b/i.test(q)) return;

  const aggs = parsed.aggregations;
  if (!aggs?.length) return;

  const gb = parsed.groupBy ?? [];
  const dateSet = new Set(summary.dateColumns);
  const onlyDateOrTemporalFacet = gb.every(
    (c) => dateSet.has(c) || TEMPORAL_GROUP_BY_RE.test(c)
  );
  if (gb.length > 0 && !onlyDateOrTemporalFacet) return;

  parsed.dateAggregationPeriod = "month";
  if (gb.length === 0) {
    parsed.groupBy = [summary.dateColumns[0]];
  }
}
