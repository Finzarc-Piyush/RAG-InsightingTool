# Decision · One seam attaches an insight to every chart, everywhere

**Status:** accepted · 2026-06-18 (Phase A of chart-insight + render unification)

## Context

A per-chart, plain-English "key insight" is a first-class output. But coverage
was *not* guaranteed at the source:

- The only auto-generator was `enrichCharts` (chat answer pipeline), which runs
  AFTER the agent loop on the chat answer's charts.
- Many chart-producing paths attached nothing at build and survived only because
  `enrichCharts` later re-scanned them: `visualPlanner` extra/fallback charts,
  `chartFromTable`, `dashboardFeatureSweep`, `agentLoopDeferredCharts`.
- `budgetOptimizerTool` hardcoded jargon strings, bypassing the engine (and its
  IUX2 grounding gate).
- **Auto-created dashboards were the real hole:** `buildDashboardFromTurn` runs
  BEFORE enrichment, so dashboard charts were bare; a best-effort async
  signature-match patch (`patchDashboardChartInsights`) backfilled them, but
  silently MISSED any sweep tile with no chat twin → empty insight footers.

## Decision

1. **One engine, one seam.** `generateChartInsights` (lib/insightGenerator.ts)
   stays the engine — it owns the IUX2 grounding gate (accepts a 0–1 rate
   rendered as a percent) and rate-awareness. Its per-chart caller body is
   extracted into a reusable, **idempotent** wrapper
   `generateInsightForCharts(charts, deps)` (lib/generateInsightForCharts.ts).
   `enrichCharts` is now a thin caller over it. Every server chart path can route
   through the same seam.

2. **Idempotency is load-bearing.** A chart that already carries a non-empty
   `keyInsight` is passed through untouched (no LLM call). A second pass is a
   no-op, so the chat safety-net pass and any in-tool generation never
   double-generate or overwrite a hand-seeded insight.

3. **Born-insighted dashboards, reuse-first.** After enrichment,
   `applyEnrichedChartsToDashboard` (a) copies the chat answer's insights onto
   dashboard charts by axis signature (no LLM — same chart → same insight as
   chat), then (b) routes any chart STILL bare (orphan sweep tiles) through the
   seam. Net: no dashboard chart ships without an insight, and the only added
   LLM calls are the true orphans.

## Invariant boundary — depthBudget (#12) stays out of the seam

The decision of whether to PRODUCE an extra chart is owned upstream by
`queryIntentAuthority` / `visualPlanner` (a `minimal` ask is answered without
auto-padding charts). The insight seam carries **no** depthBudget branch: any
chart that ships gets an insight, unconditionally. Putting the gate inside the
seam would split the single authority. The contract is therefore:

> `minimal` suppresses *extra charts* upstream; every chart that exists gets an
> insight.

## Consequences

- New chart-producing paths get insight coverage for free by flowing through any
  caller of the seam (or being routed through it directly).
- Dashboard insight presence is a pipeline guarantee, not a best-effort race; the
  signature-match copy remains as the cheap reuse step, not the only safety net.
- Tone/wording of any path moved onto the seam (e.g. a future `budgetOptimizer`
  migration) shifts from jargon to manager-friendly + grounded — verify no test
  pins the old hardcoded strings before moving it.
