# Off-day handling — weekday column + non-blocking exclude

**Problem.** In a daily series (e.g. Compliance Visit per day) a recurring weekday
sits at ≈0 (Sundays are non-working) while working days are in the thousands.
That drags averages down (the denominator counts the 0-days) and clutters charts.
Users want: a real "day of week" dimension, the option to exclude the off-day,
and to be *asked* — non-blocking.

## The four pieces

1. **`day_of_week` is a 7th MATERIALIZED temporal facet grain** — column
   `Day of week · <Date>` storing the **pure-text** weekday name ("Monday"…
   "Sunday"), derived from every date column like Month/Quarter/Week. Stored as
   text, NOT a numeric/prefixed key (the explicit ask). It rides the existing
   facet seam in [`temporalFacetColumns.ts`](../../server/lib/temporalFacetColumns.ts)
   (`GRAINS`, `FACET_GRAIN_LABEL`, the inline DuckDB `strftime(...,'%A')` arm) +
   the `day_of_week` case in [`normalizeDateToPeriod`](../../server/lib/dateUtils.ts).
   It is **cyclical**, so it is deliberately ABSENT from the trend-grain authority's
   `GRAINS_FINE_TO_COARSE` / `DEFAULT_FACET_PREFERENCE` — never auto-picked as a
   timeline axis. New grain label is **"Day of week"** (distinct from `date` =
   "Day"); the facet-header regex lists `Day of week` BEFORE `Day` in every
   alternation.

2. **Mon→Sun ordering is taught to the ONE sort authority.** Pure-text weekday
   names would otherwise alphabetize (Friday first). The single source of truth is
   [`server/shared/weekday.ts`](../../server/shared/weekday.ts) (`WEEKDAY_NAMES`,
   `WEEKDAY_ORDER`, `weekdayRank`); both [`chartSort.ts`](../../server/shared/chartSort.ts)
   (`categoryCompareCore` + `compareTemporalOrLexicalLabels`) and the pivot's own
   `compareTemporalOrLocale` ([`pivotQueryService.ts`](../../server/lib/pivotQueryService.ts))
   rank by it. `weekdayPattern.ts` consumes the same module.

3. **Detection is the existing single authority.**
   [`deriveWeekdayPattern`](../../server/lib/insightGenerator/weekdayPattern.ts)
   already grounds chart insights (data-driven, ≤15% threshold, no hardcoded
   "Sunday"). `computeOffDayHint` wraps it and rides the chart-preview +
   key-insight responses as a **transient** `offDayHint: { offWeekdays, summary,
   weekdayColumn } | null` (never persisted).

4. **Exclusion = filtering, at two scopes.**
   - **Per-chart (default):** `ChartSpec.excludedWeekdays?: string[]` (persisted
     on `chartSpecSchema`). The chart-preview endpoint drops those rows via
     `filterRowsByExcludedWeekdays` **before** aggregation + sampling → the mean
     divides by working-day count only (**working-day average, no special math**).
     Because the preview's `ChartRenderer` re-fetches its key insight when the data
     changes, the Why/Do refresh to the working-days view automatically.
   - **Session-wide (opt-in "Apply to all charts"):** a `notIn` active-filter
     condition on `Day of week · <Date>` (`offDayHint.weekdayColumn`). Renders as a
     removable `… excludes Sunday` chip ([`ActiveFilterChips`](../../client/src/components/ActiveFilterChips.tsx))
     and propagates to **every** surface because `loadLatestData` already overlays
     the active filter — reversible by removing the chip.

## The `notIn` ActiveFilterCondition kind

A 4th arm on `activeFilterConditionSchema` (the inverse of `in`). Implemented in
BOTH `applyActiveFilter` (in-memory) and `buildActiveFilterSql` (`NOT IN`) for
parity; empty values = no-op. Every `kind`-switching label/predicate site was
updated (chip labels in `ActiveFilterChips`, `CapturedFilterBanner`,
`FilterDataPanel`, `deckPlanner`). **Known limitation:** the captured-dashboard
client conversion (`dashboardGlobalFilters.conditionToSelection`) returns
`undefined` for `notIn` (no exclude variant in `ChartFilterSelection`) — a live
session honours `notIn` server-side, but an exported dashboard snapshot does not
reflect it client-side. Acceptable for v1.

## UX: non-blocking, answer-first

[`OffDayAffordance`](../../client/src/components/charts/OffDayAffordance.tsx) is a
pure pill with two states: **offer** ("Sunday looks like a recurring off-day (…)"
→ Exclude / Keep all) and **excluded** ("Excluded Sunday from this chart" → Apply
to all charts / Undo). It mounts in WRAPPERS only — `ChartBuilderDialog`'s preview
panel — never inside the frozen v1 renderers (see
[`v1-renderer-frozen.md`](./v1-renderer-frozen.md)).

## Deferred follow-ups (not silently dropped)

- The affordance on already-rendered chart cards / `ChartModal` / `DashboardModal`
  (each has its own duplicated `chart-key-insight` fetch and renders via the frozen
  `ChartRenderer`). The session-wide escalation already covers those surfaces; the
  per-card *offer* is the extension.
- The affordance on agent TEXT answers reporting a date-series average (needs the
  narrator to attach `offDayHint` to the answer envelope).
- `chartSpecV2Schema` carrying `excludedWeekdays` (v1-only today).
