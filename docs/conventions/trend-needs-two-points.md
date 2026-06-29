# Convention: a trend chart needs more than one point

> Introduced in Wave W-1PT1 (2026-06-29). See `docs/WAVES.md` for the original context.

## Rule

A `line`, `area`, or `scatter` chart whose x-axis materializes to **fewer than 2
distinct points** is degenerate (a single dot with nothing to connect) and must
never be created or rendered — at ANY granularity (a single day, week, month, or
quarter all collapse to one point). The single source of truth is
[`server/shared/chartValidity.ts`](../../server/shared/chartValidity.ts)
(`isDegenerateTrendChart` / `isRenderableChart` / `countDistinctXPoints`,
`DEGENERATE_TREND_CHART_TYPES = {line, area, scatter}`), re-exported to the client
via the shim [`client/src/shared/chartValidity.ts`](../../client/src/shared/chartValidity.ts).

Bars and pies are out of scope — a single-category bar is guarded upstream
(`chartFromTable` returns `null` for `rows.length === 1`; the feature sweep skips
dims with `uniques < 2`).

## Why

In dashboard mode the temporal-grain authority is intentionally called with
`allowSingleBucket: true` ("show one honest point as a last resort"), and the
raw-date-column fallback can also collapse to one point. No chart builder
re-validates the result, so a single-month dataset produced a tile like
*"NR (Rs Cr) by Month · Time"* showing one dot at `2025-04`. The builders see RAW
columns and cannot predict the grain-collapse; only **after `data` is
materialized** is the real point count known — so that is where suppression must
live. One shared predicate consumed at both ends means already-persisted charts
disappear without regeneration and the two tiers can never drift
([[L-018]] "fix both ends", [[L-022]] "the code gate is the guarantee").

## How to apply

- **Counting:** "points" = distinct non-null values of `row[x]` across the
  chart's materialized `data`. Multiple rows sharing one x (a multi-series line)
  count as ONE point. An **un-materialized** chart (`data` absent) is treated as
  "enough" and never dropped; an empty `data: []` trend is degenerate.
- **Server (prevention):** the rule runs unconditionally in
  [`finalizeMergedCharts`](../../server/lib/agents/runtime/agentLoop/finalizeCharts.ts)
  — the one convergence point for every chart source — before dedupe/cap, so a
  degenerate trend never reaches a dashboard or answer. New chart builders need no
  extra guard; they all flow through finalize.
- **Client (hide already-saved):** filter chart lists with `isRenderableChart`
  before mapping to tiles
  ([`DashboardView.tsx`](../../client/src/pages/Dashboard/Components/DashboardView.tsx),
  [`MessageBubble.tsx`](../../client/src/pages/Home/Components/MessageBubble.tsx)).
  **Preserve each chart's original index** when filtering — downstream
  persistence (e.g. `updateMessageChartSort`) is index-addressed.
- No feature flag — a degenerate chart is never valid, so the rule is always on.

## Related

- [Wave W-1PT1 entry](../WAVES.md)
- Files: [`server/shared/chartValidity.ts`](../../server/shared/chartValidity.ts),
  [`server/lib/agents/runtime/agentLoop/finalizeCharts.ts`](../../server/lib/agents/runtime/agentLoop/finalizeCharts.ts)
- Sibling shared-authority pattern: [`chartInsightLanes`](../../server/shared/chartInsightLanes.ts), [`chartSort`](../../server/shared/chartSort.ts)
