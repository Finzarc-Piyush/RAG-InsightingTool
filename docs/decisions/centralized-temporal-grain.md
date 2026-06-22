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

## Sub-day extension (Wave H1–H6) — hour / hour-of-day / minute

The 6-grain vocabulary (`date`…`year`) was extended **below the day** to answer
"logins per hour", "average by hour of day", "peak hour", and intraday timelines —
**globally, through this same authority**, and **dynamically from the question** (no
pre-determined bins).

Key design choices:

- **Never materialized.** The codebase already separates the *reasoning* vocabulary
  (`TemporalFacetGrain` type) from the *materialization* list (the `GRAINS` array that
  writes `Month · Date` columns at ingest). Sub-day grains were added to the TYPE and the
  inline expr (`facetColumnInlineDuckDbExpr` → `date_trunc('hour'…)` / `EXTRACT(hour…)` /
  `strftime` over a TIMESTAMP, with a `TRY_CAST(… AS TIME)` arm for pure time-of-day
  columns) but **deliberately NOT to `GRAINS`** — so no `Hour · X` column is ever
  pre-written. They are computed on the fly, which is exactly "bucket dynamically, no
  pre-determined buckets." `GRAIN_RANK` carries them (negative ranks, finer than `date`);
  `GRAINS_FINE_TO_COARSE` does NOT (the cardinality/refinement tiers only pick materialized
  facets). `hour_of_day` is cyclical (0–23, aggregated across days), intent-/explicit-only,
  exactly like the existing `monthOnly`.
- **Gated on a real signal.** A new per-column `dateRange.temporalResolution: 'day' |
  'sub_day'` flag (set at ingest only when a column has ≥2 DISTINCT non-midnight times) is
  the gate every sub-day branch checks. A pure-daily column can never be promoted to an hour
  axis — set uniformly on every ingest path (`createDataSummary` + `deriveDateRangeFromRows`,
  so the columnar/Snowflake/reload path agrees; invariant L-019).
- **Absolute vs cyclical, decided by span.** Intent detection maps explicitly-cyclical
  phrasing ("peak/busiest hour", "time of day", "by hour of day") → `hour_of_day`; a bare
  "hourly"/"by hour" → `hour`, which the authority **downgrades to `hour_of_day` when the
  data spans multiple days** (confirmed product default) and keeps absolute on a single day.
  A single intraday day (which used to collapse every calendar facet to one Month dot) now
  resolves to an absolute hourly timeline.
- **Ingest fidelity.** `parseFlexibleDate` previously rejected space-separated datetimes
  (`"2026-06-22 14:30"` → null), silently dropping the time; it now parses them and stores
  intraday values as a naive wall-clock `YYYY-MM-DD HH:MM:SS` string (not UTC `toISOString()`,
  which shifted the hour on non-UTC hosts) so `EXTRACT(hour…)` returns the hour the user typed.
- **Enforced by I11.** New `absent` checks keep `date_trunc('hour'` / `EXTRACT(hour` out of
  the chart builders — sub-day SQL lives only in the centralized inline expr.

`sub_day_grain` was removed from `TEMPORAL_CAPABILITY_GAPS`; `hour`/`hour_of_day`/`minute`
are in `SUPPORTED_DATE_AGGREGATION_PERIODS`. (Arbitrary N-minute bins, e.g. 15-min, remain a
fast-follow — reachable today via `run_readonly_sql` `time_bucket`.)

## Recent changes

- **2026-06-18 · The columnar ingest path was still STARVING the authority of its candidate
  list (regression of the very bug this ADR prevents, through a new gap).** The authority is
  the sole *decider*, but it enumerates candidate time-axes ONLY from `summary.columns`
  (every caller passes `summary.columns.map(c => c.name)` as `availableColumns`). The
  in-memory [`createDataSummary`](../../server/lib/fileParser.ts) merges the derived facet
  columns (`Day · Date`, …) INTO `summary.columns`; the columnar / large-file / metadata-reload
  [`metadataService.convertToDataSummary`](../../server/lib/metadataService.ts) listed them
  ONLY in `summary.temporalFacetColumns` and never in `columns`. So on that path the authority
  saw no `Day · Date` candidate → `bySourceGrain` empty → `source:"none"` → the dashboard
  sweep fell back to the raw date column, which [`chartGenerator`](../../server/lib/chartGenerator.ts)
  hard-buckets to Month → **one Month dot for a single month of daily data.** Fix: `convertToDataSummary`
  now merges the facet column infos into `columns` (unconditionally — the columnar facets are
  virtual, computed inline via `facetColumnInlineDuckDbExpr`, so always "available"), making the
  two ingest paths byte-equivalent for facet enumeration. Tested by
  [`convertToDataSummaryFacetColumns.test.ts`](../../server/tests/convertToDataSummaryFacetColumns.test.ts).
- **Companion hardening in the authority:** `bucketCount` no longer treats a materialized count
  of `0` (facet NAME present but values all-null on the sampled rows — e.g. a virtual columnar
  facet) as authoritative; it falls through to the span-derived count when a real date span
  exists, so a present-but-unmaterialized daily facet plus a 29-day span still resolves to Day.
  The L-007 all-null-coarse-grain guard is preserved because a label-only column (quarterly
  `Period`) yields no parseable span, so the fallthrough never fires there.
