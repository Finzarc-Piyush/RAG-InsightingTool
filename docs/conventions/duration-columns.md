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

- Averages/rankings over a time-of-day column are computed by coercing cells to
  seconds-since-midnight (`timeOfDayToSeconds`), aggregating on the numeric
  seconds, then rendering the result back as a clock (`formatSecondsAsClock` →
  `09:51`) for the narrator/table. This now happens in **all three** aggregation
  paths (TOD-AGG):
  - [`run_breakdown_ranking`](../../server/lib/agents/runtime/tools/breakdownRankingTool.ts)
    — `metricIsTimeOfDay` flag (in-memory).
  - [`queryPlanDuckdbExecutor`](../../server/lib/queryPlanDuckdbExecutor.ts) — the
    production path. `aggregationSqlExpr` emits
    `AVG(EXTRACT(EPOCH FROM TRY_CAST(col AS TIME)))` (and `MIN`/`MAX`) for a
    `timeOfDay` measure; `executeQueryPlanOnDuckDb` formats the returned seconds
    of each `clockAggAliases` output back to `HH:MM`. (Sentinels like `Absent`
    `TRY_CAST` to NULL and drop out for free.)
  - [`applyAggregations`](../../server/lib/dataTransform.ts) — the in-memory
    fallback (`aggregationValues` + `formatClockAggIfNeeded`).
  `sum` over a clock column is intentionally NOT special-cased (summing clock
  readings is meaningless) — it keeps the legacy `DOUBLE` cast.

## Known limitation / follow-up

Closed (TOD-AGG): a pivot / quick-answer of "avg clock-in by `<dimension>`" now
renders a real clock instead of all `—`. Remaining gap: **chart value-axis**
formatting for a time-of-day measure — because the aggregation output is a clock
*string*, a bar chart of avg-clock-by-dimension has no numeric value axis yet.
Deferred to a follow-up (keep the column numeric for charts via the
`inferFormatHint → "duration"`-style hint, string for the table). Durations have
no such gap (they are real numbers everywhere).

## Existing datasets

The **duration** conversion runs at upload/refresh only. A dataset uploaded
**before** that shipped keeps the raw `03:31:57` strings and will still average
to 0 until it is **re-uploaded** (or refreshed via "Update data"). No in-place
backfill.

**Time-of-day** averaging (TOD-AGG) is different: it parses the raw `HH:MM:SS`
strings at *query* time, so any dataset whose clock column already carries the
`timeOfDay` annotation averages correctly with no re-upload. Only a dataset old
enough to predate time-of-day **detection** (`classifyAsTimeOfDay`) needs a
re-upload to gain the annotation.
