# Convention · Continuous time columns are BINNED before they become a chart axis

**The gotcha.** A chart "`<metric> (avg) by <dimension>`" keys each bar by the raw
dimension value — `aggregateData` does `key = String(row[groupBy])`
([server/lib/chartGenerator.ts](../../server/lib/chartGenerator.ts)). For a **continuous
time-like column** that means *one bar per distinct value*:

- **Clock-In Time** (a time-of-day column, `type:"string"` + a `timeOfDay` annotation) →
  a bar for `08:50:49`, `09:14:19`, `09:14:56`… — meaningless.
- **Working Hrs** (a duration column, converted to decimal hours → `type:"number"` +
  a `duration` annotation) → a bar for `03:16:55`, `06:13:08`… — meaningless.

Calendar **dates** are already binned by the temporal grain authority
(`temporalGrainAuthority` → `normalizeDateToPeriod`). Time-of-day and duration columns had
no equivalent, so they fell through to per-value bars.

**The rule.** Any chart builder that turns a dimension column into an x-axis must run it
through [`server/lib/continuousDimensionBucket.ts`](../../server/lib/continuousDimensionBucket.ts)
**first**:

```ts
const summaryColumn = summary.columns.find((c) => c.name === x);
const plan = planContinuousDimensionBucket({ column: x, rows: workingRows, summaryColumn });
if (plan && plan.orderedKeys.length >= 2) {
  workingRows = applyContinuousDimensionBucket(workingRows, plan);
  axisReason = plan.reason; // "Bucketed "Clock-In Time" into hour-of-day bands"
}
// builders that already hold a ChartSpec can use the one-liner bucketContinuousXForSpec(...)
```

The module is a **pure authority**: it owns the decision (time-of-day → hour-of-day bands,
auto-refining to 30/15-min when clustered; duration → round whole-hour ranges) and rewrites
the dimension cells to **lower-bound-leading bucket labels** (`08:00–09:00`, `3h–4h`). It is
applied as a **row rewrite before compile/aggregate** — the same shape as
`dashboardFeatureSweep`'s `bucketRowsTopN` / `deriveDimensionBucket`. aggregateData then keys
by those labels and yields one bar per bucket, unchanged.

**Why a row rewrite and not a change in aggregateData:** `processChartData` / `aggregateData`
receive only `declaredDateColumns: string[]` — they have **no access** to the `DataSummary`
column annotations, but every *builder* does. Putting the decision in the annotation-blind
aggregator would re-open lessons L-019/L-024/L-032 (a centralized decision fed a
path-dependent input). The authority lives where the annotations already are.

**Order is load-bearing.** Run the bucket rewrite **before** any x-axis cardinality guard
(e.g. `X_LABEL_CARDINALITY_CAP` in `chartFromTable`), or a continuous column gets *suppressed*
(hundreds of distinct values) instead of binned. Recompute the cardinality from the rewritten
rows.

**Free for sorting & labels.** Labels lead with their lower bound, so the shared sort authority
(`shared/chartSort` → `detectAxisOrdered` → `bucketLeadingNumber`) detects the axis as ordered
and sorts ascending (`3h–4h` before `10h–11h`). The bucket key **is** the display label. No new
ChartSpec fields.

**Scope.** Time-of-day + duration only. Generic high-cardinality *numeric* binning is
intentionally out of scope so a 1–12 month or 1–5 rating axis is never re-bucketed. Sentinel
cells (`Absent`/`N/A`) and unparseable values map to `null` and are dropped (no sentinel bucket).
A plan that collapses to `<2` buckets is skipped by the caller (chart natively).
