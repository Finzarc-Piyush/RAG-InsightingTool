# Centralized temporal-grain authority (`resolveTrendGrain`)

**Status:** Accepted · Wave TG1–TG8

## Context

A dataset with only DAILY rows inside a single calendar month rendered a dashboard
tile ("Compliance Visit by Month · Date") as a single monthly point instead of a
daily trendline. A prior fix "only worked on one route."

Root cause (workflow + code verified): temporal grain was decided independently in
**four** places — the planner query patch ([queryPlanTemporalPatch.ts](../../server/lib/queryPlanTemporalPatch.ts)),
[periodColumnResolver.resolvePeriodAxis](../../server/lib/periodColumnResolver.ts)
(used by `chartFromTable` + `visualPlanner`'s deterministic fallback),
[dashboardFeatureSweep.pickStrongestDateColumn](../../server/lib/agents/runtime/dashboardFeatureSweep.ts),
and the [visualPlanner](../../server/lib/agents/runtime/visualPlanner.ts) LLM loop
(which decided nothing). Each re-implemented the span→grain heuristic differently AND
keyed off the same fragile input — the `.optional()` `summary.columns[].dateRange`,
looked up by exact source-column name. When that input was absent (the columnar/metadata
reload path [metadataService.convertToDataSummary](../../server/lib/metadataService.ts)
stripped it) or name-mismatched, every path silently degraded to the identical
Month-first default. A second trap: the visualPlanner builds from the already-aggregated
analytical table, and aggregation is **destructive** — once a query groups by Month, the
daily detail is gone, so no chart-layer fix can recover it.

## Decision

One pure authority — [`temporalGrainAuthority.resolveTrendGrain`](../../server/lib/temporalGrainAuthority.ts)
— is the SOLE decider of a chart's time-axis grain. It owns the grain primitives
(`pickTrendGrainForSpan`, `distinctBucketsForGrain`, `GRAIN_RANK`,
`DEFAULT_FACET_PREFERENCE`, `PERIOD_TO_FACET_GRAIN`; `queryPlanTemporalPatch` re-exports
them for back-compat). Decision order: **intent → span → cardinality → default**, with
two structural guards:

- **Metadata-free robustness.** Selectability counts MATERIALIZED non-null facet values
  in the charted `sample` rows (not just the optional `dateRange`), and span is derived
  from the rows (`deriveDateRangeFromRows`) when metadata is absent. So a stripped
  `dateRange` or an all-null coarse facet (quarterly `Period`, L-007) can never force a
  collapsing axis.
- **No down-convert.** Never finer than a coarser grain with the same bucket count
  (except explicit user intent).

Every builder delegates: the planner builds the span map via `buildDateRangeByColumn`;
`resolvePeriodAxis` delegates facet selection (keeping only its orthogonal raw-`Period` /
`PeriodKind` pin logic); the sweep and the visualPlanner call `resolveTrendGrain` with the
RAW frame and **build trend tiles from the raw frame** (which carries every materialized
facet) rather than a collapsed aggregate. `metadataService.convertToDataSummary` backfills
`dateRange` so the columnar/reload path no longer strips span.

Enforced by invariant **I11** ([invariants.spec.ts](../../server/scripts/invariants.spec.ts)):
chart builders must not reference `pickTrendGrainForSpan` / `DEFAULT_FACET_PREFERENCE`, and
`recommendGrainFromSpan` must not exist — so a future path that hand-rolls grain turns the
build red.

## Consequences

- A single month of daily data now plots a daily trendline everywhere, including when the
  dataset was loaded via the columnar/metadata path.
- Dashboard trend tiles now match grain to span consistently with the planner (e.g. a
  ≤1-year span → Week, was Month under the old sweep). This is the intended global
  behavior, not a regression.
- Display layer stays format-only (L-007): the authority chooses an existing canonical
  facet COLUMN, never a formatted label, and never down-converts a genuine coarse grain.
- Risk: row-derived span over a clustered sample can under-estimate; bounded to 200 rows
  and harmless for the short-span thresholds. Documented in the wave plan.
