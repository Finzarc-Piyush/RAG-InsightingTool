# Convention: Dynamic x-axis label density (rotate-to-fit)

> Introduced in Wave W-XAX1 (2026-06-22). See `docs/WAVES.md` for the original context.

## Rule

The number of x-axis tick **labels** a chart shows is decided dynamically — never a
magic number. Every chart surface (chat, dashboard, generate-charts/Explore, and the
recharts modals) delegates to the single authority
[`xAxisTickBudget`](../../client/src/lib/charts/xAxisLabelCap.ts), which returns
`{ max, rotateDeg }`:

- `max = min(no-overlap-width-fit, dataPointCount)` — you can never label more buckets
  than exist, and width governs when it is the tighter bound. The only absolute cap is
  `ABS_MAX_X_AXIS_LABELS` (200), a pathological-DOM backstop, **not** a UX target.
- `rotateDeg = -45` when labels are long (`widest > 6` chars) OR numerous (`count > 12`),
  else `0`. Long/many labels **tilt to fit** more; short/few stay horizontal.

The number of **data points** is never reduced by this — only the labels are thinned
and/or rotated. Use `pickEvenlySpacedTicks` (visx) or `evenlySpacedDataKeys` (recharts)
to thin to `max`. **Both thinners must spread the kept labels across the FULL index
range with a rounded float stride** (`Math.round(i * (n-1)/(target-1))`), pinning the
first and last bucket — never a floored integer stride. A floored stride collapses to 1
when the budget lands in `(n/2, n)` (e.g. 25 of 48), which crams the labels onto a
contiguous left-hand prefix with a blank gap before a lone final label. `evenlySpacedDataKeys`
carried that defect until it was aligned to `pickEvenlySpacedTicks` — see [[L-035]].

## Why

The label cap had **four** enforcement points and the earlier "remove the cap" attempt
fixed only some, so it appeared not to work (the L-020 pattern: one cap, many sites;
the L-019 pattern: a single authority only fixes the bug if its inputs are uniform on
every path):

1. Hardcoded magic bounds (`ABS_MAX=60`, `DEFAULT=10`) with no data-count input.
2. The visx path rendered labels **horizontal**, so a ~10-char date footprint (~74px)
   capped even an 820px fullscreen plot at ~11 — the real "10–11 everywhere".
3. First-paint `useEffect` measurement returned width `0` for a frame → the fixed-10
   fallback flashed.
4. Per-surface params diverged (recharts rotated −45° vs visx horizontal), so the same
   chart showed different densities on different surfaces.

Rotate-to-fit on a shared authority closes all four: ~27px tilted footprint instead of
~74px, identical inputs on every surface, and a data-count ceiling instead of a number.

## How to apply

- **Any new chart renderer with a categorical/temporal x-axis** must call
  `xAxisTickBudget({ axisWidthPx, labels, dataPointCount, fontSizePx })`, feed `.max`
  into its tick thinner, and apply `.rotateDeg` to the axis label props
  (`angle: rotateDeg`, `textAnchor: rotateDeg ? "end" : "middle"`, `dy: rotateDeg ? "0.25em" : undefined`).
- **Reserve bottom margin** (~52px) so −45° labels don't clip.
- **Continuous numeric axes** (scatter/regression) and **no-axis marks** (pie/arc/funnel/
  radar/kpi) do NOT use this — they auto-thin via D3 ticks or have no x labels.
- **ECharts** paths (candlestick, SSR export) use native `interval:"auto" + hideOverlap`,
  which is already area-aware — do not force the JS budget onto them or you double-thin.
- **Width measurement** must be present on first paint: use
  [`useContainerWidth`](../../client/src/hooks/useContainerWidth.ts) (it primes via
  `useLayoutEffect`). When width is genuinely unknown the budget falls back to
  `DEFAULT_MAX_X_AXIS_LABELS`, but the downstream thinners still show all points when the
  data fits, so a small series is never wrongly thinned.

## Related

- [Wave W-XAX1 entry](../WAVES.md)
- Authority: [`client/src/lib/charts/xAxisLabelCap.ts`](../../client/src/lib/charts/xAxisLabelCap.ts)
- Width hook: [`client/src/hooks/useContainerWidth.ts`](../../client/src/hooks/useContainerWidth.ts)
- Renderers: [`client/src/lib/charts/visxRenderers/`](../../client/src/lib/charts/visxRenderers/)
- Lessons [[L-020]] (a max limit has many enforcement points), [[L-019]] (uniform inputs to a single authority)
