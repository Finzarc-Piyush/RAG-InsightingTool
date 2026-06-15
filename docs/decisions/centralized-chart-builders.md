# Centralized chart-builder glue, sampling, palette & series extraction

**Status:** Accepted · 2026-06-14 (charting/pivot consolidation audit)

## Context

A multi-agent duplication audit over charting / pivot / formatting / sampling /
export confirmed the *heavy* logic was already single-sourced
(`chartGenerator.processChartData`, `chartSpecCompiler.compileChartSpec`,
[`temporalGrainAuthority`](./centralized-temporal-grain.md),
[`queryIntentAuthority`](./centralized-query-intent.md), the
`server/shared/pivot/*` re-export shims). What remained were thin glue, copied
constants, and copied helpers — repeated across the deterministic chart builders,
the three scatter renderers, and the three export masters. One copy had already
**drifted into a latent bug**: visualPlanner's inline `scoreMeasure` had lost
chartFromTable's `__matching`/`__total` guard and `_rate`/`_pct` bonus, so two
paths whose own comments say they run "in lockstep" picked different y-axes for
boolean-indicator rate breakdowns.

## Decision

Each repeated unit now has ONE authority that callers delegate to on demand:

| Capability | Single authority | Delegating callers |
|---|---|---|
| Measure/dimension axis pick (`scoreMeasure`, `isNumericishOnSample`) | [`agents/runtime/chartMeasurePick.ts`](../../server/lib/agents/runtime/chartMeasurePick.ts) | `chartFromTable`, `visualPlanner` deterministic fallback |
| Temporal-x-axis detection | existing [`temporalFacetColumns.isTemporalFacetColumnKey`](../../server/lib/temporalFacetColumns.ts) | `chartFromTable`, `visualPlanner` (×2), `verifier` |
| ChartSpec finishing tail (domains + labels + packaging) | [`chartSpecFinish.finishChartSpec`](../../server/lib/chartSpecFinish.ts) | `chartFromTable`, `visualPlanner` (×2), `dashboardFeatureSweep`, `agentLoop.materializeDeferredBuildCharts` |
| Memory-cap on built chart points | [`chartDownsampling.capChartDataPoints`](../../server/lib/chartDownsampling.ts) | `chatResponse.enrichCharts`, `uploadQueue` sanitiser |
| Scatter density decimation | [`charts/scatterDecimation.ts`](../../client/src/lib/charts/scatterDecimation.ts) (→ `dataEngine.sample`) | `ChartRenderer`, `ChartModal`, `ChartOnlyModal` |
| Pie/radar cardinality limits | existing [`shared/pivot/chartLimits.ts`](../../server/shared/pivot/chartLimits.ts) | `chartRecommendation`, `chartTypeValidity` |
| Export brand palette | [`exports/brandPalette.ts`](../../server/lib/exports/brandPalette.ts) | chartSsr `EXPORT_BRAND`, pptx `PPTX_BRAND`, pdf `PDF_BRAND` |
| Export numeric coercion (`readNum`) | existing [`numberCoercion.toFiniteNumber`](../../server/lib/numberCoercion.ts) | chartSsr, pptx mapper, `chartSpecSeries` |
| Export ChartSpec→series extraction | [`exports/chartSpecSeries.ts`](../../server/lib/exports/chartSpecSeries.ts) | chartSsr cartesian/scatter, pptx cartesian/scatter |

`finishChartSpec` implements the COMPLETE tail (heatmap → no domains; multi-series
`seriesKeys` → `yDomainForMultiSeriesRows`; else `calculateSmartDomainsForChart`).
Two builders previously used a simpler tail lacking the multi-series branch, so
they computed `calculateSmartDomainsForChart` on the bare `spec.y` — not a column
in a wide multi-series frame — yielding a degenerate Y range. Delegating fixes
that for `chartFromTable` and the deterministic fallback. Single-series output is
byte-identical (it falls to the same `else`).

## Consequences

- The chart-promotion path and the visual-planner deterministic fallback can no
  longer drift on measure pick, temporal-axis detection, or axis domains — they
  call the same leaf modules. **Follow-up (2026-06-14): the two builders are now
  FULLY merged** — the deterministic fallback (`visualPlanner.buildDeterministicFallbackChart`)
  *calls* `chartFromTable.buildChartFromAnalyticalTable` outright rather than
  re-implementing the build, so a fallback chart deep-equals the promotion chart for
  the same table (equivalence-test-pinned). See
  [`duplication-audit-deferrals.md`](./duplication-audit-deferrals.md) (RESOLVED section).
- Multi-series auto-built charts now scale their Y axis across all series.
- A palette change for exports is one edit in `brandPalette.ts`; the audit also
  noted the export categorical palette is a hand-mirror of the in-app
  `--chart-*` cycle (kept as a documented mirror, not auto-derived, to avoid a
  server→client build dependency).
- Verified: server `npm test` (5739) + client build/theme/test (534) green,
  invariant firewall 32/32.
