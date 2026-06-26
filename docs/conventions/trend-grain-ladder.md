# Convention — the trend-grain ladder (a dashboard trend shows MORE than one grain)

## The rule

A dashboard (or an un-pinned trend ask) renders the **anchor metric's** trend at a
short **ladder of grains**, not a single grain:

| Data span | Ladder (coarse → fine) | Dropped, and why |
|---|---|---|
| ~1 month | `week`, `date` (daily) | `month` = 1 bucket (a non-trend) |
| ~1 year | `quarter`, `month` | `year` = 1 bucket; `week` (52) / `day` (365) too fine |
| multi-year | `year`, `quarter`, `month` | `week`/`day` too fine |

The single authority is **`resolveTrendGrainLadder(range)`** in
[`temporalGrainAuthority.ts`](../../server/lib/temporalGrainAuthority.ts) (this is an
extension of the same authority that owns single-grain selection — invariant #11, not a
competing heuristic). A grain is eligible when it yields buckets in
`[MIN_LADDER_BUCKETS (3), MAX_LADDER_BUCKETS (45)]`; it returns the **coarsest** eligible
grains up to `LADDER_MAX_LEVELS (3)`. `half_year` is deliberately excluded — a half-year
tile between quarter and year reads as noise.

- The floor (3 buckets) drops the span-equal coarsest level (the user's "drop the level
  that's only 1 bucket") **and** a useless 2-point line.
- The cap (45 buckets) is the boundary that keeps "quarterly + monthly only" for a year
  while keeping daily-on-a-month — it separates a legible trend from clutter.

## Where it runs

One **post-merge pass** — `applyTrendGrainLadder` in
[`trendGrainLadder.ts`](../../server/lib/agents/runtime/trendGrainLadder.ts) — invoked from
[`agentLoop.service.ts`](../../server/lib/agents/runtime/agentLoop.service.ts) **just before
`finalizeMergedCharts`**. That is the only point that sees charts from every engine
(per-step promotion, visual planner, feature sweep, coverage gate), so it can **replace**
whatever single grain they produced. It builds each ladder tile from the **RAW frame**
(numeric sum / per-period mean, or a scoped boolean-indicator rate) — never by re-parsing a
chart's bucket labels — so it is robust to the columnar reload path that strips facet
columns, and works for both numeric and Yes/No indicator anchors.

## Gates (so this never re-creates "pointed question → plethora", L-032)

- Only **dashboards** or an explicit **trend** ask, and never at `minimal` depth (invariant
  #12). 
- Never when the user **pinned** a grain — `detectCoarseTimeIntentFromMessage` truthy
  ("daily chart") → no ladder, one daily chart.
- Applies to the **anchor metric only** (≈1–3 trend tiles), not a per-metric × per-grain
  fan-out.

## Don't

- Don't add a local span→grain ladder anywhere else — call `resolveTrendGrainLadder`.
- Don't build ladder tiles by coarsening an existing chart's labels; bucket the raw frame.
- Don't run the ladder for a pinned-grain ask or a `minimal`-depth lookup.
