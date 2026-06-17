# Centralized dashboard layout authority

> ADR · 2026-06-18 · Waves EXD1–EXD8. Status: **accepted**.

## Context

The "executive dashboard" exists on two surfaces — the inline chat answer
([`AnalyticalDashboardResponse.tsx`](../../client/src/pages/Home/Components/AnalyticalDashboardResponse.tsx))
and the persisted `/dashboard` page ([`DashboardTiles.tsx`](../../client/src/pages/Dashboard/Components/DashboardTiles.tsx),
react-grid-layout). Both, plus the server dashboard builder, made layout
decisions with **hardcoded numbers** that the user experienced as "badly
structured and aligned… limited to 3 charts":

- The default-opened Executive Summary sheet was hard-capped at **3** charts by
  `pickFeaturedCharts` in [`buildDashboard.ts`](../../server/lib/agents/runtime/buildDashboard.ts)
  (`out.length < 3`); the 24-chart pool only filled a secondary sheet.
- The server stamped fixed `hero + 3-up` grid coordinates (`executiveCells` in
  `dashboardTemplates.ts`, every box `w:4 h:16`) which the client's
  `ensureLayoutsForTiles` kept verbatim — **bypassing** the already-built
  content-driven sizing (`contentDrivenHeight` / `chartAspectRows`).
- The inline surface used a static `grid-cols-1 lg:grid-cols-2` + an
  `isFullWidthChart` boolean that orphaned half-cells and produced ragged rows.
- Chart heights drifted: server `h:16`, client `TILE_CONFIG.chart h:14`.

This is the same class of problem invariants #11 (temporal grain) and #12
(query intent / depth budget) already solved by giving the decision **one
authority**.

## Decision

Introduce a single pure module, [`server/shared/dashboardLayout.ts`](../../server/shared/dashboardLayout.ts),
re-exported to the client via [`client/src/shared/dashboardLayout.ts`](../../client/src/shared/dashboardLayout.ts)
(same cross-package boundary as `schema.ts`). It owns three decisions, all
derived from chart **content**, never hardcoded positions:

| Export | Decides | Replaces |
|---|---|---|
| `decideFeaturedCount` + `selectFeaturedCharts` | how many charts the executive sheet features (distinct analytical angles, bounded by `depthBudget` + `GRID_FEATURED_MAX`) | `pickFeaturedCharts`' literal `< 3` |
| `planChartLayout` | each chart's column span (content appetite → wide/standard/hero) + orphan-free row packing, for any `columns` width | server `executiveCells`/`deepDiveCells`/`monitoringCells` **and** the inline `isFullWidthChart` |
| `chartRowsForSpan` | a chart tile's height from its placed width (aspect ratio) | the duplicated server `h:16` / client `chartAspectRows` math |

Consumers: `buildDashboard.pickFeaturedCharts`, `dashboardTemplates`
(server layout), `AnalyticalDashboardResponse` (inline), and
`chartTileHeight.chartAspectRows` (persisted) all delegate here.

The split of responsibility is preserved and sharpened: the **LLM** still owns
the story + template choice; **this authority** owns geometry; the **client**
owns final render. Text/insight tiles continue to size to their text via the
existing `contentDrivenHeight` path (they were never in the server layout, so
they were never bypassed).

## Consequences

- **Good.** "More charts when warranted" and "boxes sized/placed from content"
  are now single, testable functions ([`dashboardLayout.test.ts`](../../server/tests/dashboardLayout.test.ts)),
  parameterised by grid width so the inline (2-col) and persisted (12-col)
  surfaces compose identically. Server and client compute the **same** chart
  height (no drift). Rows always fill their width (no orphan gaps).
- **Cost.** `DepthBudget` is a local structural copy of
  `queryIntentAuthority.DepthBudget` (the canonical owner) — kept local on
  purpose so this client-bundled module takes no `server/lib` dependency; the
  unions are identical and a mismatch would fail `tsc` at the call site.
- **Deferred.** The inline chat chart renders at a fixed preview height
  (no `fillParent`), so inline cards are content-sized + top-aligned rather than
  forced to equal heights (forcing equal heights around a fixed chart created
  dead space — caught in adversarial review and reverted). Making the inline
  chart fill an equal-height card like the persisted tile (`fillParent`) is a
  possible follow-up but changes lazy-render / header behaviour, so it was left
  out of this change.
- **Not addressed.** The live ResizeObserver auto-fit (`useTileAutoFit` /
  `shouldAutoFit`, Waves S4/S5) remains unwired dead code; persisted text tiles
  use the seed-time `contentDrivenHeight` estimate, which is sufficient.
