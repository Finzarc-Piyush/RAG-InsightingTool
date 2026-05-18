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
