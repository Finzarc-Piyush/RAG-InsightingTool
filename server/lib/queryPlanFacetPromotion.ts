/**
 * Rewrites execute_query_plan bodies that use raw date + dateAggregationPeriod
 * into precomputed facet groupBy (e.g. Month · Order Date) so DuckDB execution
 * stays enabled — same columns pivot uses on the materialized `data` table.
 */

import type { DataSummary } from "../shared/schema.js";
import type { QueryPlanBody } from "./queryPlanExecutor.js";
import { allowedColumnNamesForQueryPlan } from "./queryPlanExecutor.js";
import {
  facetColumnKey,
  isTemporalFacetColumnKey,
  resolveDateColumnForGroupBy,
  type TemporalFacetGrain,
} from "./temporalFacetColumns.js";

export function temporalFacetGrainFromDateAggregationPeriod(
  period: NonNullable<QueryPlanBody["dateAggregationPeriod"]>
): TemporalFacetGrain | null {
  switch (period) {
    case "day":
      return "date";
    case "week":
      return "week";
    case "month":
    case "monthOnly":
      return "month";
    case "quarter":
      return "quarter";
    case "half_year":
      return "half_year";
    case "year":
      return "year";
    default:
      return null;
  }
}

/**
 * When the plan buckets a single raw date column with dateAggregationPeriod,
 * rewrite to the canonical facet column id if the schema lists that facet
 * (materialized on DuckDB like pivot).
 */
export function promoteQueryPlanDateAggregationToFacetGroupBy(
  plan: QueryPlanBody,
  summary: DataSummary
): QueryPlanBody {
  const period = plan.dateAggregationPeriod;
  if (period == null || period === undefined) return plan;
  const groupBy = plan.groupBy;
  if (!groupBy || groupBy.length !== 1) return plan;

  const g0 = groupBy[0] ?? "";
  if (!g0 || isTemporalFacetColumnKey(g0)) return plan;

  const dateColumns = summary.dateColumns ?? [];
  const source = resolveDateColumnForGroupBy(g0, dateColumns);
  if (!source) return plan;

  const grain = temporalFacetGrainFromDateAggregationPeriod(period);
  if (!grain) return plan;

  const facetKey = facetColumnKey(source, grain);
  const allowed = allowedColumnNamesForQueryPlan(summary);
  if (!allowed.has(facetKey)) return plan;

  return {
    ...plan,
    groupBy: [facetKey],
    dateAggregationPeriod: undefined,
  };
}

/** Prefer turn-start row-level frame when the current frame lacks plan columns. */
export function pickRowLevelDataForQueryPlan(
  plan: QueryPlanBody,
  currentData: Record<string, any>[],
  turnStartDataRef: Record<string, any>[] | null | undefined
): Record<string, any>[] {
  if (!turnStartDataRef?.length || !currentData.length) return currentData;
  const row0 = currentData[0] as Record<string, any>;
  const ref0 = turnStartDataRef[0] as Record<string, any>;
  const cols = [
    ...(plan.groupBy ?? []),
    ...(plan.aggregations?.map((a) => a.column) ?? []),
    ...(plan.dimensionFilters?.map((d) => d.column) ?? []),
  ];
  for (const col of cols) {
    if (
      col &&
      !Object.prototype.hasOwnProperty.call(row0, col) &&
      Object.prototype.hasOwnProperty.call(ref0, col)
    ) {
      return turnStartDataRef;
    }
  }
  return currentData;
}
