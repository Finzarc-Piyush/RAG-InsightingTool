import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, BarChart3, Table2, Trash2 } from "lucide-react";
import type { ChartSpec } from "@/shared/schema";
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
import {
  deriveTileRecommendations,
  type TileRecommendation,
} from "../lib/tileRecommendations";

// Lazy load to mirror DashboardTiles' Suspense pattern.
const ChartRenderer = lazy(() =>
  import("@/pages/Home/Components/ChartRenderer").then((m) => ({
    default: m.ChartRenderer,
  })),
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
  canEdit: boolean;
  isEditing: boolean;
  inapplicableColumns: string[];
  filters: ActiveChartFilters | undefined;
  onFiltersChange: (next: ActiveChartFilters) => void;
  onDeleteClick: () => void;
  onEditInsight: () => void;
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
  canEdit,
  isEditing,
  inapplicableColumns,
  filters,
  onFiltersChange,
  onDeleteClick,
  onEditInsight,
  insightRegenCache,
  insightHistoryStore,
}: ChartTileBodyProps) {
  const { mode, toggle } = useChartTileViewMode(dashboardId, tile.id);
  const canPivot = chartSpecToPivotConfig(tile.chart) !== null;
  // Force chart view when this chart can't be pivoted, even if a
  // stale `pivot` value is in sessionStorage from a prior chart shape.
  const effectiveMode = canPivot ? mode : "chart";

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

  // Wave WI5 · derive per-tile "Try this" recommendations from the
  // current spec + filtered rows + active filters. Pure-function output
  // memoised over the same inputs the chart itself reads, so chip
  // changes are pinned to genuine state shifts (no re-derive on parent
  // re-renders unrelated to data / filters).
  const recommendations = useMemo<TileRecommendation[]>(
    () => deriveTileRecommendations(specLite, filteredRows, filters ?? {}),
    [specLite, filteredRows, filters],
  );

  const handleRecommendationClick = useCallback(
    (rec: TileRecommendation) => {
      if (rec.kind === "filter-bottom" || rec.kind === "filter-top") {
        // Pin the single categorical value — clobber any prior
        // categorical filter on the same column (the rec only fires
        // when the value isn't already pinned per the helper's
        // `isValueAlreadyFiltered` guard).
        onFiltersChange({
          ...(filters ?? {}),
          [rec.column]: { type: "categorical", values: [rec.value] },
        });
      } else if (rec.kind === "clear-filters") {
        onFiltersChange({});
      }
    },
    [filters, onFiltersChange],
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
    // reference (factory return value held in a parent `useMemo`), so
    // we re-read whenever a fresh record bumps the version.
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

  const headerActions = (
    <div className="flex items-center gap-1">
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
            title="View as pivot table"
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
      />
      <CardContent className="flex min-h-0 flex-1 flex-col gap-3 pt-0 px-4 pb-4">
        <div className="flex-1 min-h-[120px] min-w-0" data-dashboard-chart-node>
          <DashboardTileProvider tileId={tile.id} filters={filters}>
          {effectiveMode === "pivot" ? (
            <ChartTilePivotView chart={tile.chart} filters={filters} />
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
                  spec={tile.chart}
                  legacy={() => (
                    <ChartRenderer
                      chart={tile.chart}
                      index={tile.index}
                      isSingleChart={false}
                      showAddButton={false}
                      useChartOnlyModal
                      fillParent
                      enableFilters
                      filters={filters}
                      onFiltersChange={onFiltersChange}
                    />
                  )}
                />
              </Suspense>
            </ErrorBoundary>
          )}
          </DashboardTileProvider>
        </div>
        {tile.chart.keyInsight ? (
          <TileInsightFooter
            insight={tile.chart.keyInsight}
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
            recommendations={recommendations}
            onRecommendationClick={handleRecommendationClick}
            history={historyEntries}
            onHistorySelect={handleHistorySelect}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}
