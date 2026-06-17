# DataPreviewTable chart-config consolidated into a typed reducer

**Status:** Accepted · 2026-06-17 (ARCH-5 / CQ-3 / FE-2 state-web reduction)

## Context

`client/src/pages/Home/Components/DataPreviewTable.tsx` (~3.2k LOC) carried a
large `useState` web. Prior waves had already extracted every cleanly-separable
cluster: the row-level + filter-distinct fetchers (`useSessionSampleRows`,
`useSessionFilterDistincts`), the pure column/cell helpers, the cell formatter,
and the pivot sub-components. What remained was the COUPLED
`pivotConfig` ↔ `filterSelections` ↔ chart-config web sharing the
reset-on-data-shape, hydrate-from-persisted, and debounced-PATCH effects — 31
component-level `useState`s.

Within that web, the **chart-config sub-cluster** is genuinely cohesive: 8
`useState`s (`chartType`, `chartTitle`, `chartXCol`, `chartYCol`, `chartZCol`,
`chartSeriesCol`, `chartBarLayout`, `chartRecommendationReason`) that are ALWAYS
mutated together — by the reset block, the hydrate block, the auto-recommend
effect, the manual reset-to-recommended handler, and the toolbar dropdowns — and
read together by `chartConfigHash`, the pivot-state PATCH payload, and the
dashboard-spec builder.

## Decision

Consolidate ONLY the chart-config sub-cluster into a typed `useReducer`:

- `state/pivotChartReducer.ts` defines `interface PivotChartState`, a
  discriminated-union `type PivotChartAction`, and a pure `pivotChartReducer`.
- Single-field actions (`SET_CHART_TYPE`, `SET_X`, …) map 1:1 to the former
  `setX(...)` calls and short-circuit (return the same ref) when the value is
  unchanged — mirroring React's per-`setState` bail-out.
- Composite actions collapse the N-setter blocks: `RESET` (reset-on-data-shape),
  `HYDRATE` (restore-from-persisted; leaves title/reason untouched, exactly as
  the original block), `APPLY_RECOMMENDATION` (auto-recommend axis block +
  `resetChartMappingToRecommended`, with an all-fields-equal bail-out).
- The component destructures the 8 fields back into their original local names,
  so every READ site is unchanged; only the WRITE sites dispatch.

`pivotConfig` and `filterSelections` were deliberately LEFT as their own
`useState`s. They have many independent functional-update call sites
(`handlePivotSliceFilterChange`, `handleRowSortChange`, the
`syncFilterSelectionsWithFilters` effect, the drag-and-drop panel) and feed async
memos; folding them in risks changing setState batching/effect timing, which the
behaviour-preserving constraint forbids.

## Consequences

- `useState` count in the component: **31 → 23** (8 consolidated).
- The chart-config state machine is now a pure, exhaustively unit-tested module
  (`state/pivotChartReducer.vitest.test.ts`, 16 cases) instead of 8 scattered
  setters with implicit "always set together" coupling.
- Behaviour is pinned by a new component-level interaction test
  (`DataPreviewTable.interaction.vitest.test.tsx`, 5 flows) that renders the
  component, mocks the API seams, and asserts the rendered pivot + the
  load-bearing pivot-state PATCH payload shape — added BEFORE the refactor as the
  safety net and still green after.
- This is a PARTIAL consolidation of the web (the `pivotConfig`/`filterSelections`
  core remains separate by design — see above). statusHonest: partial.

## Test-harness note (recorded so the next author doesn't re-discover it)

The component defaults `temporalFacetColumns = []`. A fresh `[]` each render
re-fires the filter-sync effect → `setFilterSelections({...prev})` (new ref) →
re-render → loop, which OOMs jsdom. Production callers always pass a stable
reference; the interaction test's fixtures therefore use MODULE-CONSTANT array
props. Also note `inferNumericColumns` classifies year-strings (`'2024'`) as
numeric, so dimension fixtures avoid year-shaped values.
