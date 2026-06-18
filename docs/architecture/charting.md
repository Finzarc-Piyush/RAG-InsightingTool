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

Defined as the `ChartRendererProps` interface in [ChartRenderer.tsx](../../client/src/pages/Home/Components/ChartRenderer.tsx) (grep the symbol, or look it up in `docs/index/symbols.generated.tsv` — line numbers move).

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

### 1.2 Internal state ([line 172+](../../client/src/pages/Home/Components/ChartRenderer.tsx))

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
| `MAX_COMPACT_X_TICKS` | `6` | [line 75](../../client/src/pages/Home/Components/ChartRenderer.tsx) | Same constant in `<PremiumChart>` axis config. |
| `LINE_AREA_MAX_X_TICKS` | imported from shared | Used for line/area charts in non-fill mode. | Same. |
| Outlier IQR threshold | `0.1` (paddingFraction default) | [line 201](../../client/src/pages/Home/Components/ChartRenderer.tsx) | Constant in `dataEngine.ts:detectOutliers`. |
| `MAX_RENDER_POINTS` per density | dynamic (`getMaxRenderPoints()`) | [line 437](../../client/src/pages/Home/Components/ChartRenderer.tsx) | Ported into `dataEngine.ts:sample`. |

### 1.4 Per-mark behaviors

#### `bar`

- **Compact X-axis** when `!fillParent && !isSingleChart && chartData.length > MAX_COMPACT_X_TICKS`
  ([line 448](../../client/src/pages/Home/Components/ChartRenderer.tsx)). Picks the
  first 6 categories or the largest 6 by value.
- **Date-detection in compact mode** ([line 454-466](../../client/src/pages/Home/Components/ChartRenderer.tsx)):
  if X looks like dates, takes a chronological slice; otherwise sorts by Y desc.
- **Stacked / grouped** via `chart.barLayout`. Series defined by
  `seriesColumn` + `seriesKeys`.
- **15-series "Others" merging** (per server pipeline; ChartRenderer expects
  pre-merged data). v2: do the merge in `encodingResolver.ts` so the client
  can re-do it after a filter or shelf change.

#### `line`

- **Dual-axis (Y2)** ([line 864-869](../../client/src/pages/Home/Components/ChartRenderer.tsx)):
  when `chart.y2` is set, renders a second left-axis series with a different color
  (`hsl(var(--chart-1))` for left, `chartColor` for right).
- **Multi-series** when `seriesColumn` + `seriesKeys` present; uses
  `RechartsWideLegendContent` with toggle-series and toggle-all callbacks.
- **Trend line** ([line 189](../../client/src/pages/Home/Components/ChartRenderer.tsx)):
  optional `chart.trendLine` array (two points). Rendered as overlay.
- **Dynamic Y domain** ([line 781](../../client/src/pages/Home/Components/ChartRenderer.tsx))
  via `getDynamicDomain(values, paddingFraction=0.1)`. Override with `chart.yDomain`.
- **Dot toggle** in modal — controls `showDots` flag.

#### `area`

- Same dual-axis + multi-series + dynamic domain rules as `line`.
- Stacked area is currently the only mode (no diverging stacks).

#### `scatter`

- **Outlier hiding** (state `hideOutliers`) — toggle in header.
  IQR-based detection ([line 392](../../client/src/pages/Home/Components/ChartRenderer.tsx)).
- **Stratified sampling** ([line 437-445](../../client/src/pages/Home/Components/ChartRenderer.tsx)):
  when point count > `MAX_RENDER_POINTS`, samples every Nth point and slice-caps.
  Density slider (`low`/`medium`/`high`/`all`) controls `MAX_RENDER_POINTS`.
- **Opacity slider** (`low` 0.3 / `medium` 0.6 / `high` 0.9). Used to mitigate
  overplot.
- **Trend line** support same as line.
- **Z-axis (size encoding)** for bubble-style scatter via `chart.z`.
- **Loading progress** when `_isCorrelationChart` flag present
  ([line 1727](../../client/src/pages/Home/Components/ChartRenderer.tsx)) — shows
  progress overlay while correlation matrix computes server-side.

#### `pie`

- Single-level only.
- "Others" merging server-side.
- Custom tooltip via `formatChartTooltipValue`.

#### `heatmap` ([line 1088](../../client/src/pages/Home/Components/ChartRenderer.tsx))

- **Custom HSL color scale** based on cell value vs. min/max range.
- **Custom low-to-high legend** below the chart (gradient strip with min/max
  labels).
- **Empty-state** "No numeric values for heatmap." when no Z column.
- Max 40 rows × 24 cols (downsampling beyond this happens server-side in
  [chartGenerator.ts](../../server/lib/chartGenerator.ts)).

### 1.5 Cross-cutting behaviors

#### Lazy-render via IntersectionObserver

[ChartRenderer.tsx](../../client/src/pages/Home/Components/ChartRenderer.tsx)
+ [line 1566](../../client/src/pages/Home/Components/ChartRenderer.tsx).
Renders an empty container until the chart enters viewport. Disabled when
`isSingleChart || fillParent || isLoading`. **v2 parity**: same behavior in
`<PremiumChart>` via the same hook (`useIntersectionObserver`).

#### Filter UI

[line 222](../../client/src/pages/Home/Components/ChartRenderer.tsx) +
[line 230](../../client/src/pages/Home/Components/ChartRenderer.tsx) +
[line 275](../../client/src/pages/Home/Components/ChartRenderer.tsx).

- Only enabled for `line`/`bar`/`area` when `enableFilters` is true.
- Filter chips are derived from the original (pre-aggregation) data set.
- Series keys are excluded from filter UI when `seriesColumn` is set —
  the legend handles series visibility instead.

**v2 parity**: `<FilterChips>` component takes `(rows, columns, activeFilters,
onChange)`. Logic ported from `applyChartFilters`.

#### Legend (multi-series)

[RechartsWideLegendContent](../../client/src/lib/rechartsWideLegend.tsx)
component, used at [line 851-856](../../client/src/pages/Home/Components/ChartRenderer.tsx).

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

**v2 parity**: `<PremiumChart>` carries a passive `keyInsightSessionId`
prop for a future "expand to modal" caller (the v2 expand modal isn't
wired yet — the prop is preserved so a flag flip doesn't lose the legacy
Key Insight feature). `<ChartCanvas>` mounts its own larger view inline
(no modal needed for editing).

#### Dynamic axis domain

`getDynamicDomain` (local helper in [ChartRenderer.tsx](../../client/src/pages/Home/Components/ChartRenderer.tsx))
adds 10% padding above/below the value range. Used when `yDomain` not
explicitly set. Returns `[min - pad, max + pad]`.

**v2 parity**: still a local helper — no separate charts/scales module
was ever extracted.

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
| `getDynamicDomain` (local helper) | Axis padding. Remains local to ChartRenderer — no separate `scales.ts` module exists. |

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
> [client/src/index.css](../../client/src/index.css)) and updates to
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

## Recent changes

- 2026-06-18 · Wave W-EXP-14 — **premium PPTX export overhaul.** The dashboard `.pptx` download was re-rendered for "character + clean charts + clean text". The big fix: **multi-series was silently dropped** — both export chart mappers built one series, so a grouped chart became identical monochrome bars; new shared [`pivotSeries`](../../server/lib/exports/chartSpecSeries.ts) reconstructs N series and BOTH engines now do grouped/stacked/multi-line + data labels + legend + brand colours ([native `chartSpecToAddChart`](../../server/lib/exports/pptx/chartSpecToAddChart.ts) — the DEFAULT, universal-render + editable XLSX; rich SVG [`chartSsr`](../../server/lib/exports/chartSsr.ts) — the heatmap/dual-axis fallback + `PPTX_SVG_CHARTS` opt-in, embedded **base64** not `utf8`). New navy+gold 8-jewel [`brandPalette`](../../server/lib/exports/brandPalette.ts) + [`numberFormatExport`](../../server/lib/exports/numberFormatExport.ts); [`pptx/master.ts`](../../server/lib/exports/pptx/master.ts) owns the shared primitives (`addCard`/`chip`/`eyebrow`/`bulletList`/`renderDataTable`/`renderActionTitle`) so all 10 recomposed layouts are consistent by construction. See [`docs/WAVES.md`](../WAVES.md).
- 2026-06-18 · Waves CI1–CI10 — **one insight seam (server), one insight component (client).** Server: every chart path can route through the idempotent [`generateInsightForCharts`](../../server/lib/generateInsightForCharts.ts) (the per-chart body lifted out of `enrichCharts`, now a thin caller); auto-created dashboards are **born-insighted** — [`applyEnrichedChartsToDashboard`](../../server/lib/applyDashboardChartInsights.ts) reuses the chat insight by axis signature, then generates one for any orphan sweep tile, so no dashboard chart ships bare (`depthBudget` stays upstream, invariant #12). Client: [`<ChartInsightBody>`](../../client/src/components/charts/ChartInsightBody.tsx) is THE insight-presentation unit (key-insight markdown + "Business context"), consumed by `MessageBubble`, `TileInsightFooter`, `AnalyticalDashboardResponse`, `ChartModal`, and `ChartOnlyModal` (which previously showed none) — replacing five private `MarkdownRenderer` copies. `suppressPerChartInsight` + the single-chat-answer dedup preserved; the recharts↔visx spec-render swap is a separate track. See [`docs/WAVES.md`](../WAVES.md) + [`decisions/universal-chart-insight-seam.md`](../decisions/universal-chart-insight-seam.md).
- 2026-06-18 · Wave IUX4 — the dashboard Executive-Summary **band** now renders the full decision chain (TL;DR → key numbers → findings **with an evidence snippet** → **"Why it matters"** top implications → **"Priority actions"** top recommendations, most-urgent horizon first, with `expectedImpact`), via the extended pure selector [`selectSummaryBandData`](../../client/src/pages/Dashboard/lib/summaryBandData.ts) + [`DashboardSummaryBand`](../../client/src/pages/Dashboard/Components/DashboardSummaryBand.tsx) (was: bare finding headlines only). The drawer [`AnalysisSummaryPanel`](../../client/src/pages/Dashboard/Components/AnalysisSummaryPanel.tsx) renames "Analytical recommendations" → "Recommended actions", renders `expectedImpact`, defaults "Why it matters" + Caveats open. See [`docs/WAVES.md`](../WAVES.md).
- 2026-06-18 · Dashboard tile authoring chrome (Wave WD-ctrl/WD-add) — in **Edit** mode the per-tile `actions` slot (delete / pivot-toggle / text-edit pencils) is now **always visible** instead of `opacity-0 group-hover:opacity-100`; the single seam is [`TileHeader`](../../client/src/pages/Dashboard/Components/TileHeader.tsx) plus the two tile-local copies in [`PivotTile`](../../client/src/pages/Dashboard/Components/PivotTile.tsx) and [`TileInsightFooter`](../../client/src/pages/Dashboard/Components/TileInsightFooter.tsx). **View** mode stays clean; chat-preview cards (no `DashboardEditModeProvider`) are unaffected (`showActions=false`). Pivot delete is now wired end-to-end (`removePivotFromDashboard` → `DELETE /pivots`; previously `onDeletePivot` was declared but never passed, so it toasted "not available"); `PivotTile` gains an `isEditing` prop (replaces `canEdit`) so its delete matches the View/Edit gate. **Add → Table from session** added to [`AddTileMenu`](../../client/src/pages/Dashboard/Components/AddTileMenu.tsx): the session picker gains a `kind`; in table mode it offers only charts with derivable rows and adds the chart's data as a table via [`chartSpecToTableSpec`](../../client/src/pages/Dashboard/lib/chartSpecToTableSpec.ts). No chart-spec editing was added (dashboard tiles stay non-editable). See [`docs/WAVES.md`](../WAVES.md).
- 2026-06-18 · Width-aware x-axis label budget — the fixed `MAX_X_AXIS_LABELS = 10` (the "10 or 11" cap users saw = 10 + the always-appended last tick) is replaced by [`maxXAxisLabels({axisWidthPx, labels, fontSizePx, rotationDeg})`](../../client/src/lib/charts/xAxisLabelCap.ts): fit as many legible labels as the plot width allows (horizontal → text-width footprint; rotated → labelHeight/sin θ footprint, length-independent), clamped `[2, 60]`, falling back to 10 only when width is unmeasured — mirroring the height-aware [`targetYTickCount`](../../client/src/lib/charts/yAxisTickCount.ts). New [`useContainerWidth`](../../client/src/hooks/useContainerWidth.ts) (ResizeObserver) feeds measured width to the **production** recharts surfaces (`ChartRenderer`/`ChartModal`/`ChartOnlyModal`; margin is `y2`-aware); the 7 visx renderers (Line/Area/Bar/Combo/Rect/Box/Waterfall) feed in-scope `innerWidth`; the ECharts categorical axis uses native `interval:'auto'`+`hideOverlap`. Recharts compact-bar mode (which **dropped** bars to a hard 6 in small tiles) is now width-derived (`compactBarLimit`, floored at the old 6). Only labels are thinned — data is never reduced. See [`docs/WAVES.md`](../WAVES.md).
- 2026-06-17 · Wave IUX2 — chart-insight grounding gate accepts percent forms for 0–1 rates (a de-jargoned "74.2%" answer no longer gets discarded for the raw "0.742"); `PivotPatterns.isRateMetric` makes the signal + `selectFallbackFamily` rate-aware (no "X% of total" for rates); in-file deterministic fallback de-jargoned. See [`docs/WAVES.md`](../WAVES.md).
- 2026-06-17 · Wave IUX1 — chart-insight prompt (`generateChartInsights`) rewritten for plain-language, manager-readable output (banned mass/quartile/HHI/CV/P75/trough); `renderPivotPatternsBlock`, pivot-envelope, and deterministic-fallback labels de-jargoned. See [`docs/WAVES.md`](../WAVES.md).
- 2026-06-14 · Charting/pivot dedup audit: the table→ChartSpec builders now share leaf authorities — `chartMeasurePick` (scoreMeasure/isNumericishOnSample, fixed a latent y-axis-pick drift), `isTemporalFacetColumnKey` (temporal-x detection in 4 sites), and `chartSpecFinish.finishChartSpec` (the domains+labels tail, 5 builders). Client scatter decimation → `scatterDecimation.ts`; export palette → `brandPalette.ts`; export series extraction → `chartSpecSeries.ts`. See [`docs/decisions/centralized-chart-builders.md`](../decisions/centralized-chart-builders.md).

Per-wave history lives in [`docs/WAVES.md`](../WAVES.md) (search the wave id). The detailed
pre-2026-06 subsystem changelog was moved out of this routing doc to keep `/load` cheap —
see [`docs/archive/charting-changelog.md`](../archive/charting-changelog.md). Keep new
entries here to ONE line each; full prose belongs in `docs/WAVES.md`.
