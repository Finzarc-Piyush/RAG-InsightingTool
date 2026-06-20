# Convention · Duration columns vs time-of-day columns

A column whose cells look like `HH:MM:SS` can mean two different things. The
tool now treats them differently because they answer different questions.

## Duration (elapsed time → a quantity)

`Working Hrs` = `03:31:57` means *3h 31m 57s were worked*. This is a **measure**:
you average it, sum it, rank by it.

- **Detection:** [`classifyAsDuration`](../../server/lib/durationColumns.ts) — a
  colon-formatted column wins the "duration" label when its name hints elapsed
  time (`hrs/hours/duration/working/elapsed/tat/…`) **or** any value is ≥ 24h
  (a clock can't read `30:00:00`). Duration **beats** the time-of-day classifier.
- **Storage:** converted at ingest to **decimal hours** (a real number) by
  `applyDurationColumns` inside `applyUploadPipelineWithProfile`
  ([`fileParser.ts`](../../server/lib/fileParser.ts)). Recorded via a per-column
  side-channel tally (mirrors the currency tally) and read back by
  `createDataSummary` as a `duration` annotation. **Because the cell is now a
  number, every aggregation path and DuckDB `TRY_CAST` work unchanged.**
- **Display:** the `duration` annotation drives `formatHoursAsDuration` →
  `3h 32m` (Columns panel `numeric · duration`, Data Preview cells, chart
  axes/tooltips via `inferFormatHint` → `"duration"`, and the narrator block in
  `buildSynthesisContext`). The stored/exported value is decimal hours.

This is the exact mirror of the **currency** pattern: store a number, carry an
annotation, format at the display leaves.

## Time-of-day (a clock reading)

`Clock-In Time` = `09:45:34` is *when* someone clocked in. It is kept as a
**text** `timeOfDay` column so the planner can compare it chronologically
against quoted `'09:30:00'` literals — converting it would break those filters.

- Averages/rankings over a time-of-day column ARE computed in
  [`run_breakdown_ranking`](../../server/lib/agents/runtime/tools/breakdownRankingTool.ts):
  cells are coerced to seconds-since-midnight (`timeOfDayToSeconds`), the group
  is ranked on the numeric seconds, then the result is rendered back as a clock
  (`formatSecondsAsClock` → `09:51`) for the narrator/table.

## Known limitation / follow-up

Time-of-day averaging is currently wired only into `run_breakdown_ranking`
(the "highest / lowest / average `<clock>` by `<dimension>`" shape — the common
ask). The generic in-memory `applyAggregations` (pivots) and the DuckDB query
plan executor still return their prior value (effectively 0) for an average over
a *time-of-day* column — no regression, but a pivot of avg clock-in won't show a
clock yet. Durations have no such gap (they are real numbers everywhere).

## Existing datasets

The conversion runs at upload/refresh only. A dataset uploaded **before** this
shipped keeps the raw `03:31:57` strings and will still average to 0 until it is
**re-uploaded** (or refreshed via "Update data"). No in-place backfill.
