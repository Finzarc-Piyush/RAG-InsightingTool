import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { AlertTriangle, BarChart3, Maximize2, Table2, Telescope, Trash2 } from "lucide-react";
import type { ChartSpec } from "@/shared/schema";
import { buildChartInvestigationPrompt } from "@/lib/charts/investigateQuestion";
import { applyChartFilters, type ActiveChartFilters } from "@/lib/chartFilters";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ChartShim } from "@/components/charts/ChartShim";
import { cn } from "@/lib/utils";
import { TileHeader } from "./TileHeader";
import { TileInsightFooter } from "./TileInsightFooter";
import { ChartTilePivotView } from "@/components/charts/ChartTilePivotView";
import { chartSpecToPivotConfig } from "@/components/charts/chartSpecToPivotConfig";
import { SourcePillRow } from "@/pages/Home/Components/SourcePillRow";
import { ChartParityToolbar } from "@/components/charts/ChartParityToolbar";
import {
  coerceMarkType,
  type SwitchableMark,
  type ChartSpecPatch,
} from "@/lib/charts/chartSpecMutations";
import { ChartSortControl } from "@/components/charts/ChartSortControl";
import { ChartLimitControl, type ChartLimit } from "@/components/charts/ChartLimitControl";
import {
  useChartSort,
  chartSupportsSort,
  type ChartSortSpec,
} from "@/lib/charts/useChartSort";
import { useChartTileViewMode } from "../hooks/useChartTileViewMode";
import { DashboardTileProvider } from "../lib/dashboardTileContext";
import {
  useInsightRegen,
  type InsightChartSpecLite,
  type InsightRegenRow,
} from "../hooks/useInsightRegen";
import type { InsightRegenCache } from "../lib/insightRegenCache";
import type {
  InsightHistoryEntry,
  InsightHistoryStore,
} from "../lib/insightHistory";
import { deriveTileDoLane } from "../lib/tileDoFallback";
import { clickHitsInteractiveDescendant } from "../lib/chartBodyExpand";
import { buildExpandModalProps } from "../lib/expandModalProps";
import { resolveInsightFooterMode } from "../lib/insightFooterState";

// Lazy load to mirror DashboardTiles' Suspense pattern.
const ChartRenderer = lazy(() =>
  import("@/pages/Home/Components/ChartRenderer").then((m) => ({
    default: m.ChartRenderer,
  })),
);

// Wave Z2 · explicit per-chart expand modal. Lazy so the recharts-heavy modal
// only loads when a user clicks Maximize.
const ChartOnlyModal = lazy(() =>
  import("./ChartOnlyModal").then((m) => ({ default: m.ChartOnlyModal })),
);

/**
 * Wave DR18D · chart tile body extracted into its own component so
 * the per-tile chart/pivot view-mode hook (useChartTileViewMode) can
 * run with stable identity. Pre-DR18D the chart case rendered inline
 * inside `DashboardTiles.renderTileContent` — a function called from
 * the parent's render — which can't host hooks.
 *
 * Visual contract is preserved verbatim:
 *   - same outer Card with `dashboard-tile-grab-area` and
 *     `data-dashboard-tile="chart"` (load-bearing for react-grid-layout
 *     swap-on-collision and the DR3 regression test)
 *   - same `TileHeader` with title, inapplicable-filter badge (DR4),
 *     and edit-mode delete action
 *   - same `<ErrorBoundary><Suspense><ChartShim/></Suspense></ErrorBoundary>`
 *     for chart rendering
 *   - same `TileInsightFooter` (DR18B) inside the same Card
 *
 * What's new:
 *   - `useChartTileViewMode(dashboardId, tile.id)` drives a
 *     chart/pivot toggle button in the TileHeader's `actions` slot.
 *   - When `mode === 'pivot'`, the ChartShim block is replaced with
 *     `<ChartTilePivotView>`. The keyInsight footer stays — same
 *     insight applies to both views.
 *   - Toggle button is hidden when `chartSpecToPivotConfig(chart)`
 *     returns null (chart can't sensibly pivot — no x, no y, no data).
 */

interface ChartTileBodyProps {
  tile: { kind: "chart"; id: string; title: string; chart: ChartSpec; index: number };
  dashboardId: string;
  /**
   * W11 · the dashboard's source session (if any) — forwarded to the fullscreen
   * ChartOnlyModal so a bare chart can fetch an insight on open. Null/omitted
   * for sessionless dashboards → the modal stays display-only.
   */
  sessionId?: string | null;
  canEdit: boolean;
  isEditing: boolean;
  inapplicableColumns: string[];
  filters: ActiveChartFilters | undefined;
  onFiltersChange: (next: ActiveChartFilters) => void;
  onDeleteClick: () => void;
  onEditInsight: () => void;
  /**
   * Wave S6 · persist the chart's "Sort by" choice (parent owns sheetId + the
   * dashboards PATCH + refetch). Omitted → the re-sort is an ephemeral view
   * change (still instant), e.g. for viewers without edit permission.
   */
  onSortChange?: (sort: ChartSortSpec) => void;
  /**
   * Persist the chart's Top-N / Bottom-N selection (parent owns sheetId + the
   * dashboards PATCH + refetch). Omitted → the limit change is an ephemeral view
   * change (still instant), e.g. for viewers without edit permission. `null`
   * clears the limit (show all). See docs/conventions/chart-limit-durable.md.
   */
  onLimitChange?: (limit: ChartLimit) => void;
  /**
   * W7 · persist the parity toolbar's mark switch / stacked-grouped / show-labels
   * (parent owns sheetId + the dashboards PATCH + refetch). Omitted → the change
   * is an ephemeral view change (still instant), e.g. for viewers without edit
   * permission. Server normalises the bar-only strip like the client.
   */
  onSpecChange?: (patch: ChartSpecPatch) => void;
  /**
   * Wave WI2-wire-bind · shared LRU+TTL insight regen cache passed
   * down from `DashboardView`. When omitted the `useInsightRegen`
   * hook falls back to a per-tile cache, which is fine but loses
   * the "re-explore filter combo A after B" warm-cache hit.
   */
  insightRegenCache?: InsightRegenCache;
  /**
   * Wave WI6 · shared per-tile MRU history store passed down from
   * `DashboardView`. Each fresh regen entry is recorded; the per-tile
   * slice is read on every render so the footer dropdown shows up-to-
   * date navigation entries. Omitted → footer dropdown stays hidden.
   */
  insightHistoryStore?: InsightHistoryStore;
}

export function ChartTileBody({
  tile,
  dashboardId,
  sessionId,
  canEdit,
  isEditing,
  inapplicableColumns,
  filters,
  onFiltersChange,
  onDeleteClick,
  onEditInsight,
  onSortChange,
  onLimitChange,
  onSpecChange,
  insightRegenCache,
  insightHistoryStore,
}: ChartTileBodyProps) {
  const { mode, toggle } = useChartTileViewMode(dashboardId, tile.id);
  // W4 · local spec copy so the shared parity toolbar (mark-switch / layout /
  // show-labels) can mutate the tile's chart view-side — parity with the chat
  // card. Ephemeral for now; W7 persists it via the dashboards charts PATCH.
  // Reset when the tile shows a structurally different chart (same pattern as
  // the `limit` state below). `coerceMarkType` strips bar-only fields + value
  // sort when leaving bar (shared with chat → no drift).
  const chartIdentity = `${tile.chart.type}|${tile.chart.x}|${tile.chart.y}|${
    tile.chart.seriesColumn ?? ""
  }|${(tile.chart.seriesKeys ?? []).join(",")}`;
  const [localSpec, setLocalSpec] = useState<ChartSpec>(tile.chart);
  useEffect(() => {
    setLocalSpec(tile.chart);
    // chartIdentity is the structural-content key — an upstream re-render handing
    // back a new object reference for the same chart must NOT wipe the user's
    // mark/layout choice. tile.chart intentionally excluded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tile.id, chartIdentity]);
  const handleTypeChange = useCallback(
    (next: SwitchableMark) => {
      setLocalSpec((prev) => coerceMarkType(prev, next));
      onSpecChange?.({ type: next });
    },
    [onSpecChange],
  );
  const handleBarLayoutChange = useCallback(
    (next: "stacked" | "grouped") => {
      setLocalSpec((prev) =>
        prev.type === "bar" ? { ...prev, barLayout: next } : prev,
      );
      onSpecChange?.({ barLayout: next });
    },
    [onSpecChange],
  );
  const handleDataLabelsChange = useCallback(
    (next: boolean) => {
      setLocalSpec((prev) => ({ ...prev, dataLabels: next }));
      onSpecChange?.({ dataLabels: next });
    },
    [onSpecChange],
  );

  // W13 · "Investigate further" → open the dashboard's source chat with a
  // diagnostic+strategic deep-dive question pre-filled (editable, NOT auto-sent),
  // reusing the `?compose=` param Home consumes — parity with the chat tile's
  // Telescope button. Hidden when the dashboard has no source session.
  const [, setLocation] = useLocation();
  const handleInvestigate = useCallback(() => {
    if (!sessionId) return;
    const q = buildChartInvestigationPrompt(localSpec);
    setLocation(
      `/analysis/${encodeURIComponent(sessionId)}?compose=${encodeURIComponent(q)}`,
    );
  }, [sessionId, localSpec, setLocation]);

  // Wave S6 · interactive sort. Re-orders the (locally-mutated) spec's data
  // instantly client-side; `onSortChange` (parent) persists the choice.
  const { sortedSpec, sort, setSort } = useChartSort(localSpec);
  const showSortControl = chartSupportsSort(localSpec);
  const handleSortChange = useCallback(
    (next: ChartSortSpec) => {
      setSort(next);
      onSortChange?.(next);
    },
    [setSort, onSortChange],
  );
  // Durable Top-N / Bottom-N selection. Seeded from the server-baked / persisted
  // `limit`; the change re-renders instantly (ChartRenderer applies it) and
  // `onLimitChange` (parent) persists it. Reset when the tile shows a new chart.
  const [limit, setLimit] = useState<ChartLimit>(tile.chart.limit ?? null);
  useEffect(() => {
    setLimit(tile.chart.limit ?? null);
  }, [tile.id, tile.chart.limit]);
  const handleLimitChange = useCallback(
    (next: ChartLimit) => {
      setLimit(next);
      onLimitChange?.(next);
    },
    [onLimitChange],
  );
  const [isExpandOpen, setIsExpandOpen] = useState(false);
  const canPivot = chartSpecToPivotConfig(tile.chart) !== null;
  // Force chart view when this chart can't be pivoted, even if a
  // stale `pivot` value is in sessionStorage from a prior chart shape.
  const effectiveMode = canPivot ? mode : "chart";
  // A1 · click anywhere on the chart body (view mode, chart view) to open the
  // fullscreen modal. Disabled while editing (drag owns the gesture) and in
  // pivot view (table cells stay interactive).
  const canExpandOnBodyClick = !isEditing;
  const handleBodyExpandClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (effectiveMode === "pivot") return;
      // Respect interactive children (filter controls, legend toggles, links,
      // buttons, form controls) — a click on those should do their own thing.
      // The container itself carries role="button" (a11y), which the predicate
      // deliberately excludes so it doesn't suppress expand on every click.
      if (
        clickHitsInteractiveDescendant(
          event.target as Element,
          event.currentTarget,
        )
      ) {
        return;
      }
      setIsExpandOpen(true);
    },
    [effectiveMode],
  );
  const handleBodyExpandKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (effectiveMode === "pivot") return;
      if (event.target !== event.currentTarget) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        setIsExpandOpen(true);
      }
    },
    [effectiveMode],
  );

  // Wave WI2-wire-bind · derive the lite spec from the tile's
  // ChartSpec. The field set on `InsightChartSpecLite` is a strict
  // subset of `ChartSpec`, so the mapping is field-for-field.
  const specLite: InsightChartSpecLite = useMemo(
    () => ({
      type: tile.chart.type,
      title: tile.chart.title,
      x: tile.chart.x,
      y: tile.chart.y,
      ...(tile.chart.seriesColumn ? { seriesColumn: tile.chart.seriesColumn } : {}),
      ...(tile.chart.aggregate ? { aggregate: tile.chart.aggregate } : {}),
    }),
    [
      tile.chart.type,
      tile.chart.title,
      tile.chart.x,
      tile.chart.y,
      tile.chart.seriesColumn,
      tile.chart.aggregate,
    ],
  );

  // Apply the tile's active filters to the embedded rows. ChartSpec.data
  // cells are `string | number | null` — a structural subset of
  // `InsightRegenRow` (`string | number | boolean | null`), so the cast
  // is safe. Returns `[]` when the chart has no embedded data (agent-
  // generated charts whose rows aren't shipped on the spec).
  const filteredRows = useMemo<InsightRegenRow[]>(
    () =>
      applyChartFilters(
        (tile.chart.data ?? []) as Array<Record<string, string | number | null>>,
        filters ?? {},
      ) as InsightRegenRow[],
    [tile.chart.data, filters],
  );

  // MW3 · distinct category count for the active breakdown. When a categorical
  // bar chart has many categories the chart can only show a subset legibly, so
  // we surface a "View all N records" CTA into the full sortable table (which
  // also enables bottom-N via ascending sort). Trends ('line'/'area') excluded.
  const categoryCount = useMemo(() => {
    if (localSpec.type !== "bar" || !localSpec.x) return 0;
    const xCol = localSpec.x;
    const seen = new Set<string>();
    for (const r of filteredRows) {
      const v = r[xCol];
      if (v != null && v !== "") seen.add(String(v));
    }
    return seen.size;
  }, [filteredRows, localSpec.type, localSpec.x]);
  const showViewAllCta =
    canPivot && effectiveMode === "chart" && categoryCount > 12;
  // Surface the durable Top/Bottom-N control on the tile when a bar chart carries
  // more categories than fit comfortably (matches the fullscreen modal's >10 gate).
  const showLimitControl = showSortControl && categoryCount > 10;
  // Inject the live limit into the spec the CHART renders, so the bars narrow to
  // the selection. The pivot / "View all … as a sortable table" path keeps the
  // full `sortedSpec` so every record stays reachable.
  const renderedSpec = useMemo<ChartSpec>(
    () => ({ ...(sortedSpec as ChartSpec), limit: limit ?? undefined }),
    [sortedSpec, limit],
  );

  const regen = useInsightRegen({
    tileId: tile.id,
    filters: filters ?? {},
    cache: insightRegenCache,
  });

  // Bind a no-arg callback for the footer button — the dynamic context
  // (spec + filtered rows) flows in at click time, side-stepping the
  // over-fire-on-every-render trap the hook's design call-time entry
  // was meant to avoid.
  const handleRegenerate = useCallback(() => {
    void regen.regenerate(specLite, filteredRows);
  }, [regen, specLite, filteredRows]);

  // Always show a "Do" for managers: derive a deterministic, data-grounded next
  // step from the current spec + filtered rows. `ChartInsightBody` uses this
  // ONLY when the insight text itself carries no `DO:` lane — so tiles persisted
  // before the always-show-a-Do change still surface an action without a
  // regeneration (the consumption half of "fix both ends"). Memoised over the
  // same inputs the chart reads so it only re-derives on genuine data shifts.
  const doFallback = useMemo<string | undefined>(
    () => deriveTileDoLane(specLite, filteredRows) ?? undefined,
    [specLite, filteredRows],
  );

  // Wave WI6 · record a per-tile history slot whenever a fresh regen
  // entry lands. `regen.entry` identity changes either when the user
  // navigates to a new (tileId, filterHash) cache slot (cache.get
  // returns a different value) OR when a fresh regen replaces the slot.
  // Either way, the slot's regeneratedAt is the load-bearing signal —
  // it's a fresh ISO string per fetch, so deps on it skip pure re-
  // renders that return the same entry. The store's `record` owns
  // MRU + de-dup semantics, so we don't need a "last recorded hash"
  // ref here.
  //
  // `historyVersion` is bumped on every record so the `historyEntries`
  // memo below re-reads from the store after a fresh slot lands. The
  // store's internal Map mutates in place, so without a version bump
  // React wouldn't know to re-render the dropdown.
  const [historyVersion, setHistoryVersion] = useState(0);
  useEffect(() => {
    if (!insightHistoryStore) return;
    if (!regen.entry || !regen.entry.regeneratedAt) return;
    insightHistoryStore.record(tile.id, filters ?? {}, regen.entry);
    setHistoryVersion((v) => v + 1);
  }, [insightHistoryStore, tile.id, regen.entry, filters]);

  const historyEntries = useMemo<InsightHistoryEntry[]>(
    () => (insightHistoryStore ? insightHistoryStore.get(tile.id) : []),
    // `historyVersion` is the load-bearing dep — the store is a stable
    // reference (factory return value held in a parent `useMemo`) that mutates
    // its Map in place, so we re-read whenever a fresh record bumps the version.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [insightHistoryStore, tile.id, historyVersion],
  );

  const handleHistorySelect = useCallback(
    (entry: InsightHistoryEntry) => {
      // Restore the dashboard's filters to the recorded combo. The
      // tile's `useInsightRegen` hook then keys off the new filters,
      // `cache.get(newKey)` returns the cached entry instantly when
      // it's still within the 5-min TTL, and prose paints. When the
      // cache entry has expired, the existing manual-Re-explain path
      // is the user's next move — we deliberately don't auto-fire a
      // regen on history-select to keep the navigator cheap.
      onFiltersChange(entry.filters);
    },
    [onFiltersChange],
  );

  const titleNode = tile.title || `Chart ${tile.index + 1}`;

  // Wave Z2 · always-visible Expand affordance (works in view AND edit mode,
  // and on both the legacy and visx render paths since it owns its own modal).
  const expandAction = (
    <Button
      variant="ghost"
      size="icon"
      className="h-7 w-7 text-muted-foreground hover:text-foreground"
      aria-label="Expand chart"
      title="Expand chart"
      onClick={() => setIsExpandOpen(true)}
    >
      <Maximize2 className="h-4 w-4" />
    </Button>
  );

  const headerActions = (
    <div className="flex items-center gap-1">
      {/* W4 · shared mark-switch / layout / show-labels cluster — parity with
          the chat card. Mutates the tile's local spec copy; self-gates per
          mark (only bar/line/area show the type dropdown, etc.). */}
      <ChartParityToolbar
        type={localSpec.type}
        barLayout={localSpec.barLayout}
        dataLabels={localSpec.dataLabels}
        hasSeries={
          !!localSpec.seriesColumn || (localSpec.seriesKeys?.length ?? 0) > 1
        }
        onTypeChange={handleTypeChange}
        onBarLayoutChange={handleBarLayoutChange}
        onDataLabelsChange={handleDataLabelsChange}
      />
      {showSortControl ? (
        <ChartSortControl
          value={sort ?? localSpec.sort}
          onChange={handleSortChange}
          axisLabel={localSpec.xLabel || localSpec.x}
        />
      ) : null}
      {showLimitControl ? (
        <ChartLimitControl
          value={limit}
          onChange={handleLimitChange}
          total={categoryCount}
        />
      ) : null}
      {canPivot ? (
        <div className="inline-flex rounded-md border border-border overflow-hidden">
          <button
            type="button"
            onClick={() => {
              if (effectiveMode !== "chart") toggle();
            }}
            aria-pressed={effectiveMode === "chart"}
            title="View as chart"
            className={cn(
              "px-1.5 py-1 text-xs transition-colors",
              effectiveMode === "chart"
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/40",
            )}
          >
            <BarChart3 className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="sr-only">View as chart</span>
          </button>
          <button
            type="button"
            onClick={() => {
              if (effectiveMode !== "pivot") toggle();
            }}
            aria-pressed={effectiveMode === "pivot"}
            title="View all records as a sortable table (sort ascending for worst performers)"
            className={cn(
              "px-1.5 py-1 text-xs transition-colors border-l border-border",
              effectiveMode === "pivot"
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/40",
            )}
          >
            <Table2 className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="sr-only">View as pivot table</span>
          </button>
        </div>
      ) : null}
      {sessionId ? (
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground hover:text-foreground"
          aria-label="Investigate this chart further with a deeper analysis"
          title="Run a deeper analysis of this chart — drivers, why, and actions"
          data-testid="tile-investigate-button"
          onClick={handleInvestigate}
        >
          <Telescope className="h-4 w-4" />
        </Button>
      ) : null}
      {canEdit ? (
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground hover:text-destructive"
          aria-label="Remove chart from dashboard"
          onClick={onDeleteClick}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      ) : null}
    </div>
  );

  return (
    <Card
      className="relative flex h-full flex-col overflow-hidden border border-border/60 bg-card shadow-elev-1 transition-[transform,box-shadow] duration-base ease-standard hover:shadow-elev-2 hover:-translate-y-0.5 motion-reduce:transition-none motion-reduce:hover:translate-y-0 dashboard-tile-grab-area group"
      data-dashboard-tile="chart"
    >
      <TileHeader
        title={titleNode}
        badge={
          inapplicableColumns.length > 0 ? (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400"
              title={`Filters not in this chart's data: ${inapplicableColumns.join(", ")}`}
              data-testid="tile-inapplicable-badge"
            >
              Filter doesn't apply
            </span>
          ) : undefined
        }
        actions={headerActions}
        persistentActions={expandAction}
      />
      <CardContent className="flex min-h-0 flex-1 flex-col gap-3 pt-0 px-4 pb-4">
        {/* W1 · axisReason subtitle — parity with the chat card
            (InteractiveChartCard). Surfaces the period-resolver's decision
            ("Showing Quarter · Period, filtered to …") so a dashboard viewer
            knows which time grain was picked and why. Read-only; absent for
            non-period charts. */}
        {tile.chart.axisReason ? (
          <div
            className="text-[11px] leading-snug text-muted-foreground"
            data-testid="chart-axis-reason"
          >
            {tile.chart.axisReason}
          </div>
        ) : null}
        <div
          className={cn(
            "flex-1 min-h-[120px] min-w-0",
            // A1 · in view mode a click anywhere on the chart body opens the
            // fullscreen modal (the same one the Maximize button uses). Gated
            // off in edit mode so it never competes with grid drag, and off in
            // pivot mode so table-cell interactions keep working.
            !isEditing && effectiveMode !== "pivot" && "cursor-pointer",
          )}
          data-dashboard-chart-node
          onClick={canExpandOnBodyClick ? handleBodyExpandClick : undefined}
          onKeyDown={canExpandOnBodyClick ? handleBodyExpandKeyDown : undefined}
          role={canExpandOnBodyClick ? "button" : undefined}
          tabIndex={canExpandOnBodyClick ? 0 : undefined}
          aria-label={canExpandOnBodyClick ? "Expand chart to fullscreen" : undefined}
        >
          <DashboardTileProvider tileId={tile.id} filters={filters}>
          {effectiveMode === "pivot" ? (
            <ChartTilePivotView chart={sortedSpec} filters={filters} />
          ) : (
            <ErrorBoundary
              fallback={
                <div
                  role="alert"
                  className="h-full w-full flex flex-col items-center justify-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-6 text-center"
                >
                  <AlertTriangle className="h-5 w-5 text-destructive" />
                  <div className="text-sm font-medium text-foreground">
                    Couldn't load this chart
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Reload the page to retry.
                  </div>
                </div>
              }
            >
              <Suspense fallback={<Skeleton className="h-full w-full" />}>
                <ChartShim
                  spec={renderedSpec}
                  legacy={() => (
                    <ChartRenderer
                      chart={renderedSpec}
                      index={tile.index}
                      isSingleChart={false}
                      showAddButton={false}
                      useChartOnlyModal
                      fillParent
                      enableFilters
                      filters={filters}
                      onFiltersChange={onFiltersChange}
                      // A1 · the dashboard tile owns click-to-expand (the
                      // chart-body div) so v1 + v2 charts behave identically;
                      // disable ChartRenderer's own card-click modal to avoid
                      // double-opening on a single click.
                      expandOnClick={false}
                    />
                  )}
                />
              </Suspense>
            </ErrorBoundary>
          )}
          </DashboardTileProvider>
        </div>
        {/* W12 · provenance pill (rows / cols / tools) — parity with the chat
            card's SourcePillRow. Self-hides when the chart carries no
            _agentProvenance (e.g. manually-added tiles). */}
        <SourcePillRow chart={tile.chart} />
        {limit && categoryCount > limit.n ? (
          <div className="self-start text-xs text-muted-foreground">
            {limit.mode === "top" ? "Top" : "Bottom"} {limit.n} of {categoryCount}
          </div>
        ) : null}
        {showViewAllCta ? (
          <button
            type="button"
            onClick={toggle}
            className="self-start text-xs text-primary hover:underline"
            title="Open the full sortable table — sort ascending to see the worst performers"
          >
            View all {categoryCount} {tile.chart.x} as a sortable table →
          </button>
        ) : null}
        {/*
         * Wave Z3 · the footer always renders now. Auto-built dashboard charts
         * get their insight patched in asynchronously by the server (Workstream
         * I); until that lands (or if it never does), the footer shows a
         * "Generate insight" CTA wired to the existing regen path rather than
         * disappearing entirely.
         */}
        <TileInsightFooter
          insight={tile.chart.keyInsight ?? ""}
          emptyState={
            resolveInsightFooterMode(
              tile.chart.keyInsight,
              regen.entry?.text,
              regen.loading,
            ) === "empty"
          }
          dashboardId={dashboardId}
          tileId={tile.id}
          canEdit={canEdit}
          isEditing={isEditing}
          onEdit={onEditInsight}
          regen={{
            entry: regen.entry,
            loading: regen.loading,
            error: regen.error,
            onRegenerate: handleRegenerate,
          }}
          fallbackDo={doFallback}
          history={historyEntries}
          onHistorySelect={handleHistorySelect}
        />
      </CardContent>
      {isExpandOpen ? (
        <Suspense fallback={null}>
          <ChartOnlyModal
            isOpen={isExpandOpen}
            onClose={() => setIsExpandOpen(false)}
            keyInsightSessionId={sessionId ?? null}
            {...buildExpandModalProps(
              sortedSpec,
              filters,
              filteredRows as Record<string, unknown>[],
            )}
          />
        </Suspense>
      ) : null}
    </Card>
  );
}
