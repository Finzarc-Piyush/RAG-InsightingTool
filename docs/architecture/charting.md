# Charting — behavior contract & v2 architecture

This doc has two roles:

1. **Behavior contract** for the legacy
   [client/src/pages/Home/Components/ChartRenderer.tsx](../../client/src/pages/Home/Components/ChartRenderer.tsx)
   (1,820 LOC). It enumerates every prop, state, special case, and
   downstream side effect — the parity checklist that gates Phase 9.4
   deletion.
2. **Forward architecture** for the v2 charting layer (`<PremiumChart>`,
   `<ChartCanvas>`, `<ChartGrid>`, `<ChatChartCard>`,
   `<RawDataProvider>`, ChartSpecV2 grammar). Filled in incrementally
   as waves land.

The full plan and wave breakdown lives in
`/Users/tida/.claude/plans/are-2-things-ever-deep-duckling.md`.

---

## 1. Behavior contract: legacy `ChartRenderer.tsx`

### 1.1 Public props (`ChartRendererProps`)

Definition at [ChartRenderer.tsx:59-73](../../client/src/pages/Home/Components/ChartRenderer.tsx#L59-L73).

| Prop | Type | Purpose | v2 parity requirement |
|------|------|---------|---|
| `chart` | `ChartSpec` (v1) | Spec to render. | ChartShim adapter converts v1 → v2 transparently. |
| `index` | `number` | Position in a multi-chart row (used for color cycling and aria labels). | `<PremiumChart>` accepts an `index` for the same purposes. |
| `isSingleChart` | `boolean?` | When `true`, disables IntersectionObserver lazy-render and uses a larger height (400px vs 250px). | `<PremiumChart>` prop `isSingleChart` keeps both behaviors. |
| `showAddButton` | `boolean?` | Controls visibility of the "Add to dashboard" button in the chart header. | Preserved on `<ChatChartCard>` and `<ChartCanvas>` headers. |
| `useChartOnlyModal` | `boolean?` | Switches the expand-on-click modal between [ChartModal](../../client/src/pages/Home/Components/ChartModal.tsx) (rich) and [ChartOnlyModal](../../client/src/pages/Dashboard/Components/ChartOnlyModal.tsx) (pure). | `<PremiumChart>` `expandModal: 'rich' \| 'only'`. |
| `fillParent` | `boolean?` | When `true`, chart fills its parent container (used by dashboard tiles). Disables lazy-render and compact X-tick mode. | `<PremiumChart>` prop `fillParent` keeps both side-effects. |
| `enableFilters` | `boolean?` | Surfaces the per-chart filter UI (categorical filter chips below the chart). Excluded for line/bar/area when seriesKeys present (legend handles series visibility). | `<FilterChips>` component, only rendered for non-series-multi charts unless explicit `enableFilters`. |
| `filters` | `ActiveChartFilters?` | Controlled filter state. | `<ChartCanvas>` owns this state when uncontrolled; `<ChatChartCard>` passes through if controlled. |
| `onFiltersChange` | `(f: ActiveChartFilters) => void?` | Callback when filters change. | Same. |
| `isLoading` | `boolean?` | Loading state, used by correlation charts during background computation. | Preserved verbatim. |
| `loadingProgress` | `{ processed, total, message? }?` | Progress info for long-running correlation chart loads. | Surfaced as `<SkeletonState progress={…}>` in `<PremiumChart>`. |
| `keyInsightSessionId` | `string \| null?` | Enables on-demand "Key Insight" LLM fetch when the chart has no inline insight, triggered from inside `<ChartModal>`. | `<PremiumChart>` accepts `keyInsightSessionId` and forwards to its modal. Must call same backend route. |

### 1.2 Internal state ([line 172+](../../client/src/pages/Home/Components/ChartRenderer.tsx#L172))

| State | Initial | Used by | v2 parity |
|-------|---------|---------|-----------|
| `isModalOpen` | `false` | Click-to-expand on the chart header. | Same in `<PremiumChart>`. |
| `isDashboardModalOpen` | `false` | "Add to dashboard" button. | Same. |
| `hideOutliers` | `false` | Scatter mark only — toggle in the chart header to hide IQR-detected outliers. | Preserved in scatter renderer; layer toggle in `<LayersPanel>` for `<ChartCanvas>`. |
| `pointOpacity` | `'medium'` | Scatter mark — three-step opacity slider in `<ChartModal>`. | Preserved in scatter renderer settings. |
| `pointDensity` | `'medium'` | Scatter mark — four-step density slider (`low`/`medium`/`high`/`all`) controlling `MAX_RENDER_POINTS`. | Preserved, with same enum values. |
| Legend hidden-series set | (via callback) | Legend toggle (single + toggle-all). | `<ChartLegend>` props `onToggleSeries` and `onToggleAll`. |

### 1.3 Constants

| Constant | Value | Where | v2 parity |
|----------|------:|-------|-----------|
| `MAX_COMPACT_X_TICKS` | `6` | [line 75](../../client/src/pages/Home/Components/ChartRenderer.tsx#L75) | Same constant in `<PremiumChart>` axis config. |
| `LINE_AREA_MAX_X_TICKS` | imported from shared | Used for line/area charts in non-fill mode. | Same. |
| Outlier IQR threshold | `0.1` (paddingFraction default) | [line 201](../../client/src/pages/Home/Components/ChartRenderer.tsx#L201) | Constant in `dataEngine.ts:detectOutliers`. |
| `MAX_RENDER_POINTS` per density | dynamic (`getMaxRenderPoints()`) | [line 437](../../client/src/pages/Home/Components/ChartRenderer.tsx#L437) | Ported into `dataEngine.ts:sample`. |

### 1.4 Per-mark behaviors

#### `bar`

- **Compact X-axis** when `!fillParent && !isSingleChart && chartData.length > MAX_COMPACT_X_TICKS`
  ([line 448](../../client/src/pages/Home/Components/ChartRenderer.tsx#L448)). Picks the
  first 6 categories or the largest 6 by value.
- **Date-detection in compact mode** ([line 454-466](../../client/src/pages/Home/Components/ChartRenderer.tsx#L454-L466)):
  if X looks like dates, takes a chronological slice; otherwise sorts by Y desc.
- **Stacked / grouped** via `chart.barLayout`. Series defined by
  `seriesColumn` + `seriesKeys`.
- **15-series "Others" merging** (per server pipeline; ChartRenderer expects
  pre-merged data). v2: do the merge in `encodingResolver.ts` so the client
  can re-do it after a filter or shelf change.

#### `line`

- **Dual-axis (Y2)** ([line 864-869](../../client/src/pages/Home/Components/ChartRenderer.tsx#L864-L869)):
  when `chart.y2` is set, renders a second left-axis series with a different color
  (`hsl(var(--chart-1))` for left, `chartColor` for right).
- **Multi-series** when `seriesColumn` + `seriesKeys` present; uses
  `RechartsWideLegendContent` with toggle-series and toggle-all callbacks.
- **Trend line** ([line 189](../../client/src/pages/Home/Components/ChartRenderer.tsx#L189)):
  optional `chart.trendLine` array (two points). Rendered as overlay.
- **Dynamic Y domain** ([line 781](../../client/src/pages/Home/Components/ChartRenderer.tsx#L781))
  via `getDynamicDomain(values, paddingFraction=0.1)`. Override with `chart.yDomain`.
- **Dot toggle** in modal — controls `showDots` flag.

#### `area`

- Same dual-axis + multi-series + dynamic domain rules as `line`.
- Stacked area is currently the only mode (no diverging stacks).

#### `scatter`

- **Outlier hiding** (state `hideOutliers`) — toggle in header.
  IQR-based detection ([line 392](../../client/src/pages/Home/Components/ChartRenderer.tsx#L392)).
- **Stratified sampling** ([line 437-445](../../client/src/pages/Home/Components/ChartRenderer.tsx#L437-L445)):
  when point count > `MAX_RENDER_POINTS`, samples every Nth point and slice-caps.
  Density slider (`low`/`medium`/`high`/`all`) controls `MAX_RENDER_POINTS`.
- **Opacity slider** (`low` 0.3 / `medium` 0.6 / `high` 0.9). Used to mitigate
  overplot.
- **Trend line** support same as line.
- **Z-axis (size encoding)** for bubble-style scatter via `chart.z`.
- **Loading progress** when `_isCorrelationChart` flag present
  ([line 1727](../../client/src/pages/Home/Components/ChartRenderer.tsx#L1727)) — shows
  progress overlay while correlation matrix computes server-side.

#### `pie`

- Single-level only.
- "Others" merging server-side.
- Custom tooltip via `formatChartTooltipValue`.

#### `heatmap` ([line 1088](../../client/src/pages/Home/Components/ChartRenderer.tsx#L1088))

- **Custom HSL color scale** based on cell value vs. min/max range.
- **Custom low-to-high legend** below the chart (gradient strip with min/max
  labels).
- **Empty-state** "No numeric values for heatmap." when no Z column.
- Max 40 rows × 24 cols (downsampling beyond this happens server-side in
  [chartGenerator.ts](../../server/lib/chartGenerator.ts)).

### 1.5 Cross-cutting behaviors

#### Lazy-render via IntersectionObserver

[ChartRenderer.tsx:198-200](../../client/src/pages/Home/Components/ChartRenderer.tsx#L198-L200)
+ [line 1566](../../client/src/pages/Home/Components/ChartRenderer.tsx#L1566).
Renders an empty container until the chart enters viewport. Disabled when
`isSingleChart || fillParent || isLoading`. **v2 parity**: same behavior in
`<PremiumChart>` via the same hook (`useIntersectionObserver`).

#### Filter UI

[line 222](../../client/src/pages/Home/Components/ChartRenderer.tsx#L222) +
[line 230](../../client/src/pages/Home/Components/ChartRenderer.tsx#L230) +
[line 275](../../client/src/pages/Home/Components/ChartRenderer.tsx#L275).

- Only enabled for `line`/`bar`/`area` when `enableFilters` is true.
- Filter chips are derived from the original (pre-aggregation) data set.
- Series keys are excluded from filter UI when `seriesColumn` is set —
  the legend handles series visibility instead.

**v2 parity**: `<FilterChips>` component takes `(rows, columns, activeFilters,
onChange)`. Logic ported from `applyChartFilters`.

#### Legend (multi-series)

[RechartsWideLegendContent](../../client/src/lib/rechartsWideLegend.tsx)
component, used at [line 851-856](../../client/src/pages/Home/Components/ChartRenderer.tsx#L851-L856).

Behaviors:
- Wide horizontal layout that wraps when narrow.
- Click-toggle individual series.
- "Toggle all" button (show all / hide all).
- Wide legend shows up only when `seriesKeys.length > 4` or so.

**v2 parity**: `<ChartLegend>` component with `mode: 'compact' | 'wide'`,
`onToggleSeries`, `onToggleAll` props.

#### Tooltip

`formatChartTooltipValue` and `rechartsTooltipValueFormatter` from
[client/src/lib/chartNumberFormat.ts](../../client/src/lib/chartNumberFormat.ts).
Format rules:
- Currency-detection by column name keywords.
- K/M/B suffixes.
- Date formatting via `formatDate` (date-fns).

**v2 parity**: same formatters reused from a shared module
(`client/src/lib/charts/format.ts`). Tooltip itself is a React component
(`<ChartTooltip>`) styled with semantic tokens.

#### Modal expansion

Three modal types:
- [ChartModal](../../client/src/pages/Home/Components/ChartModal.tsx) — rich
  modal with inline insights, settings sliders (scatter density/opacity), and
  optional Key Insight fetch.
- [ChartOnlyModal](../../client/src/pages/Dashboard/Components/ChartOnlyModal.tsx)
  — pure expand-only modal used by dashboard tiles.
- [DashboardModal](../../client/src/pages/Home/Components/DashboardModal/DashboardModal.tsx)
  — "Add to dashboard" button target.

**v2 parity**: `<PremiumChart>` exposes `onExpand` callback; the consumer
chooses which modal to mount. `<ChartCanvas>` mounts its own larger view
inline (no modal needed for editing).

#### Dynamic axis domain

`getDynamicDomain` ([line 125](../../client/src/pages/Home/Components/ChartRenderer.tsx#L125))
adds 10% padding above/below the value range. Used when `yDomain` not
explicitly set. Returns `[min - pad, max + pad]`.

**v2 parity**: identical helper in `client/src/lib/charts/scales.ts`.

#### Series sort + topN

When `seriesKeys` is provided by the spec, ChartRenderer trusts it as the
canonical render order. Server pre-sorts and merges low-volume series into
"Others" (15-series cap).

**v2 parity**: `<EncodingResolver>` (and `dataEngine.ts:topNAndOther`) handle
this client-side now, so a filter or shelf change can re-derive the
ordering without a server roundtrip.

### 1.6 External dependencies (must be replicated or imported)

| Module | Purpose |
|--------|---------|
| `recharts` | Renderer (will be removed in Phase 9). |
| [@/lib/chartNumberFormat](../../client/src/lib/chartNumberFormat.ts) | Tooltip + axis number formatting. **Reused as-is.** |
| [@/lib/rechartsWideLegend](../../client/src/lib/rechartsWideLegend.tsx) | Wide multi-series legend. Logic re-implemented in `<ChartLegend>`. |
| [@/lib/chartFilters](../../client/src/lib/chartFilters.ts) | Filter state shape + `applyChartFilters`. **Reused as-is** (or behind `dataEngine.ts`). |
| [@/hooks/useIntersectionObserver](../../client/src/hooks/useIntersectionObserver.ts) | Lazy-render. **Reused as-is.** |
| `chartRechartsShared` | Shared Recharts config (color cycle, axis defaults). **Replaced** by `<PremiumChart>` config in v2. |
| `LINE_AREA_MAX_X_TICKS` | Constant. **Reused as-is.** |
| `formatDate` (date-fns) | Date formatting. **Reused as-is.** |
| `getDynamicDomain` (local helper) | Axis padding. **Ported** to `client/src/lib/charts/scales.ts`. |

---

## 2. Parity checklist for Phase 9.4 deletion

Before deleting `ChartRenderer.tsx`, every item below must pass under
`<PremiumChart>` for **all six existing marks** with **production session
log payloads** (pulled from real chat answers / pivot panels / dashboard
tiles).

### Visual parity
- [ ] Pixel diff vs. legacy ≥ 90% similarity at default settings.
- [ ] Light theme + dark theme both pass.
- [ ] Tooltip number formatting matches (currency, K/M/B, dates).
- [ ] Axis tick count matches in both `fillParent=true` and default.
- [ ] Compact X-axis behavior at `chartData.length > 6 && !fillParent && !isSingleChart`.
- [ ] Heatmap HSL color scale + custom legend gradient.
- [ ] Pie chart "Others" merging at server cap.

### Interaction parity
- [ ] Lazy-render under IntersectionObserver (verify with off-screen chart not rendering).
- [ ] Click chart header → opens correct modal (rich vs. only) per `useChartOnlyModal`.
- [ ] "Add to dashboard" button visible per `showAddButton`.
- [ ] Filter chip toggle under `enableFilters`.
- [ ] Filter chips exclude series keys in multi-series mode.
- [ ] Multi-series legend toggle (individual + toggle-all).
- [ ] Scatter outlier toggle + IQR-based hide/show.
- [ ] Scatter density slider four-step + `MAX_RENDER_POINTS` honored.
- [ ] Scatter opacity slider three-step.
- [ ] Dual-axis line (Y2) renders both axes with distinct colors.
- [ ] Trend line overlay when `chart.trendLine` set.
- [ ] Loading progress overlay on correlation scatter.

### Data parity
- [ ] Same row count after filtering.
- [ ] Same series ordering.
- [ ] Same numeric values (no rounding regressions).
- [ ] Stratified sampling reproduces same point count for given density.

### Modal / hook parity
- [ ] Key Insight fetch works under `keyInsightSessionId` (Network tab confirms request).
- [ ] Dashboard modal opens correctly from "Add to dashboard".
- [ ] Modal scatter sliders persist state across open/close.

### Performance parity
- [ ] Render time of a 5K-row scatter not regressed.
- [ ] Bundle size delta net-positive after Recharts removal (-90KB) vs.
      Visx + ECharts gain.
- [ ] No memory leak on repeated re-renders (DevTools heap snapshot).

### Storybook gallery
- [ ] One story per mark × at least 3 production payloads.
- [ ] Side-by-side legacy vs. v2 view, with pixel-diff overlay.
- [ ] Two weeks of zero per-mark feature-flag flips before deletion (per WC9.4 risk plan).

---

## 3. Forward architecture (filled in by waves)

### 3.1 Component tree

> Filled in by WC0.3 (`<PremiumChart>` core), WC2.6 (`<ChartCanvas>`),
> WC2.7 (`<ChatChartCard>` + Fork to Explorer), WC6.2 (`<ChartGrid>`).

### 3.2 ChartSpecV2 grammar

> Filled in by WC0.2. Schema lives in
> [server/shared/schema.ts](../../server/shared/schema.ts).

### 3.3 Data engine

> Filled in by WC2.1 (`<RawDataProvider>`) and WC2.2 (`dataEngine.ts`).

### 3.4 Theme tokens

> Filled in by WC1.4 (palette CSS variables in
> [client/index.css](../../client/index.css)) and updates to
> [client/THEMING.md](../../client/THEMING.md).

### 3.5 Per-mark feature flags

> Filled in by WC0.1 (`client/src/lib/charts/featureFlags.ts`). Each mark
> defaults `false` (use legacy ChartRenderer) until the v2 renderer for
> that mark passes parity tests, then flips to `true`. Two weeks of zero
> flips before deleting the legacy renderer in WC9.4.

---

## 4. Outstanding questions surfaced during the contract audit

1. **Heatmap legend ownership**: legacy renders a custom HSL gradient
   strip below the chart. v2 should do this in `<ChartLegend>` with a
   `mode: 'gradient'` variant — confirm this works for ECharts heatmap
   too (or does ECharts heatmap own its own legend?).
2. **`_isCorrelationChart` private flag** on the spec drives the loading
   progress overlay for correlation charts. v2 should formalize this as
   a `config.loadingState: 'computing'|'sampling'|'idle'` instead of an
   underscore-prefixed flag.
3. **Scatter density slider** persists per-modal-open in legacy; v2
   should consider per-message persistence (so reopening the chart in
   the same chat turn keeps the user's setting).
4. **15-series "Others" cap** is currently server-side; moving it
   client-side (so post-filter re-aggregation can re-merge) requires
   the agent's spec to ship the *unmerged* series count or all series
   keys. Confirm with WC7.1 (visualPlanner v2 migration).

These should be resolved in WC0.2 (schema design), WC0.3 (PremiumChart
core), or escalated to the user if they change the v2 contract shape.

---

## 5. Activation knobs (Fix-6)

### 5.1 Per-mark feature flag

Every chart in chat / pivot / dashboards flows through `<ChartShim>`,
which routes to either the legacy `ChartRenderer` or the new
`<PremiumChart>` based on a per-mark feature flag. Resolution order:

1. **Build-time env**: `VITE_USE_PREMIUM_<TYPE>=true` (set in
   `client/client.env`).
2. **Runtime localStorage** (dev / QA / staged rollout):
   `localStorage.setItem('chart.premium.<type>', 'true')` (where
   `<type>` is `bar`, `line`, `area`, `scatter`, `pie`, `heatmap`).
3. **Default** in
   [client/src/lib/charts/featureFlags.ts](../../client/src/lib/charts/featureFlags.ts)
   — currently `false` for every type, so legacy is the default.

Flip a single key, reload; that chart type renders through the v2
pipeline (`<PremiumChart>` + Visx / lazy ECharts) wherever it appears.

### 5.2 Server `_autoLayers`

The server emits `_autoLayers` on v1 ChartSpec via
[server/lib/charts/autoAttachLayers.ts](../../server/lib/charts/autoAttachLayers.ts).
Triggered after `enrichCharts` in
[server/services/chat/chatStream.service.ts](../../server/services/chat/chatStream.service.ts);
each chart on every chat answer is offered up for auto-layer
attachment.

What the regex looks for in the user's question:

| Layer | Trigger phrase example | Mark gate |
|------|----------------------|-----------|
| `reference-line` | *"target of $5M"*, *"100K threshold"* | line / area / bar / scatter only (Fix-2) |
| `trend` | *"how is X trending"* | line / area / scatter only |
| `forecast` | *"forecast next 4 quarters"* | line / area / scatter only |
| `outliers` | *"any anomalies / spikes / dips"* | line / area / scatter only |
| `comparison` | *"vs prior period"*, *"YoY"* | line / area / scatter only |

False-positive guards (Fix-2):
- Reference-line target detection requires either a currency symbol
  *or* a K/M/B/T magnitude suffix on the captured number.
- "dip(?:s|ped|ping)?" word boundary so "diplomat" / "diploma" /
  "diphenyl" don't trigger outlier callouts.

Kill switch:
```
AUTO_ATTACH_LAYERS_ENABLED=false
```
in `server/server.env` disables the entire feature globally if regex
misfires in production.

The legacy renderer ignores `_autoLayers` — it's an opaque optional
field on the v1 ChartSpec. The client `<ChartShim>` v1→v2 converter
forwards it into `ChartSpecV2.layers` so `<PremiumChart>` renders
the inferred analytical overlays.

### 5.3 Fork-to-Explorer

Chat charts are read-only. The
[ChatChartCard](../../client/src/components/charts/ChatChartCard.tsx)
ships a `Fork` button that encodes the active spec as a URL hash and
navigates to `/explore` — a `<ChartCanvas>` with full editing:

- `MarkPicker` (one-click chart-type swap)
- `EncodingShelves` (click-to-pick column shelves for X / Y / Color /
  Size / Shape / Facet)
- `SuggestedAlts` (heuristic recommendations when current chart shape
  is suboptimal)
- `ExportMenu` (PNG / SVG / CSV)
- All analytical layers from the agent's `_autoLayers` are preserved.

URL hash format: `#spec=<base64-json>`. Inline data is *omitted* from
the hash to keep URLs sane; rows are pulled from `<RawDataProvider>`
when the source kind is `session-ref`.

### 5.3.1 Chat ↔ pivot capability parity

Chat charts now flow through
[InteractiveChartCard](../../client/src/components/charts/InteractiveChartCard.tsx)
→ `ChartShim` → (v2 `PremiumChart` | v1 `ChartRenderer`). The wrapper
adds an in-card toolbar that mutates a local copy of the spec — no
server roundtrip — to give chat surface parity with the pivot
preview's controls:

- **Mark switch** (bar / line / area). Hidden when the original mark
  isn't switchable (pie, scatter, heatmap stay as the agent chose).
  Switching strips bar-only fields (`barLayout`) but preserves
  `x` / `y` / `seriesColumn` / `seriesKeys`.
- **Stacked / grouped** layout toggle. Only rendered when the active
  mark is `bar` AND `seriesKeys.length > 1` (single-series bars have
  no stack to toggle).
- **Filter chips** remain owned by `ChartRenderer.enableFilters`. The
  wrapper does not duplicate that UI.

Pivot's preview keeps its existing external selectors for chart-type
and bar-layout (`DataPreviewTable.tsx`); it does not yet wrap through
`InteractiveChartCard` because the external controls also drive the
server pivot query (e.g. switching to scatter changes the pivot
request shape). Consolidating to a single source of truth is a later
refactor; today both surfaces expose the same capability set, just
through different controls.

### 5.3.2 Pivot field list — capped available zone

[PivotFieldPanel](../../client/src/pages/Home/Components/pivot/PivotFieldPanel.tsx)
caps the "Choose fields to add" zone with internal scroll
(`maxAvailableVisible` prop, default 5; expanded pivot dialog passes
10) so the selected zones (Filters / Columns / Rows / Values) stay
visible without panel-wide scrolling. `@dnd-kit` auto-scroll is
configured at the `DndContext` level so dragging from a deep unused
item into a selected zone walks both the inner and outer scrollers.

### 5.3.3 Chart key insight — client-side cache

[DataPreviewTable](../../client/src/pages/Home/Components/DataPreviewTable.tsx)
fires `POST /api/sessions/:sessionId/chart-key-insight` after the
chart preview settles, keyed by the existing `chartConfigHash` (which
already encodes the pivot query and filter selections). The insight
renders directly below the chart in both the small and expanded
chart views and survives Chart↔Pivot tab toggles without refetching;
only a config change bumps the hash and triggers a new call. A
sequence ref drops stale responses when the user changes config
mid-flight.

### 5.5 Recent changes — dashboard global filter bar

- **Wave WD2-dim-echarts-rest (2026-05-19)** — closes the WD2-dim-* family. SankeyRenderer + CalendarRenderer + CandlestickRenderer (in [`SpecialtyRenderers.tsx`](../../client/src/lib/charts/echartsRenderers/SpecialtyRenderers.tsx)) per-dataItem dim via separate `dimmedX` memos with identity short-circuit on dim-OFF. Sankey per-node dim on `sourceCh.field`, edges un-dimmed (same carve-out as WD2-wiring-echarts dispatch). Calendar per-cell dim on `dateCh.field` via mixed-shape array (matching cells stay as `[date, value]` tuples, non-matching promoted to `{ value: [date, value], itemStyle: { opacity: 0.4 } }`); range + visualMap min/max read pre-wave `series` so tuple destructuring stays safe. Candlestick per-bar dim on `xCh.field` via `xs[i]` membership (NOT OHLC tuple values — those are quantitative). `optionsKey` field name kept as pre-wave key (`nodes` / `series`) so dim-off JSON is byte-identical (no canvas re-render on mount). 23 source-inspection tests across 4 suites in [`wd2DimEchartsRest.test.ts`](../../client/src/pages/Dashboard/lib/wd2DimEchartsRest.test.ts). WD2-dim-* family now spans 10 visx + 5 ECharts = 15 chart kinds with a categorical filter target — matches the WD2-wiring family end-to-end. See `docs/WAVES.md` for full entry.
- **Wave WD2-dim-echarts-treemap (2026-05-19)** — first wave on the WD2-dim-echarts series. [`TreemapRenderer.tsx`](../../client/src/lib/charts/echartsRenderers/TreemapRenderer.tsx) + SunburstRenderer (in [`SpecialtyRenderers.tsx`](../../client/src/lib/charts/echartsRenderers/SpecialtyRenderers.tsx)) leaf-only dim on `labelCh.field`. Diverges from the visx pack's post-render React-prop mutation mechanism: ECharts mounts its own canvas via `EChartsBase` and reads per-dataItem styling from `itemStyle.opacity` at series-construction time, so the dim factor must be injected inline into the dataItem objects inside each renderer's `tree` memo. Both `TreemapNode.itemStyle` + `SunburstNode` interfaces widened to allow `opacity?: number`. Triplet lifted BEFORE the `tree` memo (consumed at build time). A local `dimLeaf(name): NodeType["itemStyle"] | undefined` arrow returns `{ opacity: 0.4 }` for non-matching leaves, `undefined` for matching; both flat (`!groupCh`) and hierarchical projections use the conditional spread (`itemStyle ? { name, value, itemStyle } : { name, value }`) so matching leaves emit a byte-identical pre-wave shape — keeps `optionsKey = JSON.stringify({ tree, w, h })` stable on dim-off transitions. Tree memo deps widened to include `dashboardDimActive` + `dashboardFilters` so dim-state changes rebuild the tree and trigger ECharts re-render via `optionsKey`. Parents stay un-dimmed (structural hierarchy; mirrors the WD2-wiring-echarts leaf-only dispatch carve-out — parent-ring filtering would need a two-column dispatch shape, deferred). 19 source-inspection tests across 7 suites in [`wd2DimEchartsTreemap.test.ts`](../../client/src/pages/Dashboard/lib/wd2DimEchartsTreemap.test.ts). WD2-dim-* family now spans 10 visx + 2 ECharts renderers. Remaining: WD2-dim-echarts-rest (Sankey + Calendar + Candlestick — each per-renderer dataItem shape: nodes-array promotion for Sankey, tuple → object promotion for Calendar, parallel itemStyle-by-index array for Candlestick OHLC tuples). See `docs/WAVES.md` for full entry.
- **Wave WD2-dim-point (2026-05-19)** — [`PointRenderer.tsx`](../../client/src/lib/charts/visxRenderers/PointRenderer.tsx) scatter per-point dim on `colorCh.field`. Closes the WD2-dim-* family for every visx renderer with a categorical filter target (10 of 10: bar + cat-5 + rect + line + area + point). Diverges from WD2-dim-trend's per-series shape because scatter marks are individually filter-targetable — WD2-wiring-rest-point's dispatch is per-point on `p.rawColor`, so the dim is per-point too. `isCrossFilterActive` added to the crossFilter named-import alongside `dispatchCrossFilter` + `toFilterValue`. Triplet lifted right after the existing `crossFilterReady` gate (dispatch + dim share the exact same applicability domain `!!dashboardTile && !!colorCh` so they stay opt-in together — co-located as a discoverable pair): `dashboardFilters = dashboardTile?.filters`; `colorFilterSel = colorCh ? dashboardFilters?.[colorCh.field] : undefined`; `dashboardDimActive = !!colorCh && !!colorFilterSel && colorFilterSel.type === "categorical" && colorFilterSel.values.length > 0`. Inside `points.map`, after `cx` / `cy` lift but BEFORE the `if (shapeCh)` render branching, per-point `isDashboardDimmed = dashboardDimActive && !isCrossFilterActive(dashboardFilters!, colorCh!.field, p.rawColor)` (non-null assertions safe because `dashboardDimActive` AND-gates on `!!colorCh`; `p.rawColor` not `p.colorKey` because non-string color dims stringify differently via `asString` vs. `toFilterValue`). Single `dimMul = isDashboardDimmed ? 0.4 : 1` lifted once per point so the fill (`0.7 * op`) and the stroke (`op`) both consume the same factor on whichever branch renders — a dimmed fill with a non-dimmed ring would render as a faded dot with a stark outline. Both render branches mutate to multiply `dimMul`: glyph `<path>` (shape-encoded scatter) gains `fillOpacity={0.7 * op * dimMul}` + `strokeOpacity={op * dimMul}`; plain `<Circle>` (default scatter) takes the identical composition. Opacity-only contract preserved across the family (no outline for matching points). Mirrors WD2-dim-area's `dimMul`-shared-between-fill-and-stroke pattern at per-iteration granularity (area dims once per series; point dims once per point). 19 source-inspection tests across 7 suites in [`wd2DimPoint.test.ts`](../../client/src/pages/Dashboard/lib/wd2DimPoint.test.ts). Remaining: WD2-dim-echarts (5 ECharts marks via itemStyle.opacity per dataItem at the buildOptions level). See `docs/WAVES.md` for full entry.
- **Wave WD2-dim-trend (2026-05-19)** — [`LineRenderer.tsx`](../../client/src/lib/charts/visxRenderers/LineRenderer.tsx) + [`AreaRenderer.tsx`](../../client/src/lib/charts/visxRenderers/AreaRenderer.tsx) per-series dim on `colorCh.field`. Trend renderers have continuous-x marks (lines / stacked areas) so the per-mark dim shape doesn't apply — dim concept is per-SERIES: when an active categorical cross-filter on `colorCh.field` doesn't include a series's `rawColor`, the series's stroke / fill opacities multiply by 0.4. Both `Series` interfaces gain `rawColor?: unknown` (preserved from the first occurrence per colorCh group; the colorCh group builders refactored from per-row push into `Map<string, { points, rawColor }>` so the type-original color value survives). Triplet lifted on `colorCh.field` with `!!colorCh` gate so single-series trends skip dim entirely + the `colorCh!.field` non-null assertion inside the map is type-safe. LinePath strokeOpacity composes `op * (isDashboardDimmed ? 0.4 : 1)` preserving the legend-opacity factor. AreaRenderer lifts a single `dimMul` shared between `<AreaClosed fillOpacity={0.55 * op * dimMul}>` + `<LinePath strokeOpacity={op * dimMul}>` so a dimmed area and its outline stay visually coherent. AreaRenderer's stacked memo propagates `rawColor` via spread (`{ ...s, points: stackedPoints }`). 19 source-inspection tests across 5 suites in [`wd2DimTrend.test.ts`](../../client/src/pages/Dashboard/lib/wd2DimTrend.test.ts). WD2-dim-* family now spans 9 of 13 visx renderers (bar + cat-5 + rect + line + area). Remaining: WD2-dim-point (scatter per-point on colorCh), WD2-dim-echarts (5 ECharts marks via itemStyle.opacity per dataItem). See `docs/WAVES.md` for full entry.
- **Wave WD2-dim-rect (2026-05-19)** — [`RectRenderer.tsx`](../../client/src/lib/charts/visxRenderers/RectRenderer.tsx) heatmap cells dim via OR-of-row-OR-col. Cells sit at the intersection of `rowCh` × `colCh`, so the dim contract diverges from every prior WD2-dim-* wave (single x-field). The wave lifts TWO independent triplets (`rowFilterSel` / `dashboardRowDimActive` on `rowCh.field`; `colFilterSel` / `dashboardColDimActive` on `colCh.field`) right after `useDashboardTileContext()`. Inside the per-cell `.map(...)`, `isRowDimmed = dashboardRowDimActive && !isCrossFilterActive(dashboardFilters!, rowCh.field, rowRawByKey.get(row))`; `isColDimmed = ...colCh.field, colRawByKey.get(col)`; `isDashboardDimmed = isRowDimmed || isColDimmed`. The OR contract gives "show cells surviving the filter intersection" — a cell at full opacity iff it passes BOTH the row AND col filters; cells failing either fade. Asymmetric with WD2-wiring-rest-rect's AND-dispatch shape (both events fire on click): dispatch models "the user picked this (row, col) intersection — apply both filters"; dim models "show me the surviving intersection". Reuses the `rowRawByKey` / `colRawByKey` maps WD2-wiring-rest-rect already built so non-string dims (Date / numeric / boolean) match correctly via raw lookups. Cell `<rect>` gains `fillOpacity={isDashboardDimmed ? 0.4 : 1}`; the 0.5-px background stroke + title tooltip stay untouched (structural grid lines + quantitative readout, not the filterable mark). 13 source-inspection tests across 6 suites in [`wd2DimRect.test.ts`](../../client/src/pages/Dashboard/lib/wd2DimRect.test.ts). WD2-dim-* family now spans 7 of 13 visx renderers (bar + cat-5 + rect). Remaining: WD2-dim-trend (Line + Area per-series on colorCh), WD2-dim-point (scatter conditional on colorCh), WD2-dim-echarts (5 ECharts marks via itemStyle.opacity per dataItem). See `docs/WAVES.md` for full entry.
- **Wave WD2-dim-cat (2026-05-19)** — 5 categorical visx renderers ([`ArcRenderer`](../../client/src/lib/charts/visxRenderers/ArcRenderer.tsx), [`FunnelRenderer`](../../client/src/lib/charts/visxRenderers/FunnelRenderer.tsx), [`BoxRenderer`](../../client/src/lib/charts/visxRenderers/BoxRenderer.tsx), [`WaterfallRenderer`](../../client/src/lib/charts/visxRenderers/WaterfallRenderer.tsx), [`ComboRenderer`](../../client/src/lib/charts/visxRenderers/ComboRenderer.tsx)) fan out the WD2-dim-bar pattern. Each renderer lifts `dashboardFilters / xFilterSel / dashboardDimActive` on its primary x-field once per render (`labelCh.field` for Arc; `enc.x.field` for Funnel / Box / Waterfall; `xCh.field` for Combo); inside its per-mark map, `isDashboardDimmed = dashboardDimActive && !isCrossFilterActive(dashboardFilters!, <xField>, <rawValue>)` checks the renderer-specific raw value identifier (`arc.data.rawKey` / `s.rawLabel` / `s.rawCategory` / `b.rawCategory` / `rawX`); the mark's `fillOpacity` composes `baseline * (isDashboardDimmed ? 0.4 : 1)` preserving each mark's existing translucency baseline (Arc 1; Funnel 0.85; Box 0.4; Waterfall 0.85; Combo 0.85). Carve-outs mirror the WD2-wiring-rest-cat dispatch carve-outs: Waterfall running-total bars (`b.isTotal`) AND-gated out of dim (synthetic summary rows, not categorical marks); Combo secondary-axis `<LinePath>` stays untouched (a continuous trend dimmed by a categorical filter would render as a gappy interleave). Box whiskers + median stroke also stay full opacity — they're structural geometry the user reads for distribution comparison even on non-matching categories. 27 source-inspection tests across 6 suites in [`wd2DimCat.test.ts`](../../client/src/pages/Dashboard/lib/wd2DimCat.test.ts). WD2-dim-* family now spans 6 of 13 visx renderers (bar + cat-5). Remaining: WD2-dim-rect (heatmap OR-of-row-OR-col), WD2-dim-trend (Line + Area per-series on colorCh), WD2-dim-point (scatter conditional on colorCh), WD2-dim-echarts (5 ECharts marks via itemStyle.opacity per dataItem at the buildOptions level). See `docs/WAVES.md` for full entry.
- **Wave WD2-dim-bar (2026-05-19)** — first renderer wave on the WD2-dim-* family. [`BarRenderer.tsx`](../../client/src/lib/charts/visxRenderers/BarRenderer.tsx) lifts `dashboardFilters = dashboardTile?.filters` + `xFilterSel = dashboardFilters?.[enc.x.field]` + `dashboardDimActive = !!xFilterSel && xFilterSel.type === "categorical" && xFilterSel.values.length > 0` once per render (right after the existing `useDashboardTileContext()` call); inside `cells.map`, `isDashboardDimmed = dashboardDimActive && !isCrossFilterActive(dashboardFilters!, enc.x.field, c.outerRaw)` runs per bar; the `fillOpacity` ternary extends from `(isFiltered ? 1 : grid.inGrid && grid.filter ? 0.4 : 1)` to `(isFiltered ? 1 : grid.inGrid && grid.filter ? 0.4 : isDashboardDimmed ? 0.4 : 1)`. The chat/explorer (`grid.inGrid`) branch stays first because `grid.inGrid` and `dashboardTile` are mutually exclusive contexts — so the new dashboard dim branch only fires when the chat/explorer one doesn't. [`isCrossFilterActive(global, column, value)`](../../client/src/pages/Dashboard/lib/crossFilter.ts) signature widened from narrow `string | number | boolean | null | undefined` to `unknown` (matches the WD2-wiring-bar `toFilterValue` widening precedent — the body already calls `toFilterValue(value)` which accepts `unknown`); lets renderers pass `BarCell.outerRaw` (typed `unknown`) without a cast. Opacity-only: no stroke / outline added for matching bars (the existing `isFiltered` stroke is chat/explorer-only) because outlining matched bars across every dashboard tile would be visually noisy. 16 source-inspection tests across 6 suites in [`wd2DimBar.test.ts`](../../client/src/pages/Dashboard/lib/wd2DimBar.test.ts). Follow-on family: WD2-dim-cat (Arc/Funnel/Box/Waterfall/Combo), WD2-dim-rect (two-dim row OR col), WD2-dim-trend (Line/Area), WD2-dim-point (scatter on colorCh), WD2-dim-echarts (5 ECharts marks via itemStyle.opacity per dataItem). See `docs/WAVES.md` for full entry.
- **Wave WD2-dim-foundation (2026-05-19)** — [`dashboardTileContext`](../../client/src/pages/Dashboard/lib/dashboardTileContext.tsx) carries optional `filters: ActiveChartFilters`. `DashboardTileContextValue` + `DashboardTileProviderProps` both gain the new field; the `useMemo` body spreads `filters` conditionally (`undefined → omit`) so callers omitting filters get a value byte-identical to the pre-wave shape — important because upcoming dim-renderer guards can rely on `value.filters !== undefined` as a "dashboard-side context active" sentinel. Type-only `ActiveChartFilters` import keeps the runtime bundle untouched (dashboardTileContext is mounted on every dashboard tile and changes to its bundle ripple through SplitView code-splitting). [`ChartTileBody`](../../client/src/pages/Dashboard/Components/ChartTileBody.tsx) threads the existing `filters` prop into `<DashboardTileProvider filters={filters}>` — a two-character JSX edit; the prop was already on the body since WI2-wire-bind. Unlocks the WD2-dim-bar / -cat / -rect / -trend / -point / -echarts follow-on family where each renderer reads `dashboardTile.filters` via `useDashboardTileContext()`, calls [`isCrossFilterActive(global, column, value)`](../../client/src/pages/Dashboard/lib/crossFilter.ts) per mark, and multiplies opacity by ~0.4 for marks whose categorical value isn't in the active selection (the visual feedback half of the WD2-wiring family — "filtered tiles dim non-matching marks instead of removing them" per the 1000x master plan Workstream 4 UX). 13 source-inspection tests across 4 suites in [`wd2DimFoundation.test.ts`](../../client/src/pages/Dashboard/lib/wd2DimFoundation.test.ts); two existing assertions in `dashboardTileContext.test.ts` re-pinned to match the new memo shape + provider JSX. See `docs/WAVES.md` for full entry.
- **Wave WD2-wiring-echarts (2026-05-19)** — ECharts specialty pack wired to `dispatchCrossFilter`. [`EChartsBase`](../../client/src/lib/charts/echartsRenderers/EChartsBase.tsx) gains an optional `onChartClick?: (params: unknown) => void` prop with a ref-tracked callback so a single `inst.on('click', ...)` bind at mount picks up renderer-side identity changes without unbind/rebind. The bind is placed AFTER `inst.setOption(...)` in the init() async block — ECharts requires the instance to be initialised + options applied before event binding takes effect. Five specialty renderers (Treemap + Sunburst in [`TreemapRenderer.tsx`](../../client/src/lib/charts/echartsRenderers/TreemapRenderer.tsx) and [`SpecialtyRenderers.tsx`](../../client/src/lib/charts/echartsRenderers/SpecialtyRenderers.tsx); Sankey, Calendar, Candlestick in `SpecialtyRenderers.tsx`) each read `useDashboardTileContext()` once, build a per-renderer `useCallback` handler that translates the renderer-specific `params` shape into a `dispatchCrossFilter` call, and pass `onChartClick={dashboardTile ? handler : undefined}` so chat / explorer / share-preview surfaces stay click-inert at the ECharts instance level. Treemap + Sunburst dispatch leaf-only (`!Array.isArray(p.data.children) || .length === 0`) on `labelCh.field` — parent-group clicks are skipped because the dispatch column would diverge between rings (two-column dispatch a la RectRenderer is a follow-on). Sankey dispatches node-only (`params.dataType === 'node'`, edges skipped — no single categorical value to filter on) on `sourceCh.field` since same-dimension source/target is the dominant use case. Calendar reads `params.data[0]` (the ISO date string from the [date, value] tuple) and dispatches on `dateCh.field`. Candlestick looks up `xs[params.dataIndex]` (NOT `params.value`, which is the OHLC tuple) and dispatches on `xCh.field`. ParallelRenderer (continuous lines), ChoroplethRenderer (stub awaiting geo registration), and GaugeRenderer (single-value KPI) stay unwired — pinned by test that their function bodies contain no `dispatchCrossFilter(` call site. 23 tests across 7 source-inspection suites in [`wd2WiringEcharts.test.ts`](../../client/src/pages/Dashboard/lib/wd2WiringEcharts.test.ts). WD2-wiring family now spans 15 chart kinds: 10 visx (bar + cat-5 + rect + line + area + point) + 5 ECharts (treemap + sunburst + sankey + calendar + candlestick). KPI / Radar / Regression / Parallel / Choropleth / Gauge are all categorically inapplicable and remain deliberately skipped. See `docs/WAVES.md` for full entry.
- **Wave WI3 (2026-05-19)** — surfaces the regen `citations` array on [`TileInsightFooter`](../../client/src/pages/Dashboard/Components/TileInsightFooter.tsx) as a discoverable "Sources:" row of [`CitationHoverCard`](../../client/src/components/CitationHoverCard.tsx) chips. WI2-server's `extractInsightCitations(text)` (mirror of W22's `CITATION_TOKEN_RE` + hyphen rule) populates `InsightRegenEntry.citations: string[]` from backtick-wrapped pack ids in the regen prose; pre-WI3 that array landed in the cache but had no surface. WI3 inserts a `<div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">` row between the "Updated <relative> · <tier> confidence" metadata line and the Re-explain button, gated on `regen?.entry?.citations && regen.entry.citations.length > 0` so missing AND empty arrays short-circuit to no render. Each citation maps to `<CitationHoverCard key={packId} packId={packId} index={i + 1} />` — `key={packId}` is stable across array reorder, `index={i + 1}` matches the 1-based `[N]` superscript convention `MarkdownRenderer`'s `buildCitationIndex` already uses for inline rendering. The inline backtick-wrapped pack ids inside the regen prose continue to render as `[N]` superscript hover-cards via `MarkdownRenderer`'s WQ3 integration — a comment above the renderer call documents that path so future maintainers don't try to wire it again. `flex flex-wrap` keeps long citation lists from overflowing the narrow tile footer. 8 source-inspection tests in [`TileInsightFooterWI3.test.ts`](../../client/src/pages/Dashboard/Components/TileInsightFooterWI3.test.ts) pin the import, the gate, the literal label, the `.map(...)` shape, the structural ordering, the container class, the optional-chaining, and the documentation comment. See `docs/WAVES.md` for full entry.
- **Wave WI2-wire-bind (2026-05-19)** — closes the WI2 trilogy at the consumer level: [`ChartTileBody`](../../client/src/pages/Dashboard/Components/ChartTileBody.tsx) now calls `useInsightRegen` and ships the regenerated insight prose into [`TileInsightFooter`](../../client/src/pages/Dashboard/Components/TileInsightFooter.tsx). [`DashboardView`](../../client/src/pages/Dashboard/Components/DashboardView.tsx) creates one shared `insightRegenCache = useMemo(() => createInsightRegenCache(), [])` and threads it through [`DashboardTiles`](../../client/src/pages/Dashboard/Components/DashboardTiles.tsx) as an optional `insightRegenCache?: InsightRegenCache` prop into every ChartTileBody mount, so re-toggling between explored filter combos in the dashboard session hits the cache instead of refiring the MINI-tier LLM. ChartTileBody derives `InsightChartSpecLite` from `tile.chart` (field-for-field subset via a memo over `[type, title, x, y, seriesColumn, aggregate]`, with `seriesColumn`/`aggregate` spread-conditional so undefined optionals don't ship to the strict zod request schema), computes `filteredRows` via `applyChartFilters(tile.chart.data ?? [], filters ?? {})` cast to `InsightRegenRow[]` — `ChartSpec.data` cells (`string | number | null`) are a structural subset of `InsightRegenRow` cells (`string | number | boolean | null`) so the cast is safe and ChartShim never has to expose its internal filteredData. Mounts `useInsightRegen({ tileId: tile.id, filters: filters ?? {}, cache: insightRegenCache })`; binds a no-arg `handleRegenerate = useCallback(() => { void regen.regenerate(specLite, filteredRows); }, [regen, specLite, filteredRows])` — the dynamic context flows in at click time, preserving the hook's over-fire-on-every-render guard. The four-key `regen={{ entry, loading, error, onRegenerate: handleRegenerate }}` prop is passed to `TileInsightFooter` only when `tile.chart.keyInsight` is present, so charts without a static insight remain visually unchanged (no empty footer). 19 tests across 3 source-inspection suites in [`ChartTileBody.test.ts`](../../client/src/pages/Dashboard/Components/ChartTileBody.test.ts). Domain-context plumbing is deferred — no `useDomainContext` provider exists in `client/src/pages/Dashboard` yet; the hook's spread-conditional options keep the call site forwards-compatible. See `docs/WAVES.md` for full entry.
- **Wave WI2-wire (2026-05-19)** — closes the WI2 trilogy: per-tile insight regeneration is now a usable surface. New [`useInsightRegen({ tileId, filters, cache? })`](../../client/src/pages/Dashboard/hooks/useInsightRegen.ts) hook returns `{ entry, loading, error, regenerate, cacheKey }`. Cache key derives from `buildCacheKey(tileId, hashGlobalFilters(filters))` via `useMemo([tileId, filters])`; the cached entry reads synchronously every render so re-toggling between explored filter combos paints instantly. `regenerate(spec, filteredData, options?)` checks the cache first (unless `options.bypassCache`), POSTs to `/api/insight/regen` with `credentials: "include"`, and merges the parsed response straight into the cache via `cache.set(cacheKey, parsed)` — the WI2-server response shape was designed to be contract-compatible with `InsightRegenEntry`, so no transformation is needed. A `seqRef` guards against stale resolves clobbering newer state when multiple regenerate() calls fire back-to-back. The dynamic regen context (spec / filteredData / domainContext / datasetContextHint) flows in at CALL time rather than at hook-instantiation time — side-steps the over-fire-on-every-render trap of a `useEffect`-driven design. Per-mount fallback cache via `useMemo([])` when no shared cache is injected; the optional `cache` arg lets a future `DashboardView` mount share one cache across every tile. [`TileInsightFooter`](../../client/src/pages/Dashboard/Components/TileInsightFooter.tsx) gains an optional `regen?: { entry, loading, error, onRegenerate }` prop — when omitted, the legacy passive footer is unchanged; when provided: the regenerated entry text takes precedence over the static keyInsight (static is the fallback so the footer isn't empty mid-flight), a "✦ Re-explain this view" button renders with Sparkles (idle) / Loader2 (loading) icons, `disabled={regen.loading}` + `e.stopPropagation()` keeps the parent footer toggle quiet, errors render with `role="alert"` for a11y, and an "Updated <relative> · <tier> confidence" metadata line renders below via a local `formatRelativeShort(iso)` helper that covers s / min / h / d windows. 22 tests across 2 suites in [`useInsightRegen.test.ts`](../../client/src/pages/Dashboard/hooks/useInsightRegen.test.ts). The hook + footer extension are consumer-agnostic; the `WI2-wire-bind` follow-on wires `ChartTileBody` to call them (threads filteredData + spec + domainContext through `ChartShim` / `PremiumChart`). See `docs/WAVES.md` for full entry.
- **Wave WD2-wiring-rest-point (2026-05-19)** — PointRenderer (scatter / bubble) wired to `dispatchCrossFilter`, conditional on `colorCh`. Pure quantitative (x, y) scatters have no categorical filter target so the dispatch must NOT fire on them — a `crossFilterReady = !!dashboardTile && !!colorCh` local gates both the `cursor: pointer` style and the onClick uniformly. When `colorCh` IS set, clicking any point in a color group dispatches `{ column: colorCh!.field, value: toFilterValue(p.rawColor), sourceTileId }`, toggling that group's brush. Each point now preserves `rawColor` (type-original color value) alongside the stringified `colorKey`; `colorKey = asString(rawColor)` so the accessor runs once per row. Both render paths — `<Circle>` for plain scatters and glyph `<path>` for shape-encoded scatters — gain identical wiring so future maintainers can't introduce a divergence. The existing tooltip pathway (`onMouseMove` + `onMouseLeave`) is preserved on both render paths. 13 tests across 2 suites in [`wd2WiringRestPoint.test.ts`](../../client/src/pages/Dashboard/lib/wd2WiringRestPoint.test.ts). WD2-wiring-rest now spans 10 of 13 visx renderers (bar + cat-5 + rect + line + area + point); KPI / Radar / Regression have no meaningful categorical click target and are deliberately skipped. See `docs/WAVES.md` for full entry.
- **Wave WD2-wiring-rest-trend (2026-05-19)** — LineRenderer + AreaRenderer wired to `dispatchCrossFilter`. Trend marks (continuous x) have no per-mark click target; dispatch reads the click x-coord, scans every `series.points` for the nearest x, and fires `{ column: xCh.field, value: toFilterValue(nearest.x), sourceTileId }`. LineRenderer injects the dispatch into the existing `onBrushUp` click-treatment branch (`Math.abs(hi - lo) < 6`) — placed AFTER the 6-px guard but BEFORE the `setBrushStart(null)` reset so the recorded click position survives the lookup. The drag-to-zoom interaction never accidentally triggers a filter. AreaRenderer adds a fresh svg-level `onClick` using `localPoint(e)` to source click coords + `MARGIN.left` subtraction to map into the inner-plot origin used by `xPx` + a `[0, innerWidth]` clamp; reads from the pre-stack `series` (not `stacked`) because the stacked y values are cumulative but x values are identical, so pre-stack is the canonical original-data source. Two-level gating (`if (dashboardTile) { ... if (nearest) ... }`) avoids the O(series × points) scan cost on chat / explorer and silently handles empty-series edges. 18 tests across 2 suites in [`wd2WiringRestTrend.test.ts`](../../client/src/pages/Dashboard/lib/wd2WiringRestTrend.test.ts). See `docs/WAVES.md` for full entry.
- **Wave WD2-wiring-rest-rect (2026-05-19)** — RectRenderer heatmap cells wired to `dispatchCrossFilter`. A cell sits at the intersection of two categorical dims (`rowCh`, `colCh`); the cell `onClick` dispatches TWO `CROSS_FILTER_EVENT` events in row-first order, one per dim. `applyCrossFilter` is pure and event-driven so back-to-back dispatches each toggle their own column independently — the user sees the row + col filter applied, and re-clicking the same cell toggles both back off. The two parallel `Set` builders for the row / col domains collapse to a single `useMemo` returning `{ rows, rowRawByKey, cols, colRawByKey }` so the type-original raw value (Date / number / boolean / string) for each domain entry is recoverable at dispatch time — same shape as ArcRenderer's per-key aggregator from WD2-wiring-rest-cat. Row-first ordering is pinned by test via `indexOf("column: rowCh.field") < indexOf("column: colCh.field")` (a regex on the OUTER `dispatchCrossFilter` literal would return the same index for both searches — `String#search` returns the start of the overall match). 11 tests across 2 suites in [`wd2WiringRestRect.test.ts`](../../client/src/pages/Dashboard/lib/wd2WiringRestRect.test.ts). See `docs/WAVES.md` for full entry.
- **Wave WD2-wiring-rest-cat (2026-05-19)** — 5 categorical-by-construction visx renderers ([`ArcRenderer`](../../client/src/lib/charts/visxRenderers/ArcRenderer.tsx), [`FunnelRenderer`](../../client/src/lib/charts/visxRenderers/FunnelRenderer.tsx), [`BoxRenderer`](../../client/src/lib/charts/visxRenderers/BoxRenderer.tsx), [`WaterfallRenderer`](../../client/src/lib/charts/visxRenderers/WaterfallRenderer.tsx), [`ComboRenderer`](../../client/src/lib/charts/visxRenderers/ComboRenderer.tsx)) wired to `dispatchCrossFilter`. Each imports `useDashboardTileContext` + `dispatchCrossFilter` + `toFilterValue`; reads the dashboard-tile context once in the renderer body; preserves the type-original category value (`rawKey` / `rawLabel` / `rawCategory` / `rawX`) alongside the stringified one so the cross-filter predicate compares apples-to-apples; and adds an `onClick` on its categorical mark that dispatches `CROSS_FILTER_EVENT` with `{ column: <xField>, value: toFilterValue(<raw>), sourceTileId: dashboardTile.tileId }` when a dashboard-tile context is present. Outside a dashboard tile (chat / explorer / share preview) the click is a no-op — same invariant as BarRenderer. WaterfallRenderer additionally skips dispatch on running-total bars (`b.isTotal === true`) via an intermediate `clickable` local; ArcRenderer's per-key aggregator now stores `{ value, rawKey }` so the first row's raw value survives the per-key reduction; BoxRenderer captures `rawCategory` from `rows[0]?.[enc.x.field]` because `groupBy(data, [enc.x.field])` only returns string keys; ComboRenderer keeps both `rawX` (for dispatch) and `xRaw = asString(rawX)` (for the band scale lookup). The bar mark is the categorical handle for the combo chart; the secondary-axis line stays click-inert. 36 tests across 7 suites in [`wd2WiringRestCat.test.ts`](../../client/src/pages/Dashboard/lib/wd2WiringRestCat.test.ts) source-inspect the per-renderer dispatch shape, the click-gate predicate (`dashboardTile` for 4 of 5; `clickable` for Waterfall), the `cursor: pointer` style on hover, and the raw-value preservation. Remaining 4 renderers: WD2-wiring-rest-rect (heatmap cells, needs a one-vs-two-dim filter decision), WD2-wiring-rest-trend (Line/Area with nearest-x lookup + brush-zoom guard), WD2-wiring-rest-point (Point conditional on `colorCh`). KPI / Radar / Regression have no meaningful categorical click target and are deliberately skipped. See `docs/WAVES.md` for full entry.
- **Wave WD2-wiring-bar (2026-05-18)** — BarRenderer cross-filter wiring proof. Atomic round-trip validation of the WD2 helper's chart-mark-click → `dispatchCrossFilter` → window `CROSS_FILTER_EVENT` → `DashboardView` `useEffect` → `setGlobalFilters((g) => applyCrossFilter(g, detail))` data path on the bar mark. New module [`client/src/pages/Dashboard/lib/dashboardTileContext.tsx`](../../client/src/pages/Dashboard/lib/dashboardTileContext.tsx) — `DashboardTileProvider` memoises `{ tileId }`; `useDashboardTileContext()` returns the value inside a provider or `null` outside (chat / explorer / share preview surfaces fall through cleanly). [`ChartTileBody`](../../client/src/pages/Dashboard/Components/ChartTileBody.tsx) wraps the pivot-view branch + the chart-shim (PremiumChart-v2 / legacy ChartRenderer) branch in a single `<DashboardTileProvider tileId={tile.id}>` block so every renderer the tile delegates to inherits the context. [`BarRenderer`](../../client/src/lib/charts/visxRenderers/BarRenderer.tsx) imports `useDashboardTileContext` + `dispatchCrossFilter` + `toFilterValue`; reads the context at the top of the body; widens the `interactive` flag to `grid.inGrid || !!dashboardTile`; the bar `onClick` runs `grid.toggleFilter({ field, value })` independently when inside a `<ChartGrid>` (chat / explorer multi-chart context preserved unchanged) AND dispatches `CROSS_FILTER_EVENT` carrying `{ column: enc.x.field, value: toFilterValue(c.outerRaw), sourceTileId: dashboardTile.tileId }` when inside a dashboard tile. [`DashboardView`](../../client/src/pages/Dashboard/Components/DashboardView.tsx) gains a `useEffect` right after the existing `DR4` captured-filter seed effect — attaches a `window.addEventListener(CROSS_FILTER_EVENT, handler)` with a `typeof window === 'undefined'` SSR guard, casts to `CustomEvent<CrossFilterEvent>`, filters malformed payloads (`!detail || typeof detail.column !== 'string'`), and dispatches `setGlobalFilters((prev) => applyCrossFilter(prev, detail))`; cleanup removes the listener on unmount. `toFilterValue` in [`crossFilter.ts`](../../client/src/pages/Dashboard/lib/crossFilter.ts) widened from a narrow `string | number | boolean | null | undefined` signature to `unknown` because chart-mark values flow as `unknown` from typed `BarCell.outerRaw`; the existing 29 WD2 tests stay green (runtime behavior unchanged for the narrower types), plus a new `Date` branch ISO-coerces temporal axis brushes. 18 tests across 5 suites in [`dashboardTileContext.test.ts`](../../client/src/pages/Dashboard/lib/dashboardTileContext.test.ts): module shape (4), BarRenderer source-inspection (6), ChartTileBody provider-wrap source-inspection (2), DashboardView subscription source-inspection (6). Remaining 12 visx renderers + ECharts adapter follow as WD2-wiring-rest with the same three-line addition per renderer. See `docs/WAVES.md` for full entry.
- **Wave WI2-server (2026-05-18)** — `POST /api/insight/regen` endpoint pairs with the WI2-cache client surface. The future WI2-wire hook will call this on cache miss and merge the response straight into the cache via `cache.set(buildCacheKey(tileId, hashGlobalFilters(filters)), response)`. New module [`server/lib/insightRegen.ts`](../../server/lib/insightRegen.ts) ships five pure helpers + one network boundary: strict zod `regenInsightRequestSchema` (`{ tileId, spec, filteredData ≤5000 rows, domainContext?, datasetContextHint? }`) + `regenInsightResponseSchema` (matches `InsightRegenEntry` from WI2-cache verbatim — `{ text, citations?, regeneratedAt, confidenceTier }`); `summarizeFilteredData(rows, { x, y })` computes deterministic anchors (top / bottom row by y, mean, distinct x-values preview); `inferConfidenceTier(rowCount)` mirrors WQ1's tier vocabulary (<10 low / <100 medium / ≥100 high); `extractInsightCitations(text)` mirrors W22's `CITATION_TOKEN_RE` byte for byte plus the hyphen-rule filter; byte-stable `buildInsightRegenPrompt(args) → { system, user }` (system carries persona + output contract; user embeds the stat anchors + optional DATASET/DOMAIN CONTEXT blocks); `regenInsightForFilteredView(request)` is the single MINI-tier `callLlm` boundary with deterministic post-processing (whitespace normalisation, blockquote strip, 1200-char cap, citations + tier inference, ISO timestamp). New `LLM_PURPOSE.INSIGHT_REGEN` MINI-tier purpose declared in [`llmCallPurpose.ts`](../../server/lib/agents/runtime/llmCallPurpose.ts); both W3.11 routing-regression and W18 default-stub-handler tests updated for the new purpose. Route wired in [`server/routes/insightRegen.ts`](../../server/routes/insightRegen.ts) — auth-gated via `getAuthenticatedEmail`, 400 on schema fail, 500 on regen failure with `agentLog` telemetry on both success + error. 36 tests across 8 suites. WI2 trilogy is now 2 of 3 shipped (cache + server); WI2-wire is the next wave — `useInsightRegen` hook + "✦ Re-explain this view" button in [`TileInsightFooter.tsx`](../../client/src/pages/Dashboard/Components/TileInsightFooter.tsx) merges everything into the user-facing surface. See `docs/WAVES.md` for full entry.
- **Wave WI2-cache (2026-05-18)** — per-tile insight regen cache pure helpers. New module [`client/src/pages/Dashboard/lib/insightRegenCache.ts`](../../client/src/pages/Dashboard/lib/insightRegenCache.ts) ships the data-plumbing layer for WI1's dynamic insight regeneration. Three exports: `hashGlobalFilters(filters)` — byte-stable serialisation of `ActiveChartFilters` (sorts column keys + categorical values; date / numeric have fixed-key serialisation with `c:` / `d:` / `n:` kind prefixes so the same column with different filter shapes never collides); `buildCacheKey(tileId, filterHash)` — `${tileId}::${filterHash}` concatenation with an unambiguous `::` delimiter; `createInsightRegenCache(opts?)` — factory returning a closure-backed LRU + TTL cache with default 64 entries (8 tiles × 8 filter combos upper bound; ~32 KB memory ceiling) + default 5-min TTL (matches Anthropic prompt-cache TTL). The cache stores `InsightRegenEntry = { text, citations?, regeneratedAt?, confidenceTier? }` so the future WI2-server + WI2-wire surfaces agree on the shape now. `get` refreshes LRU recency; `set` evicts the oldest when full; `has` / `get` lazy-delete stale entries; `evictExpired()` does an active sweep for the consuming hook to call periodically. `now` injection enables deterministic TTL tests without `setTimeout` or fake-timer libraries. 21 tests across 6 suites pin every contract surface (hash byte-stability, key composition, basic get/set, LRU eviction with recency refresh, TTL expiry, integration scenario with shared hits + invalidation). Foundation for the WI2-server + WI2-wire follow-ons; pure data-plumbing ships first (same pattern as W59a → W59b and WD2 helper → renderer wiring). See `docs/WAVES.md` for full entry.
- **Wave WD2 (2026-05-18)** — cross-filter brushing pure helper. New module [`client/src/pages/Dashboard/lib/crossFilter.ts`](../../client/src/pages/Dashboard/lib/crossFilter.ts) surfaces a one-way data path from a chart-mark click to the dashboard `globalFilters` map (`ActiveChartFilters`). Pure helpers — no React state, no DOM dependency outside the `dispatchCrossFilter` browser-guarded `CustomEvent` dispatch. `applyCrossFilter(global, event)` implements the toggle contract: clicking an active `(column, value)` pair removes it, clicking a new value on a column with an existing categorical filter appends, clicking on a column with no categorical filter installs a fresh categorical `[value]` selection. Date / numeric selections on the column are replaced (chart brush is explicitly discrete-value). `toFilterValue` coerces clicks to canonical string form — `null` / `undefined` → the literal `"null"` (matches the upstream `(null)` key normalisation in `breakdownRankingTool` + the existing chart filter UI's null-bucket handling); numbers / booleans → `String(v)`. Companion helpers: `removeCrossFilter` (remove one (column, value)), `clearCrossFilter` (drop a column entirely), `isCrossFilterActive` (membership test), `listActiveCrossFilters` (flat `{column, value}[]` enumeration for chip rendering). `CROSS_FILTER_EVENT = "marico:cross-filter"` is the canonical CustomEvent name a future wave will subscribe to in `DashboardView`. Module is pure on its inputs: `applyCrossFilter` / `removeCrossFilter` / `clearCrossFilter` all clone-before-modify (`{ ...global }`) so the caller's map is never mutated. 29 tests across 10 suites pin every contract surface (value coercion, toggle semantics on empty / categorical / non-categorical / mutation-purity / coercion edges, remove / clear / list edge cases, dispatch no-op in non-browser env). Wiring into the renderers + `DashboardView` is a follow-on wave; this wave isolates the data-plumbing concern so the wiring wave can be a thin call-site change. See `docs/WAVES.md` for full entry.
- **Wave WD1 (2026-05-16)** — `AddFilterPopover` ([client/src/pages/Dashboard/Components/AddFilterPopover.tsx](../../client/src/pages/Dashboard/Components/AddFilterPopover.tsx)) gives the DR4 global filter bar a `+ Add filter` trigger. Three inline editors (categorical / numeric / date), pure helpers in [dashboardGlobalFilters.ts](../../client/src/pages/Dashboard/dashboardGlobalFilters.ts) (`aggregateTileRowsForFiltering`, `availableFilterDefinitions`, `addCategoricalFilter`, `addNumericFilter`, `addDateFilter`). The bar renders even when `global` is empty if there are columns available to add — DR4's zero-pixels-when-nothing-to-do contract preserved for dashboards with no chart tiles. See `docs/WAVES.md` for full entry. Future waves (WD2–WD10) layer cross-filter brushing, drill-through, dynamic insights, fork-from-dashboard, mobile, linked sheets, saved views, comments, scheduled refresh.

### 5.4 Theme bridge (ECharts)

ECharts specialty marks (treemap, sankey, sunburst, parallel,
calendar, candlestick, choropleth, gauge) lazy-load and read CSS
variables on init.

`next-themes` toggles `class="dark"` on `<html>`, which doesn't fire
`prefers-color-scheme`. Fix-3 wired a `MutationObserver` on
`document.documentElement` watching the `class` attribute, so app-level
theme toggles re-apply ECharts options within ~16ms (one frame). The
`prefers-color-scheme` listener stays as a fallback for OS-driven
changes.
