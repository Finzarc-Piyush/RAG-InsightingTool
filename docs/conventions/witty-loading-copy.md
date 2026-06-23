# Convention · one shared, category-matched witty-loading pool

**Slug:** `witty-loading-copy` · **Introduced:** Wave WIT1

## The rule

All playful "we're working" status lines live in ONE shared module:
[`client/src/pages/Home/Components/wittyCopy.ts`](../../client/src/pages/Home/Components/wittyCopy.ts).
Lines are organized by **category** (one bucket per pipeline stage) plus a
`generic` fallback. Every loading surface resolves a stage → a category → a
bank of candidate lines. Do **not** reintroduce a private per-surface array.

- `WITTY_POOLS: Record<WittyCategory, readonly string[]>` — the banks (~500+ lines).
- `categoryForThinkingStep(rawStep)` — server thinking-step key → category.
- `categoryForEnrichmentStep(step)` — enrichment step → category.
- `pickWittyLine(category, seed)` — deterministic pick (stable per seed, varies
  across turns). Seed is the step's `timestamp`.
- `wittyPoolFor(category)` — the whole bank, for rotation.
- `startIndexFor(category, seed)` — a varied rotation start (no `Math.random`).

The `dashboard` category IS
[`dashboardBuildMessages.ts`](../../client/src/pages/Home/Components/dashboardBuildMessages.ts)
— imported, not duplicated.

## How lines surface (two modes)

1. **Settled step** → ONE deterministically-picked line (`pickWittyLine`). Stable
   across re-renders (no flicker), but different across turns because the seed
   (timestamp) changes.
2. **The single active step** (and the enrichment / dashboard phases) → ROTATES
   through its whole bank via
   [`useRotatingMessage`](../../client/src/hooks/useRotatingMessage.ts), so a
   long wait surfaces many lines.

Consumers:
[`ThinkingPanel.tsx`](../../client/src/pages/Home/Components/ThinkingPanel.tsx)
(de-dupes steps **by category**, not by label) and
[`DatasetEnrichmentLoader.tsx`](../../client/src/pages/Home/Components/DatasetEnrichmentLoader.tsx).

## Why it was a problem before

The Thinking panel mapped each server step to exactly ONE hardcoded string (a
`switch`), so there was no pool to grow and no way to share Enriching's lines
into Thinking. Three private duplicated lists existed. This module removes the
duplication and makes "add more lines, used everywhere" a one-line edit.

## Style contract for new lines

Short (≤ ~60 chars), ellipsis by default, present-progressive, plausibly true at
ANY instant during that stage (rotation is order-shuffled — so no finality /
"almost done" / "saving now"), witty and warm, light FMCG/haircare flavor on a
minority. Adding lines = paste into the right category array; the coverage test
([`wittyCopy.vitest.test.ts`](../../client/src/pages/Home/Components/wittyCopy.vitest.test.ts))
guards that every stage keeps a non-empty bank.

## Related

The live answer timer on the Thinking panel
([`answerTimeEstimate.ts`](../../client/src/pages/Home/Components/answerTimeEstimate.ts))
mirrors the enrichment loader's "Typical time" box — elapsed since the turn
started (captured on the `isLoading` edge in `ChatInterface`) + a coarse
"usually about X–Ys" band that widens once a dashboard build begins.
