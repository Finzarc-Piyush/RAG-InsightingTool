# Centralized chart-sort authority (`applyChartSort` / `resolveSort`)

**Status:** Accepted · Waves S1–S7

## Context

Every categorical bar/column chart was ordered by its measured value
(highest→lowest). Users could not request the **category axis** order — e.g.
"survived by age" always came out tallest-bar-first, with no way to say "show
age 0→100 left-to-right." The only existing knob, `sortDirection`, controlled
value direction (asc/desc) and was honoured ONLY for single-series bars; the
grouped/stacked branch hardcoded "descending by the first series key" and
ignored it (a latent bug at [chartGenerator.ts](../../server/lib/chartGenerator.ts)
`:751-755`). There was no UI control and no concept of "which feature to sort by."

A second trap: the chronological-label comparator existed in **two** copies —
[client/src/lib/temporalAxisSort.ts](../../client/src/lib/temporalAxisSort.ts)
(`parseTemporalLabelSortKey`, `compareTemporalOrLexicalLabels`, used by 6 client
sites) and a server duplicate (`chartGenerator.ts`'s `compareValues` +
`CANONICAL_PERIOD_KEY_RE`, whose comment literally said "Mirrors
`parseTemporalLabelSortKey`").

## Decision

One pure, dependency-free module —
[`server/shared/chartSort.ts`](../../server/shared/chartSort.ts) — is the SOLE
authority for ORDERING chart rows, imported identically by the server
(`chartGenerator.processChartData`) and the client (`useChartSort`, the pivot
preview). It absorbs the temporal-label parser; the old
`client/src/lib/temporalAxisSort.ts` is now a one-line re-export, so there is
exactly ONE copy of the chronological-key logic. Scope is ORDER only — GRAIN
stays with `temporalGrainAuthority` (invariant #11).

The contract is a single optional spec field
`sort: { by: "value" | "category"; direction: "asc" | "desc" }` on
`chartSpecSchema` (runtime validator `barSortSpecSchema`; distinct from the
ChartSpecV2 encoding-sort `chartSortSpecSchema`). `sortDirection` is kept as a
back-compat alias.

- **`resolveSort`** decides the effective sort: explicit `sort` →
  `sortDirection` alias → temporal-x chronological → inherently-ordered-x
  (numeric/date/bucket via `detectAxisOrdered`) → value-desc. This is the "auto
  axis-order for ordered axes" default (delivers age 0→100 out of the box).
- **`applyChartSort`** orders rows (never `seriesKeys` — legend/stack order is
  orthogonal). `compareCategory` precedence: Date → temporal key → pure number →
  numeric bucket ("0-10" by leading number) → numeric-collation lexical; nulls
  always last in BOTH directions. Multi-series "value" = ROW TOTAL across series.
- **maxRows is decoupled from display order:** VALUE sort orders by direction
  then slices (preserves MW3 bottom-N/top-N); CATEGORY sort selects the top-N BY
  VALUE first, then orders that set by the axis.

## Non-breaking guarantees

- The auto-default is **resolved and baked into `spec.sort` at build time on the
  server** (`processChartData`). Charts already persisted have NO `sort` field
  and their `data` is already ordered, so the client (`useChartSort`) renders
  them in saved order and never retroactively reorders them — only freshly built
  charts get the new default.
- `sort` lives on `chartSpecSchema`, which is referenced **by value** by the
  message / dashboard / sheet schemas, so it propagates to every persisted
  surface without a mirror (cf. lesson L-021).
- Persistence uses the canonical seams: chat → `mutateChatDocument` (invariant
  #9) via `PATCH /api/sessions/:id/messages/:ts/charts/:idx/sort`; dashboard →
  the extended `PATCH /api/dashboards/:id/charts/:idx` (dual-write to the sheet
  and the legacy flat charts array). The client re-orders instantly in-memory;
  the PATCH is fire-and-forget durability.

## Consequences

- Grouped/stacked value-sort changed from first-series-only to row-total — a
  deliberate, more-correct behavior change.
- Temporal line/area and correlation bars are untouched (still chronological /
  analyzer-ordered); the visible control is gated to bar/column charts.
- The pivot→chart preview seeds its sort from the pivot's `rowSort`
  (`rowLabel→category`, `measure→value`) so a sorted pivot opens its chart in the
  same order.
