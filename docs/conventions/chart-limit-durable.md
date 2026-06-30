# Durable chart `limit` (Top-N / Bottom-N selection)

**TL;DR:** `chartSpec.limit = { mode: "top" | "bottom", n }` is the **persisted** Top-N /
Bottom-N selection for categorical bar/column charts. It is the durable sibling of
the ephemeral client `ChartLimit` (`client/src/components/charts/ChartLimitControl.tsx`).

## Why it exists

High-cardinality bar charts (e.g. ~90 brands) used to be truncated **destructively**
at build time by the dashboard feature sweep — `bucketTopAndBottom` kept only the
top-8 + bottom-8 by mean and **dropped the middle**, baking a 16-row array into the
persisted `data`. The chart then sorted those 16 by value-desc, so it *looked* like
a continuous top-16 ranking but was actually best+worst with the middle invisible —
and the "View all … as a sortable table" path (which reads the same `data`) could not
reach the dropped rows either. See the wave that introduced this convention.

## The contract

- **Schema:** `chartLimitSpecSchema` + `limit?` on `chartSpecSchema`
  (`server/shared/schema/charts.ts`). Declared field → propagates **by value** to
  every persisted surface (message / dashboard / sheet schemas) with no mirror, the
  same property `sort` relies on (lesson L-021). The client gets it automatically via
  the `client/src/shared/schema.ts` re-export.
- **Decoupled from display order and from `maxRows`.** `applyChartSort`
  (`server/shared/chartSort.ts`) runs `limit` FIRST, by value
  (`selectTopNByValue` / `selectBottomNByValue`), then orders the survivors by `sort`.
  `processChartData` reads only `maxRows` (never `limit`), so baking `limit` while
  leaving `maxRows` unset embeds the **full** category set and lets `limit` ride along
  as render-only metadata.
- **Selection narrows what RENDERS, never what `data` carries.** The full category set
  stays in `data`; the inline renderer applies `limit` for display, while the pivot /
  "View all … as a sortable table" path ignores `limit` and shows every record.
- **Baked default:** the feature sweep bakes `{mode:"top", n:15}` on high-cardinality
  bar charts so they default to an honest Top-15 instead of a best+worst merge.
- **Live, durable control:** the inline `ChartLimitControl` on a dashboard tile toggles
  it and persists via the dashboard charts PATCH (dual-write to the sheet chart and the
  legacy flat `charts` array); the fullscreen modals seed their state from `chart.limit`.

## Rule

Do **not** drop rows from `chartSpec.data` to "limit" a bar chart. Embed the full set
(up to the feature sweep's `EMBED_CAP`) and set `limit` instead. A user must always be
able to reach every record via the table.
