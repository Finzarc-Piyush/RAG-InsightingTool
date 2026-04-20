# Dashboard UX — fix the cascade-push on collision

**Status:** core fix shipped on `claude/add-claude-documentation-PaA9h` (`dashboardGridLogic.ts` + `resolveLayoutsDropBySwap` wired into `DashboardTiles.tsx`). **Remaining:** undo stack, snap guides, keyboard/a11y — optional polish.

## Context

Dashboard uses `react-grid-layout@1.5.2` (Responsive/WidthProvider) with
`compactType={null}` + `preventCollision={false}` in
`client/src/pages/Dashboard/Components/DashboardTiles.tsx`. When the user
drags a card onto another, the library permits overlap; the subsequent
`onLayoutChange` triggers `ensureLayoutsForTiles` whose greedy bottom-fill
pushes every subsequent tile way down. Users call this "dashboards keep
breaking themselves."

## What good looks like

Dragging card A onto card B should feel like Notion / Trello / Tableau:
**A and B exchange slots**, everything else stays put. No cascade, no
scroll-to-infinity. Undo is one Ctrl+Z.

## Root cause (exact code path)

- `DashboardTiles.tsx:656` — `<ResponsiveGridLayout preventCollision={false} compactType={null} … />`.
- `DashboardTiles.tsx:68-104` — `placeTilesForCols` (fallback layout) uses
  a greedy bottom-fill.
- `DashboardTiles.tsx:305` — `useEffect` calls `ensureLayoutsForTiles(prev, visibleTiles, fallbackLayouts)` on every layout/visible-tile change.
- `ensureLayoutsForTiles` does not resolve *overlaps*; it only re-adds
  missing tiles. When layout arrives with two tiles at the same `{x,y}`,
  the next recompute stacks everything via the greedy algorithm.

## Sub-problems

- **UX-1 — Swap semantics on explicit drop collision.** When a drop lands
  atop another card, swap slots.
- **UX-2 — Stop greedy re-stack when a user just reorders.** Don't
  recompute all y-coordinates from scratch.
- **UX-3 — Undo.** Wire `Cmd/Ctrl+Z` to restore the last committed layout.
- **UX-4 — Snap guides during drag.** Show a thin outline of where the
  card will land so users aren't guessing.
- **UX-5 — Keyboard + a11y.** Arrow-keys to nudge a focused card; announce
  swaps via `aria-live`.

## Solution design

### UX-1 — Swap semantics (primary fix)

Replace the current `onLayoutChange` behavior with an explicit
`onDragStop` handler that:

1. Captures `layoutBefore` (entered `onDragStart`).
2. On stop, compares the dragged tile's new `{x,y,w,h}` against every
   other tile.
3. If exactly one tile overlaps ≥50% of the dragged tile's area → **swap
   positions** with that tile.
4. If multiple tiles overlap → revert to `layoutBefore`, flash a "drop on
   a single target to swap" toast.
5. If no overlap → accept the new position.

New function `resolveDropBySwap(layoutBefore, layoutAfter, draggedId)` in
a new file `client/src/pages/Dashboard/Components/dashboardGridLogic.ts`.
Pure function, unit-testable, no React. `onDragStop` wraps it + calls
`setLayouts`. `preventCollision` flipped to `true` so the library itself
refuses mid-drag overlap rendering.

### UX-2 — Stable reflow (stop cascade)

Replace `placeTilesForCols` with a *stable* variant: if a tile already
has a valid position in `prev`, keep it; only assign a new position to a
genuinely new tile. The greedy bottom-fill is applied exclusively to
tiles without a prior position. No more global y-recompute on every
state change.

### UX-3 — Undo stack

Small `useLayoutHistory` hook (ring buffer, length 20). Push
`layoutBefore` on every committed change. `Cmd+Z` pops and dispatches.
Persists for the lifetime of the dashboard view; cleared on navigation.

### UX-4 — Snap guides

During drag, render a thin dashed outline (`drop-indicator`) at the
prospective grid cell using the library's `draggedItem.i / x / y`. CSS
only; no React state churn. If the prospective cell overlaps another
tile, outline turns amber + render a "swap" icon in the center of the
target card.

### UX-5 — Keyboard + a11y

- Each card has `role="group" aria-roledescription="dashboard card"`.
- Focus a card with Tab, enter "move mode" with Space, arrow keys nudge
  by one grid cell, Space again commits.
- Live region announces `{cardName} swapped with {otherCardName}` on
  each commit.
- Screen-reader test with VoiceOver + NVDA.

## File-level changes

New:
- `client/src/pages/Dashboard/Components/dashboardGridLogic.ts` — pure
  helpers (`resolveDropBySwap`, `stablePlaceTiles`,
  `detectOverlaps`).
- `client/src/pages/Dashboard/hooks/useLayoutHistory.ts`.
- `client/src/pages/Dashboard/Components/dashboardGridLogic.test.ts` —
  golden tests for swap + stable-place.

Modified:
- `client/src/pages/Dashboard/Components/DashboardTiles.tsx` — flip
  `preventCollision`, wire `onDragStart` / `onDragStop`, replace
  `placeTilesForCols` with `stablePlaceTiles`, render snap guides,
  add keyboard move mode, integrate history hook.

## Rollout

One PR, gated by `VITE_DASHBOARD_SWAP_UX=true` for a week of internal
dogfood, then on by default. Original greedy path retained as a
`VITE_DASHBOARD_LEGACY_LAYOUT=true` escape hatch for one release before
removal.

## Verification

- **Unit tests** for `resolveDropBySwap`:
  - drop on one tile → swap.
  - drop on two tiles → revert.
  - drop on empty cell → accept.
  - drop onto a partially overlapping tile (≥50%) → swap.
  - drop onto a partially overlapping tile (<50%) → revert.
- **Interaction tests** (Playwright if available, else Vitest + JSDOM):
  drag + drop a card; assert grid layout delta.
- **Perf**: drag-finish reflow under 16ms for 30 cards on a dev laptop
  (profile via Chrome DevTools).
- **Manual**: the five canonical flows — drop-on-empty,
  drop-on-one-card, drop-spanning-two-cards, delete-a-card-in-the-middle,
  resize-a-card.
- **A11y**: axe + screen-reader runs on the dashboard page. No new
  violations.

## Non-goals

- Free-form (absolute-positioned) layout — keep the grid.
- Multi-card multi-select drag — later.
- Cross-sheet drag — later.
